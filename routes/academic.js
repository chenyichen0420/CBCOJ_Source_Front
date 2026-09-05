const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireLogin, requireAdmin, requirePermission, checkPermission } = require('../auth');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const multer = require('multer');
const upload = multer();

const { SUBMIT_ROOT, COMPILE_ROOT } = require('../config');
const { validateInt, validateString } = require('../validation');

router.get('/getproblem', requireAdmin, async (req, res) => {
    const pid = req.query.pid;
    const pidErr = validateString(pid, { minLen: 1, maxLen: 50 });
    if (pidErr) return res.status(400).json({ status: 'N', error: `pid: ${pidErr}` });
    /*
    DB Interface, waiting for implement

    Input: pid (string)
    Output: { status: 'Y', pid, title, background, description, inputfmt, outputfmt,
              hint, timelm, memlm, datacount, sample (JSON array), checker_path }

    Expected middleware behavior:
    - Query problem metadata by pid
    - Return all problem fields
    - sample should be parsed as JSON array
    - Return 404 if problem not found
    */
});

router.post('/getproblemlist', requireAdmin, express.json(), async (req, res) => {
    let page = parseInt(req.body.page);
    if (isNaN(page) || page < 1) page = 1;
    if (page !== 1) {
        const err = validateInt(page, { positive: true });
        if (err) return res.json({ status: 'N', error: `page: ${err}` });
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    /*
    DB Interface, waiting for implement

    Input: page (int, 1-based)
    Output: { status: 'Y', data: [{ pid, title }, ...], page: totalPages }

    Expected middleware behavior:
    - Get paginated list of problems
    - Return only pid and title fields
    - Return total page count
    */
});

router.post('/submit', requireLogin, upload.none(), requirePermission('can_submit_code'), async (req, res) => {
    const { pid, code, language } = req.body;
    const user = req.user;
    const pidErr = validateString(pid, { minLen: 1, maxLen: 50 });
    if (pidErr) return res.json({ status: 'N', error: `pid: ${pidErr}` });
    const codeErr = validateString(code, { minLen: 1 });
    if (codeErr) return res.json({ status: 'N', error: `code: ${codeErr}` });
    const langErr = validateString(language, { minLen: 1, maxLen: 20 });
    if (langErr) return res.json({ status: 'N', error: `language: ${langErr}` });

    /*
    DB Interface, waiting for implement

    Input: pid (string), code (string, base64 encoded), language (string), user (from auth)
    Output: { status: 'Y', rid: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify problem exists
    - Submit code to the evaluation queue
    - The middleware handles: code storage, compilation, and task creation
    - Return submission id (rid)
    - Errors: problem not found, invalid language, etc.

    Note: The following code (pool.query, saveCodeFile, compileCode, tasks INSERT)
          should be REMOVED entirely. The middleware's judger handles all of these.
    */
});

router.get('/recordlist', requireAdmin, requireLogin, async (req, res) => {
    const target = req.query.target;
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.json({ status: 'N', error: `page: ${err}` });
        page = Number(req.query.page);
    }
    const perPage = 10;
    const user = req.user;

    /*
    DB Interface, waiting for implement

    Input: target (string, optional, pid or 'all'), page (int, optional, 1-based), user (from auth)
    Output: { status: 'Y', recordlist: JSON.stringify([rid, ...]), page: totalPages }

    Expected middleware behavior:
    - Get list of submission ids for the current user
    - If target is a pid, filter submissions for that problem
    - Return JSON string of rid array
    - Return total page count
    */
});

router.get('/record', requireLogin, requireAdmin, async (req, res) => {
    const rid = req.query.rid;
    const user = req.user;
    const ridErr = validateString(rid, { minLen: 1, maxLen: 50 });
    if (ridErr) return res.json({ status: 'N', error: `rid: ${ridErr}` });

    /*
    DB Interface, waiting for implement

    Input: rid (string), user (from auth)
    Output:
    - If pending: { status: 'P', data: { code: 202, describe: 'Pending' }, uid: user_id }
    - If finished: { status: 'Y', result: { overview, detail, uid }, code: base64_source }

    Overview fields: code (int), describe (string), time (int, ms), memory (int, bytes), score (int)
    Detail fields: code (int), describe (string), time (int, ms), memory (int, bytes), score (int), detail (string)

    Expected middleware behavior:
    - Verify user has permission (own record or can_view_others_submissions)
    - If submission is pending/judging, return status 'P'
    - Otherwise, return full result with overview + detail + source code (base64)
    */
});

function statusToCode(status) {
    const map = { AC:200, WA:406, TLE:408, MLE:413, RE:502, CE:400, SE:500, PD:202, JG:206 };
    return map[status] || 404;
}

module.exports = router;

/*
## 标注汇总

以下是在 `academic.js` 中标注的数据库通信接口及需要移除的函数：

| 项目 | 类型 | 标注位置 | 说明 |
|------|------|---------|------|
| `/getproblem` | 路由 | 替换 `pool.query` | 获取单个题目详情 |
| `/getproblemlist` | 路由 | 替换 `pool.query` | 分页获取题目列表 |
| `/submit` | 路由 | 替换整个路由逻辑 | 提交代码 → 完全由中间件接管 |
| `/recordlist` | 路由 | 替换 `pool.query` | 获取用户提交记录 ID 列表 |
| `/record` | 路由 | 替换 `pool.query` | 获取评测详情 |
| `saveCodeFile` | 函数 | 已经移除 | 代码存储由中间件接管 |
| `compileCode` | 函数 | 已经移除 | 编译由中间件的 Judger 接管 |
| `pool.query` 插入 `submissions` | SQL | 包含在 `/submit` 标注中 | 提交记录由中间件接管 |
| `pool.query` 插入 `tasks` | SQL | 包含在 `/submit` 标注中 | 评测队列由中间件 `submng` 接管 |
| `pool.query` 插入 `results` | SQL | 不再需要 | 结果由中间件 `recmng` 接管 |
| `fs` 代码文件读写 | 文件操作 | 不再需要 | 代码存储由中间件接管 |
*/