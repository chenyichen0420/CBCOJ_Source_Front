const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireLogin, requireAdmin, requirePermission, checkPermission } = require('../auth');
const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const multer = require('multer');
const upload = multer();
const { validateInt, validateString } = require('../validation');

router.get('/getproblem', requireLogin, async (req, res) => {
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

router.post('/getproblemlist', requireLogin, express.json(), async (req, res) => {
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

router.get('/recordlist', requireLogin, async (req, res) => {
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

router.get('/record', requireLogin, async (req, res) => {
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
    Output: { status: 'Y', pid: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Auto-generate next available numeric pid
    - Create new problem with provided fields
    - Set author to current user's username
    - Set opened=0 (not public by default)
    - Set selected=0 (not featured by default)
    - Return the assigned pid
    */
});

// 用户上传数据包（仅题目作者或有权限的用户）
const uploadZipUser = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const tempDir = '/tmp/oj_upload_temp';
            fs.mkdirSync(tempDir, { recursive: true });
            cb(null, tempDir);
        },
        filename: (req, file, cb) => {
            const unique = `${req.params.id}-${Date.now()}.zip`;
            cb(null, unique);
        }
    }),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传 ZIP 文件'));
        }
    }
});

router.post('/problem/:id/upload-data', requirePermission('can_manage_problems'), uploadZipUser.single('file'), async (req, res) => {
    const problemId = req.params.id;
    const idErr = validateInt(problemId, { positive: true });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
    const file = req.file;
    if (!file) return res.status(400).json({ status: 'N', error: '未选择文件' });
    /*
    DB Interface, waiting for implement

    Input: problemId (int), file (multipart zip), user (from auth)
    Output: { status: 'Y', message: string, data_path: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify user has permission (author or admin)
    - Extract ZIP file contents to problem data directory
    - Update problem's data_path field
    - Return success with data_path
    */
});

// 作者或管理员编辑题目
router.post('/problem/edit', requirePermission('can_manage_problems'), upload.none(), async (req, res) => {
    const user = req.user;
    const { id, pid, title, background, description, inputfmt, outputfmt, hint, timelm, memlm, datacount, sample, opened, selected } = req.body;
    const idErr = validateInt(id, { positive: true });
    if (idErr) return res.json({ status: 'N', error: `id: ${idErr}` });
    /*
    DB Interface, waiting for implement

    Input: id (int, required), pid (string, optional, admin only), title (string, optional),
            background (string, optional), description (string, optional),
            inputfmt (string, optional), outputfmt (string, optional),
            hint (string, optional), timelm (int, optional), memlm (int, optional),
            datacount (int, optional), sample (JSON array, optional),
            opened (int 0/1, optional), selected (int 0/1, optional, admin only),
            user (from auth)
    Output: { status: 'Y' } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify user has permission (author or admin)
    - Only admin can modify pid and selected fields
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