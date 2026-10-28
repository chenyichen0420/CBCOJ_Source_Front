const express = require('express');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const AdmZip = require('adm-zip');
const multer = require('multer');
const router = express.Router();
const pool = require('../db');
const { requirePermission, requireAdmin, requireSuperAdmin } = require('../auth');
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

const MAX_SUBTASKS = 100;
const MAX_CASES_PER_SUBTASK = 1000;
const MAX_TOTAL_CASES = 100000;
const MAX_CASE_NAME_LEN = 50;
const MAX_TIME_LIMIT_MS = 30000;
const MAX_MEMORY_LIMIT_MB = 2 * 1024;
const MAX_SCORE_PER_SUBTASK = 1000000;

function parsePositiveInt(token, label) {
	if (typeof token !== 'string' || !/^\d+$/.test(token)) {
		throw new UploadError(`.set 文件格式错误：${label} 不是合法整数 "${token}"`);
	}
	const v = Number(token);
	if (!Number.isSafeInteger(v) || v <= 0) {
		throw new UploadError(`.set 文件格式错误：${label} 必须为正整数`);
	}
	return v;
}

function parseNonNegativeInt(token, label) {
	if (typeof token !== 'string' || !/^\d+$/.test(token)) {
		throw new UploadError(`.set 文件格式错误：${label} 不是合法整数 "${token}"`);
	}
	const v = Number(token);
	if (!Number.isSafeInteger(v) || v < 0) {
		throw new UploadError(`.set 文件格式错误：${label} 必须为非负整数`);
	}
	return v;
}

function isValidCaseStem(name) {
	if (typeof name !== 'string' || !name) return false;
	if (name === '.' || name === '..') return false;
	if (/[\/\\\0]/.test(name)) return false;                 // 不允许路径分隔符
	if (/[\x00-\x1f\x7f]/.test(name)) return false;          // 不允许控制字符
	if (Buffer.byteLength(name, 'utf8') > MAX_CASE_NAME_LEN) return false;
	if (name.endsWith('.in') || name.endsWith('.out')) return false; // 避免 .in.in / .out.out
	return true;
}

function parseAndValidateSetFile(setData) {
	let text = Buffer.isBuffer(setData) ? setData.toString('utf8') : String(setData ?? '');
	if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 去 BOM
	const tokens = text.split(/\s+/).filter(t => t.length > 0);
	if (tokens.length === 0) throw new UploadError('.set 文件为空');

	let pos = 0;
	const next = () => {
		if (pos >= tokens.length) throw new UploadError('.set 文件意外结束');
		return tokens[pos++];
	};

	const ion = next();                        // 评测类型，非空即可
	if (!ion) throw new UploadError('.set 文件格式错误：ion 为空');

	const spj = next();
	if (spj !== 'fc') {
		throw new UploadError(`.set 文件 spj 字段必须为 "fc"（当前仅支持文本比较），实际为 "${spj}"`);
	}

	const scn = parsePositiveInt(next(), 'scn');
	if (scn > MAX_SUBTASKS) {
		throw new UploadError(`.set 文件子任务数量 ${scn} 超过上限 ${MAX_SUBTASKS}`);
	}

	const subtasks = [];
	// const seenNames = new Set();
	let totalCases = 0;

	for (let i = 1; i <= scn; i++) {
		const cnt = parsePositiveInt(next(), `子任务 ${i} 的测试点数量`);
		if (cnt > MAX_CASES_PER_SUBTASK) {
			throw new UploadError(`.set 文件子任务 ${i} 的测试点数量 ${cnt} 超过上限 ${MAX_CASES_PER_SUBTASK}`);
		}
		totalCases += cnt;
		if (totalCases > MAX_TOTAL_CASES) {
			throw new UploadError(`.set 文件总测试点数量超过上限 ${MAX_TOTAL_CASES}`);
		}

		const pts = parseNonNegativeInt(next(), `子任务 ${i} 的分值`);
		if (pts > MAX_SCORE_PER_SUBTASK) {
			throw new UploadError(`.set 文件子任务 ${i} 的分值 ${pts} 超过上限 ${MAX_SCORE_PER_SUBTASK}`);
		}

		const rel = parseNonNegativeInt(next(), `子任务 ${i} 的依赖数量`);
		if (rel >= i) {
			throw new UploadError(`.set 文件子任务 ${i} 的依赖数量 ${rel} 必须小于 ${i}`);
		}
		const deps = [];
		for (let k = 0; k < rel; k++) {
			const rep = parseNonNegativeInt(next(), `子任务 ${i} 的依赖项`);
			if (rep >= i) {
				throw new UploadError(`.set 文件子任务 ${i} 的依赖项 ${rep} 超出范围（必须 < ${i}）`);
			}
			deps.push(rep);
		}

		const cases = [];
		for (let j = 1; j <= cnt; j++) {
			const inf = next();
			if (!isValidCaseStem(inf)) {
				throw new UploadError(`.set 文件子任务 ${i} 的测试点 ${j} 名称非法: "${inf}"`);
			}
			// if (seenNames.has(inf)) {
			//     throw new UploadError(`.set 文件中测试点名称重复: "${inf}"`);
			// }
			// seenNames.add(inf);
			// 允许单个测试点进行多次测试，这是有用的

			const tl = parsePositiveInt(next(), `子任务 ${i} 测试点 ${inf} 的时间限制`);
			if (tl > MAX_TIME_LIMIT_MS) {
				throw new UploadError(`.set 文件子任务 ${i} 测试点 ${inf} 的时间限制 ${tl}ms 超过上限 ${MAX_TIME_LIMIT_MS}ms`);
			}
			const ml = parsePositiveInt(next(), `子任务 ${i} 测试点 ${inf} 的内存限制`);
			if (ml > MAX_MEMORY_LIMIT_MB) {
				throw new UploadError(`.set 文件子任务 ${i} 测试点 ${inf} 的内存限制 ${ml}MB 超过上限 ${MAX_MEMORY_LIMIT_MB}MB`);
			}

			cases.push({ name: inf, tl, ml });
		}

		subtasks.push({ cnt, pts, rel, deps, cases });
	}

	if (pos !== tokens.length) {
		throw new UploadError('.set 文件末尾存在多余内容');
	}

	return { ion, spj, scn, subtasks };
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
		if (!name || 
			(name.endsWith('.in') && name.length === 3) ||
			(name.endsWith('.out') && name.length === 4) ||
			(name.endsWith('.cpp') && name.length === 4)) continue;
		if (candidates.has(name)) throw new UploadError(`ZIP 中存在重复文件名: ${name}`);
		candidates.set(name, entry);
	}

	// 强制要求 .set 存在，并将其作为权威清单
	const setEntry = candidates.get('.set');
	if (!setEntry) throw new UploadError('ZIP 中缺少 .set 评测配置文件');

	let setData;
	try {
		setData = await readZipEntry(setEntry);
	} catch (err) {
		throw new UploadError(`无法解压 .set 文件: ${err.message}`);
	}
	const setInfo = parseAndValidateSetFile(setData);

	// 仅保留 .set 与 .cpp；.in/.out 只保留 .set 引用的 stem
	const selectedNames = [];
	for (const name of candidates.keys()) {
		if (name === '.set' || name.endsWith('.cpp')) selectedNames.push(name);
	}

	const referencedStems = new Set();
	for (const st of setInfo.subtasks) {
		for (const c of st.cases) referencedStems.add(c.name);
	}
	for (const stem of referencedStems) {
		const inName = `${stem}.in`;
		const outName = `${stem}.out`;
		if (!candidates.has(inName)) {
			throw new UploadError(`.set 引用的测试点 "${stem}" 缺少 ${inName}`);
		}
		if (!candidates.has(outName)) {
			throw new UploadError(`.set 引用的测试点 "${stem}" 缺少 ${outName}`);
		}
		selectedNames.push(inName, outName);
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
	const text = String(value ?? '');
	// Keep empty basic.txt fields as non-whitespace tokens for the middleware parser.
	return Buffer.from(text || '\0', 'utf8').toString('base64');
}

function decodeStoredText(value) {
	if (value === undefined || value === null || value === '') return '';
	const text = String(value);
	try {
		const decoded = Buffer.from(text, 'base64').toString('utf8');
		if (Buffer.from(decoded, 'utf8').toString('base64') === text) return decoded === '\0' ? '' : decoded;
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
	if (!Number.isInteger(returnedCount) || returnedCount < 0) {
		throw new Error('Invalid problem count');
	}
	const total = returnedCount;
	const problems = await Promise.all(parts.map(id => readProblem(id, ['id', 'title', 'timelimit', 'memorylimit', 'time', 'author', 'open'])));
	return { total, problems: problems.filter(Boolean) };
}

async function updateProblem(req, id) {
	const problem = await readProblem(id);
	if (!problem) return { error: '题目不存在', status: 404 };

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

async function createProblem(req, res) {
	const titleErr = validateString(req.body?.title, { minLen: 1, maxLen: 200 });
	if (titleErr) return res.status(400).json({ status: 'N', error: `title: ${titleErr}` });
	const descriptionErr = validateString(req.body?.description, { minLen: 1 });
	if (descriptionErr) return res.status(400).json({ status: 'N', error: `description: ${descriptionErr}` });

	const cookie = getCookie(req);
	const cookieErr = validateString(cookie, { minLen: 1, maxLen: 200 });
	if (cookieErr) return res.status(401).json({ status: 'N', error: '登录状态无效，请重新登录' });

	let id;
	try {
		const allocation = await pool.getJudge().send('N', pool.packParams([cookie]));
		if (allocation.command !== 'Y') {
			const parts = pool.parsePack(allocation.data);
			return res.status(400).json({
				status: 'N',
				error: parts[0]?.toString('utf8') || '题目编号申请失败'
			});
		}

		const parts = pool.parsePack(allocation.data);
		id = parts.length === 1 ? parts[0].toString('utf8') : '';
		const idErr = validateInt(id, { positive: true });
		if (idErr) throw new Error('题目编号申请接口返回无效编号');

		const result = await updateProblem({
			body: { ...(req.body || {}), opened: 0 },
			headers: req.headers,
			query: req.query
		}, id);
		if (!result.ok) {
			return res.status(result.status).json({
				status: 'N',
				error: `题目编号 ${id} 已申请，但保存失败：${result.error}`,
				id
			});
		}
		return res.json({ status: 'Y', id });
	} catch (err) {
		logger.logError(`Problem creation failed for user ${req.user?.id}: ${err.message}`, err);
		return res.status(502).json({
			status: 'N',
			error: id ? `题目编号 ${id} 已申请，但保存过程中发生错误` : '题目编号申请失败，请稍后重试',
			...(id ? { id } : {})
		});
	}
}

// 获取题目列表
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

// 直接获取完整题目列表（简单信息）
router.get('/problems/all', requirePermission('can_manage_problems'), async (req, res) => {
	try {
		const result = await listProblems(0, 0xFFFFFF);
		res.json({ status: 'Y', problems: result.problems.map(({ id, title }) => ({ id, title })) });
	} catch (err) {
		res.status(502).json({ status: 'N', error: '题目列表获取失败' });
	}
});

// 直接获取单个题目完整信息
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

// 编辑题目信息
router.post('/problem/edit/:id', requirePermission('can_manage_problems'), async (req, res) => {
	try {
		const result = await updateProblem(req, req.params.id);
		if (!result.ok) return res.status(result.status).json({ status: 'N', error: result.error });
		res.json({ status: 'Y' });
	} catch (err) {
		res.status(502).json({ status: 'N', error: '题目更新失败' });
	}
});

// 新建题目
router.post('/problem/new', requirePermission('can_manage_problems'), createProblem);

// 上传题目数据
router.post('/problem/:id/upload-data', requirePermission('can_manage_problems'), uploadProblemData);

// 暂不支持：当前 JudgeSession 没有删除、精选或检查器接口。
// 新建题目通过 JudgeSession 的编号申请和题目更新接口完成。
const unsupportedProblemRoutes = [
	['delete', '/problem/:id']
];
for (const [method, route] of unsupportedProblemRoutes) {
	router[method](route, requirePermission('can_manage_problems'), (req, res) => {
		res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
	});
}

// 直接获取单个文章的完整信息
router.get('/article/:id', requirePermission('can_manage_articles'), async (req, res) => {
	res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
});

// 编辑文章信息
router.post('/article/edit/:id', requirePermission('can_manage_articles'), async (req, res) => {
	res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
});

// 新建文章
router.post('/article/new', requirePermission('can_manage_articles'), async (req, res) => {
    res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
});

// PLACE_HOLDER FOR USER MANAGE

const userAdminPermissions = new Set([
	'ADMIN_USER', 'ADMIN_PROBLEM', 'ADMIN_CONTEST', 'ADMIN_CHAT', 'ADMIN_ARTICLE'
]);
const userLockPermissions = new Set([
	'LOCK_NO_SUBMIT', 'LOCK_NO_DISCUSSION', 'LOCK_NO_CHAT',
	'LOCK_NO_VIEW_RECORD', 'LOCK_NO_OPEN_RECORD'
]);
const userBanPermission = 'LOCK_USER_BANNED';

function parseUserId(value) {
	const id = Number(value);
	return Number.isInteger(id) && id >= 0 ? id : null;
}

async function accountRequest(command, params) {
	const response = await pool.getAccount().send(command, pool.packParams(params));
	if (response.command !== 'Y') {
		const parts = pool.parsePack(response.data);
		throw new Error(parts[0] ? parts[0].toString('utf8') : '账户服务请求失败');
	}
	return pool.parsePack(response.data);
}

async function getManagedUser(id) {
	const parts = await accountRequest('U', [
		'uid', String(id), 'uid', 'username', 'flag', 'role', 'badge', 'name_color'
	]);
	if (parts.length !== 6 || parts[2].length !== 6) throw new Error('账户服务返回数据无效');
	const flag = parts[2];
	const permissions = {};
	for (const name of userAdminPermissions) permissions[name] = !!(flag[0] & {
		ADMIN_USER: 0x02, ADMIN_PROBLEM: 0x04, ADMIN_CONTEST: 0x08,
		ADMIN_CHAT: 0x10, ADMIN_ARTICLE: 0x40
	}[name]);
	for (const name of userLockPermissions) permissions[name] = !!(flag[2] & {
		LOCK_NO_SUBMIT: 0x02, LOCK_NO_DISCUSSION: 0x04, LOCK_NO_CHAT: 0x08,
		LOCK_NO_VIEW_RECORD: 0x10, LOCK_NO_OPEN_RECORD: 0x20
	}[name]);
	permissions[userBanPermission] = !!(flag[2] & 0x01);
	return {
		id: Number(parts[0].toString('utf8')),
		username: parts[1].toString('utf8'),
		role: parts[3].toString('utf8'),
		badge: parts[4].toString('utf8'),
		name_color: parts[5].toString('utf8'),
		permissions
	};
}

async function getUserCount() {
	const parts = await accountRequest('S', []);
	if (parts.length !== 5) throw new Error('统计信息返回数据无效');
	const count = Number(parts[3].toString('utf8'));
	if (!Number.isSafeInteger(count) || count < 0) throw new Error('用户数量无效');
	return count;
}

router.get('/users', requirePermission('can_manage_users'), async (req, res) => {
	const page = Number(req.query.page || 1);
	const limit = 10;
	if (!Number.isInteger(page) || page < 1) return res.status(400).json({ status: 'N', error: '页码无效' });
	try {
		const total = await getUserCount();
		const start = (page - 1) * limit;
		const ids = start < total ? Array.from({ length: Math.min(limit, total - start) }, (_, i) => start + i) : [];
		const users = [];
		for (const id of ids) users.push(await getManagedUser(id));
		res.json({ status: 'Y', users, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
	} catch (err) {
		logger.logError(`Failed to list users: ${err.message}`, err);
		res.status(502).json({ status: 'N', error: '用户列表获取失败' });
	}
});

async function updateUserFlag(req, res, allowed, command) {
	const id = parseUserId(req.params.id);
	const { permission, value } = req.body || {};
	if (id === null || typeof permission !== 'string' || !allowed.has(permission) || ![0, 1, true, false].includes(value)) {
		return res.status(400).json({ status: 'N', error: '参数无效' });
	}
	try {
		await accountRequest(command, [getCookie(req), String(id), permission, value ? '1' : '0']);
		res.json({ status: 'Y' });
	} catch (err) {
		res.status(400).json({ status: 'N', error: err.message });
	}
}

// 获取单个用户完整信息
router.get('/user/:id', requirePermission('can_manage_users'), async (req, res) => {
	const id = parseUserId(req.params.id);
	if (id === null) return res.status(400).json({ status: 'N', error: '用户 ID 无效' });
	try { res.json({ status: 'Y', user: await getManagedUser(id) }); }
	catch (err) { res.status(404).json({ status: 'N', error: '用户不存在' }); }
});

// 调整用户荣誉 tag
router.post('/user/:id/badge', requireAdmin, async (req, res) => {
	const id = parseUserId(req.params.id);
	if (id === null || id !== req.user.id) return res.status(403).json({ status: 'N', error: '当前账户服务只支持管理员修改自己的 badge' });
	const badge = req.body && req.body.badge == null ? '' : String(req.body && req.body.badge || '');
	const nameColor = req.body && req.body.name_color == null ? '' : String(req.body && req.body.name_color || '');
	try {
		await accountRequest('C', [getCookie(req), 'badge', badge, 'name_color', nameColor]);
		res.json({ status: 'Y' });
	} catch (err) { res.status(400).json({ status: 'N', error: err.message }); }
});

// 调整用户一般权限
router.post('/user/:id/adjperm', requirePermission('can_manage_users'), async (req, res) => {
	return updateUserFlag(req, res, userLockPermissions, 'N');
});

// 调整用户管理员权限
router.post('/user/:id/adjadmin', requireSuperAdmin, async (req, res) => {
	return updateUserFlag(req, res, userAdminPermissions, 'A');
});

// 重置用户密码
router.post('/user/:id/reset-password', requireSuperAdmin, async (req, res) => {
    res.status(501).json({ status: 'N', error: '当前 middleware 协议暂不支持此管理功能' });
});

// 封禁用户
router.post('/user/:id/ban', requireSuperAdmin, async (req, res) => {
	return updateUserFlag(req, res, new Set([userBanPermission]), 'A');
});

const unsupportedAdminRoutes = [
	['/contests', 'get'],
	['/contests', 'post'],
	['/contests/:id', 'get'],
	['/contests/:id', 'put'],
	['/contests/:id', 'delete'],
	['/contests/:id/problems', 'get'],
	['/logs', 'get']
];
for (const [route, method] of unsupportedAdminRoutes) {
	router[method](route, (req, res) => {
		res.status(501).json({ status: 'N', error: '该管理功能尚未迁移' });
	});
}

module.exports = router;