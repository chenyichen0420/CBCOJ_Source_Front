const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../auth');
const { validateInt, validateString } = require('../validation');

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
    let cookie = req.body && req.body.cookie;
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    return cookie;
}

async function readProblem(pid, fields = ['id', 'pid', 'title', 'timelimit', 'memorylimit', 'time', 'author', 'statement', 'open']) {
    const response = await pool.getJudge().send('P', pool.packParams([String(pid), ...fields]));
    if (response.command !== 'Y') return null;
    const parts = pool.parsePack(response.data);
    if (parts.length !== fields.length) throw new Error('Invalid problem response');
    const values = Object.fromEntries(fields.map((field, index) => {
        const value = parts[index].toString('utf8');
        return [field, ['id', 'pid', 'open', 'statement'].includes(field) ? value : decodeStoredText(value)];
    }));
    const statement = decodeStatement(values.statement);
    const problem = {
        id: Number(values.id),
        pid: values.pid || String(pid),
        title: values.title || '',
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
    const response = await pool.getJudge().send('L', pool.packParams(['0', '16777215', '1']));
    if (response.command !== 'Y') throw new Error('Problem list request failed');
    const parts = pool.parsePack(response.data).map(part => part.toString('utf8'));
    const returnedCount = Number(parts.shift());
    if (!Number.isInteger(returnedCount) || returnedCount < 0 || returnedCount !== parts.length) {
        throw new Error('Invalid problem count');
    }
    const total = parts.length;
    const pageIds = parts.slice(offset, offset + limit);
    const problems = await Promise.all(pageIds.map(id => readProblem(id, ['id', 'pid', 'title', 'timelimit', 'memorylimit', 'time', 'author', 'open'])));
    return { total, problems: problems.filter(Boolean) };
}

async function updateProblem(req, pid) {
    const problem = await readProblem(pid);
    if (!problem) return { error: '题目不存在', status: 404 };

    const body = req.body || {};
    const statement = { ...problem._statement };
    for (const field of ['background', 'description', 'inputfmt', 'outputfmt', 'hint']) {
        if (body[field] !== undefined) statement[field] = String(body[field]);
    }
    if (body.sample !== undefined) {
        if (!Array.isArray(body.sample)) return { error: 'sample 必须是数组', status: 400 };
        statement.sample = body.sample;
    }

    const pairs = [];
    if (body.title !== undefined) pairs.push('title', encodeStoredText(body.title));
    if (body.difficulty !== undefined) pairs.push('difficulty', encodeStoredText(body.difficulty));
    if (body.timelm !== undefined) pairs.push('timelimit', encodeStoredText(body.timelm));
    if (body.memlm !== undefined) pairs.push('memorylimit', encodeStoredText(body.memlm));
    if (body.time !== undefined) pairs.push('time', encodeStoredText(body.time));
    if (body.author !== undefined) pairs.push('author', encodeStoredText(body.author));
    if (Object.keys(statement).length > 0) pairs.push('statement', encodeStatement(statement));
    if (body.opened !== undefined) pairs.push('open', body.opened ? 'open' : 'closed');
    if (pairs.length === 0) return { error: '没有可更新的字段', status: 400 };

    const response = await pool.getJudge().send('U', pool.packParams([getCookie(req), String(pid), ...pairs]));
    if (response.command !== 'Y') {
        const parts = pool.parsePack(response.data);
        return { error: parts[0]?.toString('utf8') || '题目更新失败', status: 400 };
    }
    return { ok: true };
}

router.get('/admin/problems', requirePermission('can_manage_problems'), async (req, res) => {
    let page = Number(req.query.page || 1);
    let limit = Number(req.query.limit || 20);
    const pageErr = validateInt(page, { positive: true });
    const limitErr = validateInt(limit, { positive: true, min: 1 });
    if (pageErr) return res.status(400).json({ status: 'N', error: `page: ${pageErr}` });
    if (limitErr) return res.status(400).json({ status: 'N', error: `limit: ${limitErr}` });
    try {
        const result = await listProblems((page - 1) * limit, limit);
        res.json({ status: 'Y', ...result, page, totalPages: Math.ceil(result.total / limit) });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目列表获取失败' });
    }
});

router.get('/admin/problems/all', requirePermission('can_manage_problems'), async (req, res) => {
    try {
        const result = await listProblems(0, 0xFFFFFF);
        res.json({ status: 'Y', problems: result.problems.map(({ id, pid, title }) => ({ id, pid, title })) });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目列表获取失败' });
    }
});

router.get('/admin/problem/:id', requirePermission('can_manage_problems'), async (req, res) => {
    const idErr = validateString(req.params.id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
    try {
        const problem = await readProblem(req.params.id);
        if (!problem) return res.status(404).json({ status: 'N', error: '题目不存在' });
        delete problem._statement;
        res.json({ status: 'Y', ...problem, edit_url: `/problem/edit/${problem.pid}` });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目信息获取失败' });
    }
});

router.put('/admin/problem/:id', requirePermission('can_manage_problems'), async (req, res) => {
    try {
        const result = await updateProblem(req, req.params.id);
        if (!result.ok) return res.status(result.status).json({ status: 'N', error: result.error });
        res.json({ status: 'Y' });
    } catch (err) {
        res.status(502).json({ status: 'N', error: '题目更新失败' });
    }
});

// 暂不支持：当前 JudgeSession 没有新建、删除、精选、数据包或检查器接口。
// 迁移目标：为这些操作增加 middleware 协议后，再分别实现以下 admin.js 原始接口。
const unsupportedProblemRoutes = [
    ['post', '/admin/problem'],
    ['delete', '/admin/problem/:id'],
    ['post', '/admin/problem/:id/upload-data'],
    ['post', '/admin/problem/:id/upload-checker'],
    ['put', '/admin/problem/:id/select']
];

for (const [method, route] of unsupportedProblemRoutes) {
    router[method](route, requirePermission('can_manage_problems'), (req, res) => {
        res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
    });
}

// 暂不支持：用户管理、比赛管理、审计日志和 IP 封禁仍依赖原 MySQL 表或未迁移的接口。
// 迁移目标：补齐对应 middleware API 后，迁移 lzjver/routes/admin.js 的以下接口。
const unsupportedAdminRoutes = [
    ['/admin/users', 'get'],
    ['/admin/user/permissions', 'post'],
    ['/admin/user/:id/reset-password', 'post'],
    ['/admin/user/:id/role', 'put'],
    ['/admin/user/:id/badge', 'put'],
    ['/admin/contests', 'get'],
    ['/admin/contests', 'post'],
    ['/admin/contests/:id', 'get'],
    ['/admin/contests/:id', 'put'],
    ['/admin/contests/:id', 'delete'],
    ['/admin/contests/:id/problems', 'get'],
    ['/admin/logs', 'get'],
    ['/admin/ban-ip', 'post'],
    ['/admin/banned-ips', 'get'],
    ['/admin/ban-ip/:ip', 'delete'],
    ['/admin/clear-ip-logs', 'post']
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