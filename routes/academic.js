const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireLogin, requireAdmin, requirePermission, checkPermission } = require('../auth');
const multer = require('multer');
const { TextDecoder } = require('util');
const logger = require('../logger');
const upload = multer();
const { validateInt, validateString } = require('../validation');

router.get('/getproblem', requireLogin, async (req, res) => {
    const id = req.query.id;
    const idErr = validateString(id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
    /*
    DB Interface, waiting for implement

    Input: id (string)
    Output: { status: 'Y', id, title, background, description, inputfmt, outputfmt,
              hint, timelm, memlm, datacount, sample (JSON array), checker_path }

    Expected middleware behavior:
    - Query problem metadata by id
    - Return all problem fields
    - sample should be parsed as JSON array
    - Return 404 if problem not found
    */
});

router.post('/getproblemlist', requireLogin, express.json(), async (req, res) => {
    let page = 1;
    if (req.body.page !== undefined) {
        const err = validateInt(req.body.page, { positive: true, max: 2147483647 });
        if (err) return res.json({ status: 'N', error: `page: ${err}` });
        page = Number(req.body.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    /*
    DB Interface, waiting for implement

    Input: page (int, 1-based)
    Output: { status: 'Y', data: [{ id, title }, ...], page: totalPages }

    Expected middleware behavior:
    - Get paginated list of problems
    - Return only id and title fields
    - Return total page count
    */
});

router.post('/submit', requireLogin, upload.none(), requirePermission('can_submit_code'), async (req, res) => {
    const { id, code, language } = req.body;
    const idErr = validateString(id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.json({ status: 'N', error: `id: ${idErr}` });
    const codeErr = validateString(code, { minLen: 1 });
    if (codeErr) return res.json({ status: 'N', error: `code: ${codeErr}` });
    const langErr = validateString(language, { minLen: 1, maxLen: 20 });
    if (langErr) return res.json({ status: 'N', error: `language: ${langErr}` });

    const pidErr = validateInt(id, { positive: true, max: 2147483647 });
    if (pidErr) return res.json({ status: 'N', error: `id: ${pidErr}` });
    const supportedLanguages = new Set([
        'C++14', 'C++14-O2', 'C++17', 'C++17-O2', 'C++20', 'C++20-O2',
        'C++23', 'C++23-O2', 'C++23-O3', 'C++26', 'C++26-O2', 'C++26-O3'
    ]);
    if (!supportedLanguages.has(language)) {
        return res.json({ status: 'N', error: '不支持的语言' });
    }

    let sourceCode;
    try {
        const source = Buffer.from(code, 'base64');
        if (source.length === 0 || source.toString('base64') !== code) {
            return res.json({ status: 'N', error: '代码必须是有效的 Base64 内容' });
        }
        sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch (err) {
        return res.json({ status: 'N', error: '代码必须是有效的 UTF-8 内容' });
    }

    let cookie = req.body.cookie;
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    try {
        const response = await pool.getJudge().send('S', pool.packParams([
            cookie, String(Number(id)), language, sourceCode
        ]));
        const parts = pool.parsePack(response.data);
        if (response.command !== 'Y') {
            return res.json({ status: 'N', error: parts[0]?.toString('utf8') || '提交失败' });
        }
        const rid = parts[0]?.toString('utf8');
        if (!rid || !/^\d+$/.test(rid)) throw new Error('Invalid submission id from middleware');
        return res.json({ status: 'Y', rid });
    } catch (err) {
        logger.logError(`Code submission failed for user ${req.user.id}, problem ${id}: ${err.message}`, err);
        return res.status(502).json({ status: 'N', error: '提交服务暂时不可用' });
    }
});

router.get('/recordlist', requireLogin, async (req, res) => {
    const target = req.query.target;
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
        if (err) return res.json({ status: 'N', error: `page: ${err}` });
        page = Number(req.query.page);
    }
    let pid = -1;
    if (target && target !== 'all') {
        const targetErr = validateInt(target, { positive: true, max: 2147483647 });
        if (targetErr) return res.json({ status: 'N', error: `target: ${targetErr}` });
        pid = Number(target);
    }
    try {
        const cookie = getCookie(req);
        const response = await pool.getJudge().send('I', packParams([
            cookie, String(req.user.id), String(pid), String(page - 1), String(pool.RECORD_PAGE_SIZE)
        ]));
        const parts = parsePack(response.data).map(part => part.toString('utf8'));
        if (response.command !== 'Y') {
            return res.json({ status: 'N', error: parts[0] || '评测记录列表获取失败' });
        }
        if (parts.length === 0 || (parts.length - 1) % 10 !== 0) {
            throw new Error('Invalid record index response');
        }
        const total = Number(parts[0]);
        const totalErr = validateInt(total, { positive: false, min: 0 });
        if (totalErr) throw new Error('Invalid record count');
        const ids = [];
        for (let i = 1; i < parts.length; i += 10) ids.push(parts[i]);
        return res.json({
            status: 'Y',
            recordlist: JSON.stringify(ids),
            page: Math.ceil(total / pool.RECORD_PAGE_SIZE)
        });
    } catch (err) {
        logger.logError(`Record list API failed for user ${req.user.id}: ${err.message}`, err);
        return res.status(502).json({ status: 'N', error: '评测记录列表获取失败' });
    }
});

router.get('/record', requireLogin, async (req, res) => {
    const rid = req.query.rid;
    const ridErr = validateInt(rid, { positive: true, max: 2147483647 });
    if (ridErr) return res.json({ status: 'N', error: `rid: ${ridErr}` });
    try {
        const cookie = getCookie(req);
        const [recordResponse, summaryResponse] = await Promise.all([
            pool.getJudge().send('Q', packParams([cookie, rid])),
            pool.getJudge().send('V', packParams([cookie, rid]))
        ]);
        const recordParts = parsePack(recordResponse.data);
        if (recordResponse.command !== 'Y') {
            return res.json({ status: 'N', error: recordParts[0]?.toString('utf8') || '评测记录不可用' });
        }
        if (summaryResponse.command !== 'Y') {
            return res.json({ status: 'N', error: '评测记录不存在或无权查看' });
        }
        const summary = parsePack(summaryResponse.data);
        if (summary.length !== 8 || recordParts.length < 1) {
            throw new Error('Invalid record response');
        }
        const data = pool.parseJudgeResult(recordParts[0].toString('utf8'));
        const uid = Number(summary[0].toString('utf8'));
        if (!data.total) {
            return res.json({
                status: 'P',
                data: { code: 202, describe: data.des || 'Judging' },
                uid
            });
        }
        const detail = Array.isArray(data.detail) ? data.detail.map((subtask, index) => {
            const total = subtask.total || {};
            return {
                test_point_index: index + 1,
                code: Number(total.c) || 0,
                describe: total.des || '',
                time: Number(total.t) || 0,
                memory: Number(total.m) || 0,
                score: Number(total.pts) || 0,
                detail: total.des || ''
            };
        }) : [];
        const result = {
            overview: {
                code: Number(data.total.c) || 0,
                describe: data.total.des || '',
                time: Number(data.total.t) || 0,
                memory: Number(data.total.m) || 0,
                score: Number(data.total.pts) || 0
            },
            detail,
            uid
        };
        const responseBody = { status: 'Y', result };
        if (recordParts.length > 1) {
            responseBody.code = Buffer.from(recordParts[1]).toString('base64');
        }
        return res.json(responseBody);
    } catch (err) {
        logger.logError(`Record API failed for ${rid}, user ${req.user.id}: ${err.message}`, err);
        return res.status(502).json({ status: 'N', error: '评测记录获取失败' });
    }
});

function getCookie(req) {
    let cookie = req.body?.cookie || req.query?.cookie;
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    return cookie;
}

// 用户新建题目（默认不公开 opened=0，selected=0），入口在题目列表
router.post('/problem/new', requirePermission('can_manage_problems'), upload.none(), async (req, res) => {
    const user = req.user;
    const { title, background, description, inputfmt, outputfmt, hint, timelm, memlm, datacount, sample, selected } = req.body;
    const titleErr = validateString(title, { minLen: 1, maxLen: 200 });
    if (titleErr) return res.json({ status: 'N', error: `title: ${titleErr}` });
    const descErr = validateString(description, { minLen: 1 });
    if (descErr) return res.json({ status: 'N', error: `description: ${descErr}` });
    /*
    DB Interface, waiting for implement

    Input: title (string), background (string), description (string), inputfmt (string),
            outputfmt (string), hint (string), timelm (int), memlm (int),
            datacount (int), sample (JSON array), selected (int 0/1), user (from auth)
    Output: { status: 'Y', id: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Auto-generate next available numeric id
    - Create new problem with provided fields
    - Set author to current user's username
    - Set opened=0 (not public by default)
    - Set selected=0 (not featured by default)
    - Return the assigned id
    */
});

// 作者或管理员编辑题目
router.post('/problem/edit', requirePermission('can_manage_problems'), upload.none(), async (req, res) => {
    const user = req.user;
    const { id, title, background, description, inputfmt, outputfmt, hint, timelm, memlm, datacount, sample, opened, selected } = req.body;
    const idErr = validateInt(id, { positive: true });
    if (idErr) return res.json({ status: 'N', error: `id: ${idErr}` });
    /*
    DB Interface, waiting for implement

    Input: id (int, required), title (string, optional),
            background (string, optional), description (string, optional),
            inputfmt (string, optional), outputfmt (string, optional),
            hint (string, optional), timelm (int, optional), memlm (int, optional),
            datacount (int, optional), sample (JSON array, optional),
            opened (int 0/1, optional), selected (int 0/1, optional, admin only),
            user (from auth)
    Output: { status: 'Y' } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify user has permission (author or admin)
    - Update only the provided fields
    - Return success or error
    */
});

module.exports = router;

/*
## 标注汇总

以下是在 `academic.js` 中标注的数据库通信接口及需要移除的函数：

| 项目 | 类型 | 标注位置 | 说明 |
|------|------|---------|------|
| `/getproblem` | 路由 | 替换 `pool.query` | 获取单个题目详情 |
| `/getproblemlist` | 路由 | 替换 `pool.query` | 分页获取题目列表 |
| `/submit` | 路由 | 已实现 | 解码 C++ 源码并通过 Judge `S` 提交 |
| `/recordlist` | 路由 | 已实现 | 通过 Judge `I` 查询当前用户的 uid/pid 索引 |
| `/record` | 路由 | 已实现 | 通过 Judge `Q`/`V` 获取权限控制后的评测详情 |
| `saveCodeFile` | 函数 | 已经移除 | 代码存储由中间件接管 |
| `compileCode` | 函数 | 已经移除 | 编译由中间件的 Judger 接管 |
| `pool.query` 插入 `submissions` | SQL | 包含在 `/submit` 标注中 | 提交记录由中间件接管 |
| `pool.query` 插入 `tasks` | SQL | 包含在 `/submit` 标注中 | 评测队列由中间件 `submng` 接管 |
| `pool.query` 插入 `results` | SQL | 不再需要 | 结果由中间件 `recmng` 接管 |
| `fs` 代码文件读写 | 文件操作 | 不再需要 | 代码存储由中间件接管 |
*/