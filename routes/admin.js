const express = require('express');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const AdmZip = require('adm-zip');
const multer = require('multer');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../auth');
const config = require('../config');
const logger = require('../logger');
const { validateInt, validateString } = require('../validation');

const uploadConfig = config.upload;
if (!uploadConfig || typeof uploadConfig.tempDir !== 'string' || !uploadConfig.tempDir.trim()) {
    throw new Error('Invalid upload.tempDir configuration');
}
const uploadTempDir = path.resolve(uploadConfig.tempDir);
const maxZipSizeBytes = uploadConfig.maxZipSizeBytes;
const maxExpandedSizeBytes = uploadConfig.maxExpandedSizeBytes;
const maxEntrySizeBytes = uploadConfig.maxEntrySizeBytes;
const maxEntryCount = uploadConfig.maxEntryCount;

for (const [name, value] of Object.entries({
    maxZipSizeBytes,
    maxExpandedSizeBytes,
    maxEntrySizeBytes,
    maxEntryCount
})) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid upload.${name} configuration`);
    }
}

class UploadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UploadError';
        this.statusCode = 400;
    }
}

const uploadZip = multer({
    storage: multer.diskStorage({
        destination: async (req, file, callback) => {
            try {
                await fsp.mkdir(uploadTempDir, { recursive: true });
                callback(null, uploadTempDir);
            } catch (err) {
                callback(err);
            }
        },
        filename: (req, file, callback) => callback(null, `${randomUUID()}.zip`)
    }),
    limits: {
        fileSize: maxZipSizeBytes,
        files: 1,
        fields: 0
    },
    fileFilter: (req, file, callback) => {
        if (/\.zip$/i.test(file.originalname)) return callback(null, true);
        callback(new UploadError('只允许上传 ZIP 文件'));
    }
});

function getUploadCookie(req) {
    let cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) {
            try {
                cookie = decodeURIComponent(match[1]);
            } catch (err) {
                throw new UploadError('登录凭据格式无效');
            }
        }
    }
    if (typeof cookie !== 'string' || !cookie) throw new UploadError('登录凭据缺失');
    return cookie;
}

function getCandidateName(entryName) {
    const normalized = entryName.replace(/\\/g, '/');
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    const isCandidate = name === '.set' || name.endsWith('.cpp') || name.endsWith('.in') || name.endsWith('.out');
    if (!isCandidate) return null;
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
        throw new UploadError('ZIP 中包含无效的数据文件名');
    }
    return name;
}

function readZipEntry(entry) {
    return new Promise((resolve, reject) => {
        try {
            entry.getDataAsync((data, err) => {
                if (err) return reject(err);
                resolve(data);
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function extractWhitelistedFiles(zipPath) {
    let zip;
    try {
        zip = new AdmZip(zipPath);
    } catch (err) {
        throw new UploadError('ZIP 文件无效或已损坏');
    }

    let entries;
    try {
        entries = zip.getEntries();
    } catch (err) {
        throw new UploadError('ZIP 文件目录无效或已损坏');
    }
    if (entries.length > maxEntryCount) throw new UploadError('ZIP 文件包含过多条目');

    const candidates = new Map();
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const name = getCandidateName(entry.entryName);
        if (!name || (name.endsWith('.in') && name.length === 3) ||
            (name.endsWith('.out') && name.length === 4) ||
            (name.endsWith('.cpp') && name.length === 4)) continue;
        if (candidates.has(name)) throw new UploadError(`ZIP 中存在重复文件名: ${name}`);
        candidates.set(name, entry);
    }

    const inputStems = new Set();
    const outputStems = new Set();
    for (const name of candidates.keys()) {
        if (name.endsWith('.in')) inputStems.add(name.slice(0, -3));
        if (name.endsWith('.out')) outputStems.add(name.slice(0, -4));
    }

    const selectedNames = [];
    for (const name of candidates.keys()) {
        if (name === '.set' || name.endsWith('.cpp')) {
            selectedNames.push(name);
        } else if (name.endsWith('.in') && outputStems.has(name.slice(0, -3))) {
            selectedNames.push(name);
        } else if (name.endsWith('.out') && inputStems.has(name.slice(0, -4))) {
            selectedNames.push(name);
        }
    }
    if (selectedNames.length === 0) {
        throw new UploadError('ZIP 中没有可上传的配对 .in/.out、.set 或 .cpp 文件');
    }

    let expandedSize = 0;
    for (const name of selectedNames) {
        const size = candidates.get(name).header.size;
        if (!Number.isSafeInteger(size) || size < 0 || size > maxEntrySizeBytes) {
            throw new UploadError(`文件 ${name} 超过单文件解压限制`);
        }
        if (size > maxExpandedSizeBytes - expandedSize) {
            throw new UploadError('ZIP 解压后总大小超过限制');
        }
        expandedSize += size;
    }

    const files = [];
    for (const name of selectedNames.sort((a, b) => a.localeCompare(b))) {
        let data;
        try {
            data = await readZipEntry(candidates.get(name));
        } catch (err) {
            throw new UploadError(`无法解压文件 ${name}: ${err.message}`);
        }
        if (data.length !== candidates.get(name).header.size) {
            throw new UploadError(`文件 ${name} 的解压大小与 ZIP 元数据不一致`);
        }
        files.push({ name, data });
    }
    return files;
}

function receiveZipUpload(req, res) {
    return new Promise((resolve, reject) => {
        uploadZip.single('file')(req, res, err => err ? reject(err) : resolve());
    });
}

async function uploadProblemData(req, res) {
    const idErr = validateInt(req.params.id, { positive: true });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });

    let responseSent = false;
    try {
        const cookie = getUploadCookie(req);
        await receiveZipUpload(req, res);
        if (!req.file) throw new UploadError('未选择文件');

        const files = await extractWhitelistedFiles(req.file.path);
        await pool.uploadProblemData({
            id: req.params.id,
            files,
            cookie
        });
        responseSent = true;
        return res.json({
            status: 'Y',
            message: 'Upload finished',
            data_path: `problem/${req.params.id}`,
            file_count: files.length
        });
    } catch (err) {
        const isClientError = err instanceof UploadError || err instanceof multer.MulterError;
        const status = isClientError ? 400 : 502;
        if (!isClientError) await logger.logError(`Problem data upload failed: ${err.message}`, err);
        if (res.headersSent) return;
        responseSent = true;
        return res.status(status).json({
            status: 'N',
            error: isClientError && err.code === 'LIMIT_FILE_SIZE'
                ? `ZIP 文件不能超过 ${Math.floor(maxZipSizeBytes / (1024 * 1024))} MB`
                : err.message || '题目数据上传失败'
        });
    } finally {
        if (req.file && req.file.path) {
            try {
                await fsp.unlink(req.file.path);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    await logger.logError(`Failed to remove upload temporary file: ${err.message}`, err);
                    if (!responseSent && !res.headersSent) {
                        res.status(500).json({ status: 'N', error: '临时文件清理失败' });
                    }
                }
            }
        }
    }
}

function encodeStoredText(value) {
    return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeStoredText(value) {
    if (value === undefined || value === null || value === '') return '';
    const text = String(value);
    try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('base64') === text) return decoded;
    } catch (_) {
        // 兼容旧版本 basic.txt 中的明文值
    }
    return text;
}

function decodeStatement(raw) {
    let statement;
    try {
        statement = JSON.parse(raw || '{}');
    } catch (_) {
        return { description: raw || '' };
    }
    if (!statement || Array.isArray(statement)) return {};
    return Object.fromEntries(Object.entries(statement).map(([key, value]) => {
        const decoded = decodeStoredText(value);
        if (key === 'sample') {
            try { return [key, JSON.parse(decoded)]; } catch (_) { return [key, []]; }
        }
        return [key, decoded];
    }));
}

function encodeStatement(statement) {
    return JSON.stringify(Object.fromEntries(Object.entries(statement || {}).map(([key, value]) => {
        const text = key === 'sample' ? JSON.stringify(Array.isArray(value) ? value : []) : String(value ?? '');
        return [key, encodeStoredText(text)];
    })));
}

function getCookie(req) {
    let cookie = (req.body && req.body.cookie) || (req.query && req.query.cookie);
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    return cookie;
}

async function readProblem(id, fields = ['id', 'title', 'difficulty', 'timelimit', 'memorylimit', 'time', 'author', 'statement', 'open']) {
    const response = await pool.getJudge().send('P', pool.packParams([String(id), ...fields]));
    if (response.command !== 'Y') return null;
    const parts = pool.parsePack(response.data);
    if (parts.length !== fields.length) throw new Error('Invalid problem response');
    const values = Object.fromEntries(fields.map((field, index) => {
        const value = parts[index].toString('utf8');
        return [field, ['id', 'open', 'statement'].includes(field) ? value : decodeStoredText(value)];
    }));
    const statement = decodeStatement(values.statement);
    const problem = {
        id: Number(values.id) || Number(id),
        title: values.title || '',
        difficulty: values.difficulty || '',
        timelm: Number(values.timelimit) || 0,
        memlm: Number(values.memorylimit) || 0,
        time: values.time || '',
        author: values.author || '',
        opened: values.open === '1' || values.open === 'open',
        ...statement
    };
    if (!Array.isArray(problem.sample)) problem.sample = [];
    problem._statement = statement;
    return problem;
}

async function listProblems(offset, limit) {
    const response = await pool.getJudge().send('L', pool.packParams([String(offset), String(limit), '1']));
    if (response.command !== 'Y') throw new Error('Problem list request failed');
    const parts = pool.parsePack(response.data).map(part => part.toString('utf8'));
    const returnedCount = Number(parts.shift());
    if (!Number.isInteger(returnedCount) || returnedCount < 0 || returnedCount !== parts.length) {
        throw new Error('Invalid problem count');
    }
    const total = parts.length;
    const problems = await Promise.all(parts.map(id => readProblem(id, ['id', 'title', 'timelimit', 'memorylimit', 'time', 'author', 'open'])));
    return { total, problems: problems.filter(Boolean) };
}

async function updateProblem(req, id) {
    const problem = await readProblem(id);
    // if (!problem) return { error: '题目不存在', status: 404 };

    const body = req.body || {};
    const statement = { ...problem._statement };
    for (const field of ['background', 'description', 'inputfmt', 'outputfmt', 'hint']) {
        if (body[field] !== undefined) statement[field] = String(body[field]);
    }
    if (body.sample !== undefined) {
        let parsedSample = body.sample;
        if (typeof parsedSample === 'string') {
            try {
                parsedSample = JSON.parse(parsedSample);
            } catch (err) {
                return { error: 'sample 必须是有效的 JSON 数组', status: 400 };
            }
        }
        if (!Array.isArray(parsedSample)) return { error: 'sample 必须是数组', status: 400 };
        statement.sample = parsedSample;
    }

    const pairs = [];
    if (body.title !== undefined) pairs.push('title', encodeStoredText(body.title));
    if (body.difficulty !== undefined) pairs.push('difficulty', encodeStoredText(body.difficulty));
    const timeLimit = body.timelimit;
    const memoryLimit = body.memorylimit;
    if (timeLimit !== undefined) {
        if (!Number.isSafeInteger(Number(timeLimit)) || Number(timeLimit) <= 0) {
            return { error: 'timelimit 必须是正整数', status: 400 };
        }
        pairs.push('timelimit', encodeStoredText(timeLimit));
    }
    if (memoryLimit !== undefined) {
        if (!Number.isSafeInteger(Number(memoryLimit)) || Number(memoryLimit) <= 0) {
            return { error: 'memorylimit 必须是正整数', status: 400 };
        }
        pairs.push('memorylimit', encodeStoredText(memoryLimit));
    }
    if (Object.keys(statement).length > 0) pairs.push('statement', encodeStatement(statement));
    if (body.opened !== undefined) {
        if (![true, false, 1, 0, '1', '0', 'open', 'closed'].includes(body.opened)) {
            return { error: 'opened 必须是布尔值或 0/1', status: 400 };
        }
        const isOpen = body.opened === true || body.opened === 1 || body.opened === '1' || body.opened === 'open';
        pairs.push('open', isOpen ? 'open' : 'closed');
    }
    if (pairs.length === 0) return { error: '没有可更新的字段', status: 400 };

    const response = await pool.getJudge().send('U', pool.packParams([getCookie(req), String(id), ...pairs]));
    if (response.command !== 'Y') {
        const parts = pool.parsePack(response.data);
        return { error: parts[0]?.toString('utf8') || '题目更新失败', status: 400 };
    }
    return { ok: true };
}

router.get('/problems', requirePermission('can_manage_problems'), async (req, res) => {
    let page = Number(req.query.page || 1);
    let limit = Number(req.query.limit || 20);
    const pageErr = validateInt(page, { positive: true });
    const limitErr = validateInt(limit, { positive: true, min: 1 });
    if (pageErr) return res.status(400).json({ status: 'N', error: `page: ${pageErr}` });
    if (limitErr) return res.status(400).json({ status: 'N', error: `limit: ${limitErr}` });
    try {
        const result = await listProblems((page - 1) * limit + 1, limit);
        res.json({ status: 'Y', ...result, page, totalPages: Math.ceil(result.total / limit) });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目列表获取失败' });
    }
});

router.get('/problems/all', requirePermission('can_manage_problems'), async (req, res) => {
    try {
        const result = await listProblems(0, 0xFFFFFF);
        res.json({ status: 'Y', problems: result.problems.map(({ id, title }) => ({ id, title })) });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目列表获取失败' });
    }
});

router.get('/problem/:id', requirePermission('can_manage_problems'), async (req, res) => {
    const idErr = validateString(req.params.id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
    try {
        const problem = await readProblem(req.params.id);
        if (!problem) return res.status(404).json({ status: 'N', error: '题目不存在' });
        delete problem._statement;
        res.json({ status: 'Y', ...problem, edit_url: `/problem/edit/${problem.id}` });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目信息获取失败' });
    }
});

router.put('/problem/edit/:id', requirePermission('can_manage_problems'), async (req, res) => {
    try {
        const result = await updateProblem(req, req.params.id);
        if (!result.ok) return res.status(result.status).json({ status: 'N', error: result.error });
        res.json({ status: 'Y' });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目更新失败' });
    }
});

router.post('/problem/:id/upload-data', requirePermission('can_manage_problems'), uploadProblemData);

// 暂不支持：当前 JudgeSession 没有新建、删除、精选或检查器接口。
// 迁移目标：为这些操作增加 middleware 协议后，再分别实现以下 admin.js 原始接口。
const unsupportedProblemRoutes = [
    ['post', '/problem'],
    ['delete', '/problem/:id'],
    ['post', '/problem/:id/upload-checker'],
    ['put', '/problem/:id/select']
];

for (const [method, route] of unsupportedProblemRoutes) {
    router[method](route, requirePermission('can_manage_problems'), (req, res) => {
        res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
    });
}

// 暂不支持：用户管理、比赛管理、审计日志和 IP 封禁仍依赖原 MySQL 表或未迁移的接口。
// 迁移目标：补齐对应 middleware API 后，迁移 lzjver/routes/admin.js 的以下接口。
const unsupportedAdminRoutes = [
    ['/users', 'get'],
    ['/user/permissions', 'post'],
    ['/user/:id/reset-password', 'post'],
    ['/user/:id/role', 'put'],
    ['/user/:id/badge', 'put'],
    ['/contests', 'get'],
    ['/contests', 'post'],
    ['/contests/:id', 'get'],
    ['/contests/:id', 'put'],
    ['/contests/:id', 'delete'],
    ['/contests/:id/problems', 'get'],
    ['/logs', 'get'],
    ['/ban-ip', 'post'],
    ['/banned-ips', 'get'],
    ['/ban-ip/:ip', 'delete'],
    ['/clear-ip-logs', 'post']
];

for (const [route, method] of unsupportedAdminRoutes) {
    router[method](route, (req, res) => {
        res.status(501).json({ status: 'N', error: '该管理功能尚未迁移：需要 middleware 对应接口' });
    });
}

/*
 * 需要后续修改的函数/接口：
 * - 用户权限、密码、角色和徽章管理：需要 Account 管理协议。
 * - 题目新建、删除、精选、数据包和检查器上传：需要 Judge/Update 协议。
 * - 比赛及比赛题目管理：需要 Contest 协议。
 * - 管理日志、IP 封禁和日志清理：需要安全审计协议。
 */

module.exports = router;

//注意：暂时没有进行任何 code review！