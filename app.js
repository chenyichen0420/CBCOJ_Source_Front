require('express-async-errors');
const express = require('express');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const logger = require('./logger');
const os = require('os');
const { requireLogin, requireAdmin, checkAdmin, getUserByCookie, checkPermission } = require('./auth');
const cheerio = require('cheerio');
const { SUBMIT_ROOT, COMPILE_ROOT, DATA_ROOT, CHECKER_ROOT, TEMP_UPLOAD, DISK_ROOT } = require('./config');
const { validateInt, validateString, validateEmail } = require('./validation');

const app = express();

// 设置模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 全局辅助函数：HTML 转义，防止 XSS
app.locals.escapeHtml = function(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const allowedOrigins = ['https://oj.lzj-blog.top','https://cbcoj.dpdns.org','localhost'];

// ---------- 原有中间件 ----------
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Headers', 'Authorization, priority, Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', '*');
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    req.injections = req.injections || {};
    next();
});

// IP 封禁检查与自动封禁（内存计数 + 数据库持久化）
const ipRequestWindow = 60 * 1000; // 1 分钟窗口
const ipRequestCounts = new Map(); // ip -> [timestamps]

// 检查请求 IP 是否在黑名单中
app.use(async (req, res, next) => {
    try {
        const ip = logger.getClientIp(req);
        /*
        DB Interface, waiting for implement

        Input: ip (string)
        Output: { ip_address, reason, created_at } | null

        Expected middleware behavior:
        - Check if IP is in banned list
        - Return ban record if exists, null otherwise
        - Auto-unban after 10 minutes for auto_rate_limit
        - This functionality should remain independent (Web layer only)
        */
        if (rows.length > 0) {
            const ban = rows[0];
            // 对于自动封禁（auto_rate_limit），10 分钟后自动解除
            const AUTO_UNBAN_MS = 10 * 60 * 1000;
            if (ban.reason === 'auto_rate_limit' && ban.created_at) {
                const created = new Date(ban.created_at).getTime();
                if (Date.now() - created > AUTO_UNBAN_MS) {
                    try {
                        /*
                        DB Interface, waiting for implement

                        Input: ip (string)
                        Output: void

                        Expected middleware behavior:
                        - Remove IP from banned list
                        - Log auto unban to security log
                        - This functionality should remain independent (Web layer only)
                        */
                    } catch (e) {
                        console.error('auto unban error', e);
                    }
                } else {
                    return res.status(403).send('Forbidden: your IP is banned');
                }
            } else {
                return res.status(403).send('Forbidden: your IP is banned');
            }
        }
        // 计数用于自动封禁
        const now = Date.now();
        const arr = ipRequestCounts.get(ip) || [];
        arr.push(now);
        // 保持窗口内
        while (arr.length && now - arr[0] > ipRequestWindow) arr.shift();
        ipRequestCounts.set(ip, arr);
        // 如果短时间内请求过多，自动封禁（阈值可调整）
        const AUTO_BAN_THRESHOLD = 2000; // 1 分钟内超过 2000 次请求
        if (arr.length > AUTO_BAN_THRESHOLD) {
            try {
                /*
                DB Interface, waiting for implement

                Input: ip (string), reason (string)
                Output: void

                Expected middleware behavior:
                - Insert IP into banned list with reason 'auto_rate_limit'
                - Log auto ban to security log
                - This functionality should remain independent (Web layer only)
                */
            } catch (e) { console.error('auto ban insert error', e); }
            return res.status(403).send('Forbidden: your IP is banned');
        }
    } catch (e) {
        console.error('ban check error', e);
    }
    next();
});

// 禁止直接访问 index.html
app.use((req, res, next) => {
    if (req.url.endsWith('/index.html') || req.url === '/index.html') {
        return res.status(403).send('Forbidden: direct access to index.html is not allowed.');
    }
    next();
});

// 可选认证中间件（用于访问日志获取用户信息）
app.use(async (req, res, next) => {
    let cookie = req.cookies?.user_cookie;
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    if (cookie) {
        try {
            const user = await getUserByCookie(cookie);
            if (user) req.user = user;
        } catch (e) {
            // 忽略认证错误，继续处理请求
        }
    }
    next();
});

// 访问日志中间件
app.use(async (req, res, next) => {
    const startTime = Date.now();
    const originalEnd = res.end;
    
    res.end = function(chunk, encoding) {
        originalEnd.call(this, chunk, encoding);
    };
    
    res.on('finish', () => {
        const responseTime = Date.now() - startTime;
        const ip = logger.getClientIp(req);
        const userId = req.user ? req.user.id : null;
        const username = req.user ? req.user.username : null;
        const method = req.method;
        const url = req.originalUrl || req.url;
        const statusCode = res.statusCode;
        const userAgent = req.headers['user-agent'] || null;
        const referer = req.headers['referer'] || null;
        // 异步记录，不阻塞响应
        logger.logAccess(userId, username, ip, method, url, statusCode, responseTime, userAgent, referer).catch(e => console.error(e));
    });
    
    next();
});

// ---------- 辅助函数 ----------
const navigation = `<a href="/" class="logo"><img src="/favicon.ico" width="20" height="20"> LZJOJ </a><a href="/problem/list">题库</a><a href="/discussions">讨论</a><a href="/record/list">评测列表</a><a href="/disk">网盘</a><a href="/contests">比赛列表</a><a href="/chat">私信</a><a href="/settings">个人设置</a>`;
const navigationAdmin = `<a href="/" class="logo"><img src="/favicon.ico" width="20" height="20"> LZJOJ </a><a href="/problem/list">题库</a><a href="/discussions">讨论</a><a href="/record/list">评测列表</a><a href="/disk">网盘</a><a href="/contests">比赛列表</a><a href="/chat">私信</a><a href="/settings">个人设置</a><a href="/admin">管理后台</a>`;

// 服务器端简单消毒函数：使用 cheerio 移除危险元素与属性
function sanitizeHtmlServer(html) {
    if (!html) return '';
    try {
        const $ = cheerio.load(html, { decodeEntities: true });
        // 移除危险的元素
        $('script, iframe, object, embed, form').remove();
        // 移除事件处理器(on*)和可疑的 href/src 属性
        $('*').each((i, el) => {
            const attribs = el.attribs || {};
            for (const attr in attribs) {
                if (/^on/i.test(attr)) $(el).removeAttr(attr);
                else {
                    const val = attribs[attr] + '';
                    if (/^javascript:/i.test(val) || /^data:/i.test(val)) {
                        $(el).removeAttr(attr);
                    }
                }
            }
        });
        // 返回 body 内部的 HTML（如果有 body），否则返回整段 HTML
        const body = $('body');
        return body.length ? body.html() : $.root().html();
    } catch (e) {
        console.error('sanitizeHtmlServer error', e);
        return '';
    }
}

async function getStatistics() {
    try {
        /*
        DB Interface, waiting for implement

        Input: void
        Output: [ problemCount, userCount, submissionCount, contestCount ]

        Expected middleware behavior:
        - Get total counts from middleware
        - Return as array of strings with '+' suffix
        - Should be cached for performance (homepage stats)
        */
        return [probCount[0].total + '+', userCount[0].total + '+', subCount[0].total + '+', contestCount[0].total + '+'];
    } catch (err) {
        console.error('Error during getting homepage statistics: ', err);
        return [0, 0, 0, 0];
    }
}

// ---------- 服务端渲染路由 ----------

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// 首页
app.get('/', async (req, res) => {
    const stats = await getStatistics();
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('index', { stats, navigation: nav, user: req.user });
});

// 题库列表
app.get('/problem/list', async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    const isAdmin = await checkAdmin(req);
    /*
    DB Interface, waiting for implement

    Input: page (int, 1-based), isAdmin (boolean)
    Output: { total, totalPages, problems: [{ pid, title }, ...] }

    Expected middleware behavior:
    - Get paginated problem list
    - Non-admin: only show selected=1 AND opened=1
    - Admin: show all problems
    - Return total count and problems array
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problemlist', { problems, page, totalPages, navigation: nav, user: req.user });
});

// 新建题目编辑页面（放在 /problem/:pid 路由之前，避免被参数路由捕获）
app.get('/problem/new', requireLogin, async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problem-new', { title: '新建题目', navigation: nav, user: req.user, admin: isAdmin });
});

app.get('/problem/me', requireLogin, async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).json({ status: 'N', error: `page: ${err}` });
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    const isAdmin = await checkAdmin(req);
    const currentUser = req.user;
    /*
    DB Interface, waiting for implement

    Input: username (string from currentUser), page (int, 1-based)
    Output: { total, totalPages, problems: [{ pid, title }, ...] }

    Expected middleware behavior:
    - Get paginated list of problems created by the current user
    - Filter by author username
    - Return total count and problems array
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problemlist', { problems, page, totalPages, navigation: nav, user: req.user });
});

// 题目详情
app.get('/problem/:pid', async (req, res) => {
    const pid = req.params.pid;
    const pidErr = validateString(pid, { minLen: 1, maxLen: 50 });
    if (pidErr) return res.status(400).send(`pid: ${pidErr}`);
    /*
    DB Interface, waiting for implement

    Input: pid (string)
    Output: problem object (full details)

    Expected middleware behavior:
    - Get full problem details by pid
    - If problem is not opened (opened=0), only admin or author can view
    - Parse sample as JSON array
    - Get author metadata (username, role, badge, name_color) from account system
    - Return problem object with author_meta attached
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problem', { problem, navigation: nav, user: req.user });
});


// 编辑题目界面（作者或有权限的用户）
app.get('/problem/edit/:pid', requireLogin, async (req, res) => {
    const pid = req.params.pid;
    const pidErr = validateString(pid, { minLen: 1, maxLen: 50 });
    if (pidErr) return res.status(400).send(`pid: ${pidErr}`);
    /*
    DB Interface, waiting for implement

    Input: pid (string), user (from auth)
    Output: problem object (full details)

    Expected middleware behavior:
    - Get full problem details by pid
    - Check permission: author or can_manage_problems
    - Parse sample as JSON array
    - Return problem object for editing
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problem-edit', { title: '编辑题目', navigation: nav, user: req.user, admin: isAdmin, problem });
});

// 讨论列表
app.get('/discussions', async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    /*
    MODULE: Discussions
    Status: INDEPENDENT (kept in local database)

    This module is NOT part of the middleware.
    All discussions/replies data should be stored in local MySQL database.
    No changes needed.
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('discussions', { discussions, page, totalPages, navigation: nav, user: req.user });
});

// 讨论详情
app.get('/discussion-detail/:cid', async (req, res) => {
    const cid = req.params.cid;
    const cidErr = validateString(cid, { minLen: 1, maxLen: 50 });
    if (cidErr) return res.status(400).send(`cid: ${cidErr}`);
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    /*
    MODULE: Discussions
    Status: INDEPENDENT (kept in local database)

    This module is NOT part of the middleware.
    All discussions/replies data should be stored in local MySQL database.
    No changes needed.
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('discussion-detail', { discussion, replies: replyRows, cid, page, totalPages, navigation: nav, user: req.user });
});

// 提交列表
app.get('/record/list', async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    
    let username = req.query.username || '';
    if (username) {
        const unErr = validateString(username, { minLen: 1, maxLen: 100 });
        if (unErr) return res.status(400).send(`username: ${unErr}`);
    }
    let pid = req.query.pid || '';
    if (pid) {
        const pidErr = validateString(pid, { minLen: 1, maxLen: 50 });
        if (pidErr) return res.status(400).send(`pid: ${pidErr}`);
    }
    
    const isAdmin = await checkAdmin(req);
    const currentUserId = req.user ? req.user.id : null;
    
    /*
    DB Interface, waiting for implement

    Input: username (string, optional), pid (string, optional), page (int, 1-based), user (from auth)
    Output: { total, totalPages, submissions: [{ id, pid, submit_time, status, username, user_id, role, badge, name_color, statusText, isOwn }, ...] }

    Expected middleware behavior:
    - Get paginated submission list
    - Filter by username (if provided, check pubcode permission)
    - Filter by pid (if provided)
    - Non-admin: only show public submissions (pubcode='yes')
    - Return submissions with status descriptions
    - Mark isOwn if submission belongs to current user
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('submissionlist', { 
        submissions, 
        page, 
        totalPages, 
        username: username || '',
        pid: pid || '',
        total,
        navigation: nav, 
        user: req.user 
    });
});

// 单个评测详情
app.get('/record/:rid', requireLogin, async (req, res) => {
    const rid = req.params.rid;
    const ridErr = validateString(rid, { minLen: 1, maxLen: 50 });
    if (ridErr) return res.status(400).send(`rid: ${ridErr}`);
    /*
    DB Interface, waiting for implement

    Input: rid (string), user (from auth)
    Output: submission object with results, sourceCode

    Expected middleware behavior:
    - Get submission by rid
    - Check permission: own record or can_view_others_submissions
    - Get all test point results
    - Calculate totals: totalScore, totalTime, maxMemory
    - Calculate overallCode and overallDesc based on status counts
    - Get user info (username, role, badge, name_color)
    - Get problem info (pid, title)
    - Return full data for status page rendering
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('status', { submission, results, totalScore, totalTime, maxMemory, overallCode, overallDesc, sourceCode, navigation: nav, user: req.user });
});

// 比赛列表
app.get('/contests', async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const limit = 10;
    const offset = (page - 1) * limit;
    const isAdmin = await checkAdmin(req);
    /*
    DB Interface, waiting for implement

    Input: page (int, 1-based), isAdmin (boolean)
    Output: { total, totalPages, contests: [{ id, title, start_time, end_time }, ...] }

    Expected middleware behavior:
    - Get paginated contest list
    - Non-admin: only show started contests (start_time <= NOW())
    - Admin: show all contests
    - Return total count and contests array
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('contests', { contests, page, totalPages, navigation: nav, user: req.user });
});

// 比赛详情
app.get('/contest/:id', async (req, res) => {
    const id = req.params.id;
    const idErr = validateString(id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).send(`id: ${idErr}`);
    const isAdmin = await checkAdmin(req);
    /*
    DB Interface, waiting for implement

    Input: id (string), isAdmin (boolean)
    Output: { contest, problems, rank }

    Expected middleware behavior:
    - Get contest by id
    - Non-admin: check if contest has started
    - Get problem list with display order
    - Get ranking (username, solved count)
    - Return full contest data
    */
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('contest', { contest, problems, rank, navigation: nav, user: req.user });
});

// 个人主页（公开）
app.get('/profile/:username', async (req, res) => {
    const username = req.params.username;
    const unErr = validateString(username, { minLen: 1, maxLen: 100 });
    if (unErr) return res.status(400).send(`username: ${unErr}`);
    /*
    MODULE: Profile
    Status: INDEPENDENT (kept in local database)

    Input: username (string)
    Output: { profileUser, markdown }

    Expected behavior:
    - Get user info (id, username, role, badge, name_color) from middleware
    - Get markdown_content from local user_profiles table
    - This module is NOT part of the middleware (personal profile pages are independent)
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('profile', { profileUser, markdown, navigation: nav, currentUser: req.user });
});

// 编辑个人主页（需要登录）
app.get('/profile-edit', requireLogin, async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('profile-edit', { navigation: nav, user: req.user });
});

// 私信页面
app.get('/chat', requireLogin, async (req, res) => {
    let page = parseInt(req.query.page) || 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage;
    /*
    MODULE: Chat / Private Messages
    Status: INDEPENDENT (kept in local database)

    This module is NOT part of the middleware.
    All private messages data should be stored in local MySQL database.
    No changes needed.
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('chat', { messages, page, totalPages, navigation: nav, user: req.user });
});

// 个人设置
app.get('/settings', requireLogin, async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('settings', { navigation: nav, user: req.user });
});

// 网盘
app.get('/disk', requireLogin, async (req, res) => {
    /*
    MODULE: Disk
    Status: INDEPENDENT (kept in local database + file system)

    Input: user (from auth)
    Output: { files, quota, used }

    Expected behavior:
    - Get file list from local disk_files table (by user_id)
    - Get quota from local users table (disk_quota)
    - Calculate used space (SUM file_size)
    - This module is NOT part of the middleware
    */
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('disk', { files, quota, used, navigation: nav, user: req.user });
});

// 登录页面
app.get('/login', async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('login', { navigation: nav, user: req.user });
});

// 注册页面
app.get('/register', async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('register', { navigation: nav, user: req.user });
});

// 管理后台页面
app.get('/admin', async (req, res) => {
    const isAdmin = await checkAdmin(req);
    if (!isAdmin) return res.status(403).send('无权限');
    const nav = navigationAdmin;
    res.render('admin', { navigation: nav, user: req.user });
});

// ---------- API 路由（保持不变） ----------
app.use('/api', require('./routes/academic'));
app.use('/api', require('./routes/user'));
app.use('/api', require('./routes/community'));
app.use('/api', require('./routes/admin'));
app.use('/api/contests', require('./routes/contest'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/disk', require('./routes/disk'));

// ---------- 静态资源（CSS, JS, 图片等） ----------
app.use('/assets', express.static(path.join(__dirname, 'webpage/assets')));
app.use('/admin/assets', express.static(path.join(__dirname, 'webpage/admin/assets')));
app.use('/favicon.ico', express.static(path.join(__dirname, 'webpage/favicon.ico')));

// 对于其他未匹配的静态文件（如 robots.txt），仍然允许通过原有静态中间件，但不提供 .html 文件
app.use(express.static(path.join(__dirname, 'webpage'), {
    index: false,
    extensions: ['txt', 'xml', 'ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']
}));

// 全局错误处理中间件（必须在所有路由之后）
app.use(async (err, req, res, next) => {
    const ip = logger.getClientIp(req);
    const userId = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : null;
    await logger.logError(`Unhandled error: ${err.message}`, err);
    console.error(err);
    res.status(500).json({ status: 'N', error: '服务器内部错误' });
});

// 404 处理
app.use((req, res) => {
    res.status(404).send('页面未找到');
});

// ---------- 启动服务器 ----------
async function ensureDirs() {
    const dirs = [SUBMIT_ROOT, COMPILE_ROOT, DATA_ROOT, CHECKER_ROOT, TEMP_UPLOAD];
    for (const d of dirs) {
        await fs.promises.mkdir(d, { recursive: true });
    }
}

/*
Function: updateContestSubmission
Status: TO BE REMOVED (replaced by middleware)

This function is no longer needed. Contest submission updates are now handled by the middleware.
*/
async function updateContestSubmission(conn, submissionId) {
    // ... entire function body to be removed ...
}

/*
Function: startFinalizer
Status: TO BE REMOVED (replaced by middleware)

This function is no longer needed. Result aggregation is now handled by the middleware's recmng.
*/
function startFinalizer() {
    // ... entire function body to be removed ...
}

setInterval(async () => {
    await logger.logRuntime('STATS', 'Server periodic health check');
}, 10 * 60 * 1000);

// 未捕获的Promise拒绝处理
process.on('unhandledRejection', (reason, promise) => {
    logger.logError('Unhandled Rejection', reason).catch(e => console.error(e));
});

const PORT = 8640;
ensureDirs().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
        startFinalizer();
    });
});

/*
## 标注汇总

### 需要对接中间件的页面路由（P0）

| 路由 | 标注位置 | 需要的数据 |
|------|---------|-----------|
| `/problem/list` | 替换 `pool.query` | 分页题目列表（pid, title） |
| `/problem/me` | 替换 `pool.query` | 当前用户创建的题目列表 |
| `/problem/:pid` | 替换 `pool.query` | 完整题目详情 + 作者信息 |
| `/problem/edit/:pid` | 替换 `pool.query` | 完整题目详情（编辑用） |
| `/record/list` | 替换 `pool.query` | 分页提交记录（含状态、用户、题目信息） |
| `/record/:rid` | 替换 `pool.query` | 提交详情 + 测试点结果 + 代码 |
| `/contests` | 替换 `pool.query` | 分页比赛列表 |
| `/contest/:id` | 替换 `pool.query` | 比赛详情 + 题目 + 排名 |

### 独立保留模块（无需修改）

| 路由 | 状态 | 说明 |
|------|------|------|
| `/discussions` | 独立保留 | 讨论区列表 |
| `/discussion-detail/:cid` | 独立保留 | 讨论详情 |
| `/chat` | 独立保留 | 私信页面 |
| `/disk` | 独立保留 | 网盘页面 |
| `/profile/:username` | 混合 | 用户信息从中间件获取，Markdown 本地存储 |
| `/profile-edit` | 独立保留 | 个人主页编辑 |

### 需要移除的组件

| 组件 | 位置 | 原因 |
|------|------|------|
| `updateContestSubmission` | 第 632-656 行 | 比赛排名由 `conmng` 接管 |
| `startFinalizer` | 第 658-679 行 | 结果聚合由 `recmng` 接管 |
| `pool.query` 在 IP 封禁中 | 第 60-110 行 | 独立模块，但可保留（Web 层） |

### 需要修改的页面路由（EJS 渲染）

以下是所有 `res.render()` 调用及其依赖的数据：

| 路由 | EJS 模板 | 数据来源（改造后） |
|------|---------|-------------------|
| `/` | `index.ejs` | 中间件统计 API |
| `/problem/list` | `problemlist.ejs` | 中间件题目列表 |
| `/problem/new` | `problem-new.ejs` | 无数据依赖 |
| `/problem/me` | `problemlist.ejs` | 中间件题目列表（按作者） |
| `/problem/:pid` | `problem.ejs` | 中间件题目详情 |
| `/problem/edit/:pid` | `problem-edit.ejs` | 中间件题目详情 |
| `/discussions` | `discussions.ejs` | 本地数据库 |
| `/discussion-detail/:cid` | `discussion-detail.ejs` | 本地数据库 |
| `/record/list` | `submissionlist.ejs` | 中间件记录列表 |
| `/record/:rid` | `status.ejs` | 中间件记录详情 |
| `/contests` | `contests.ejs` | 中间件比赛列表 |
| `/contest/:id` | `contest.ejs` | 中间件比赛详情 |
| `/profile/:username` | `profile.ejs` | 本地数据库（用户信息从中间件） |
| `/profile-edit` | `profile-edit.ejs` | 无数据依赖 |
| `/chat` | `chat.ejs` | 本地数据库 |
| `/settings` | `settings.ejs` | 无数据依赖（用户信息由前端获取） |
| `/disk` | `disk.ejs` | 本地数据库 |
| `/login` | `login.ejs` | 无数据依赖 |
| `/register` | `register.ejs` | 无数据依赖 |
| `/admin` | `admin.ejs` | 无数据依赖 |
*/