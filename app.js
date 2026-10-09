const express = require('express');
const path = require('path');
const pool = require('./db');
const logger = require('./logger');
const { requireLogin, checkAdmin, getUserByCookie, checkPermission, requirePermission } = require('./auth');
const appPort = require('./config').middleware.appPort;
const { validateInt, validateString } = require('./validation');

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
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    next();
});

app.use((req, res, next) => {
    req.injections = req.injections || {};
    next();
});

// IP 封禁检查与自动封禁（内存计数 + 数据库持久化）
const ipRequestWindow = 60 * 1000; // 1 分钟窗口
const ipRequestCounts = new Map(); // ip -> [timestamps]

// 检查请求 IP 是否在黑名单中
app.use(async (req, res, next) => {
    next();
    return;
    //temporaly disabled
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
            // 对于自动封禁（auto_rate_limit），30 分钟后自动解除
            const AUTO_UNBAN_MS = 30 * 60 * 1000;
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
        const AUTO_BAN_THRESHOLD = 1000; // 1 分钟内超过 1000 次请求
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
const navigation = `<a href="/" class="logo"><img src="/favicon.ico" width="20" height="20"> CBCOJ </a><a href="/problem/list">题库</a><a href="/discussions">讨论</a><a href="/record/list">评测列表</a><a href="/contests">比赛列表</a><a href="/chat">私信</a><a href="/settings">个人设置</a>`;
const navigationAdmin = `<a href="/" class="logo"><img src="/favicon.ico" width="20" height="20"> CBCOJ </a><a href="/problem/list">题库</a><a href="/discussions">讨论</a><a href="/record/list">评测列表</a><a href="/contests">比赛列表</a><a href="/chat">私信</a><a href="/settings">个人设置</a><a href="/admin">管理后台</a>`;

async function getStatistics() {
    try {
        const conn = pool.getAccount();
        const resp = await conn.send('S', pool.packParams([]));
        if (resp.command !== 'Y') throw new Error('Statistics query failed');

        // AccountSession's S response order is record count, problem count, contest count, user count, hack count.
        const values = pool.parsePack(resp.data).map(part => part.toString('utf8'));

        if (values.length !== 5 || values.some(value => !/^\d+$/.test(value))) {
            throw new Error('Invalid statistics response');
        }

        // Homepage order: problems, users, submissions, contests.
        return [values[1], values[3], values[0], values[2]].map(value => `${value}+`);
    } catch (err) {
        logger.logError('Error during getting homepage statistics', err);
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

function decodeStoredText(value) {
    if (value === undefined || value === null || value === '') return '';
    const text = String(value);
    try {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('base64') === text) return decoded;
    } catch (_) {
        // 保留旧版本 basic.txt 中的明文值
    }
    return text;
}

function decodeStatement(statement) {
    let content;
    try {
        content = JSON.parse(statement || '{}');
    } catch (_) {
        return { description: statement || '' };
    }
    if (!content || Array.isArray(content)) return {};
    return Object.fromEntries(Object.entries(content).map(([key, value]) => {
        const decoded = decodeStoredText(value);
        if (key === 'sample') {
            try {
                return [key, JSON.parse(decoded)];
            } catch (_) {
                return [key, []];
            }
        }
        return [key, decoded];
    }));
}

async function getProblemFromMiddleware(id, fields = ['id', 'title', 'difficulty', 'timelimit', 'memorylimit', 'time', 'author', 'statement', 'open']) {
    const conn = pool.getJudge();
    const resp = await conn.send('P', pool.packParams([String(id), ...fields]));
    if (resp.command !== 'Y') return null;
    const parts = pool.parsePack(resp.data);
    if (parts.length !== fields.length) throw new Error('Invalid problem response');

    const values = Object.fromEntries(fields.map((field, index) => {
        const value = parts[index].toString('utf8');
        return [field, field === 'id' || field === 'open' || field === 'statement'
            ? value : decodeStoredText(value)];
    }));
    const statement = values.statement || '{}';
    const content = decodeStatement(statement);

    const problem = {
        id: values.id || String(id),
        title: values.title || '',
        difficulty: values.difficulty || '',
        timelm: Number(values.timelimit) || 0,
        memlm: Number(values.memorylimit) || 0,
        time: values.time || '',
        author: values.author || '',
        opened: values.open === '1' || values.open === 'open',
        sample: []
    };
    Object.assign(problem, content);
    if (!Array.isArray(problem.sample)) problem.sample = [];
    problem._statement = content;
    return problem;
}

async function getAuthorMeta(username) {
    if (!username) return null;
    const conn = pool.getAccount();
    const resp = await conn.send('U', pool.packParams([
        'any', username, 'uid', 'username', 'role', 'badge', 'name_color'
    ]));
    if (resp.command !== 'Y') return { username };
    const parts = pool.parsePack(resp.data);
    if (parts.length < 4) return { username };
    return {
        uid: Number(parts[0].toString('utf8')),
        username: parts[1].toString('utf8'),
        role: parts[2].toString('utf8') || 'user',
        badge: parts[3].toString('utf8') || null,
        name_color: parts[4] ? parts[4].toString('utf8') || null : null
    };
}

function getRequestCookie(req) {
    let cookie = req.body?.cookie || req.query?.cookie;
    if (!cookie && req.headers.cookie) {
        const match = req.headers.cookie.match(/(?:^|;\s*)user_cookie=([^;]*)/);
        if (match) cookie = decodeURIComponent(match[1]);
    }
    return cookie;
}

async function getUserMetaById(uid) {
    const conn = pool.getAccount();
    const resp = await conn.send('U', pool.packParams([
        'any', String(uid), 'uid', 'username', 'role', 'badge', 'name_color'
    ]));
    if (resp.command !== 'Y') return null;
    const parts = pool.parsePack(resp.data);
    if (parts.length < 5) throw new Error('Invalid user metadata response');
    return {
        uid: Number(parts[0].toString('utf8')),
        username: parts[1].toString('utf8'),
        role: parts[2].toString('utf8') || 'user',
        badge: parts[3].toString('utf8') || null,
        name_color: parts[4].toString('utf8') || null
    };
}

function resultDescription(code) {
    return ({
        200: 'Accepted', 400: 'Compilation Error', 403: 'Rejected', 406: 'Wrong Answer',
        408: 'Time Limit Exceeded', 413: 'Memory Limit Exceeded',
        500: 'System Error', 502: 'Runtime Error', 202: 'In Queue', 206: 'Judging'
    })[Number(code)] || 'Unknown';
}

async function getRecordFromMiddleware(cookie, rid) {
    const response = await pool.getJudge().send('Q', pool.packParams([cookie, String(rid)]));
    if (response.command !== 'Y') {
        const parts = pool.parsePack(response.data);
        return { error: parts[0]?.toString('utf8') || '评测记录不可用' };
    }
    const parts = pool.parsePack(response.data);
    if (parts.length < 1) throw new Error('Invalid record response');
    const result = pool.parseJudgeResult(parts[0].toString('utf8'));
    return { result, sourceCode: parts.length > 1 ? parts[1].toString('utf8') : null };
}

// 首页
app.get('/', async (req, res) => {
    const stats = await getStatistics();
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;

    // service health (cached at least 60s inside db.js)
    let health = null;
    try {
        health = await pool.healthCheck();
    } catch (e) {
        health = { overall: 'red', account: false, judge: false, hack: false, hackChannels: 0, lastChecked: Date.now() };
    }
    const healthText = health && health.lastChecked ? new Date(health.lastChecked).toLocaleString() : '未知';

    res.render('index', { stats, navigation: nav, user: req.user, health, healthText });
});

// 题库列表
app.get('/problem/list', async (req, res) => {
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const perPage = 10;
    const offset = (page - 1) * perPage + 1;
    const isAdmin = await checkAdmin(req);
    const canmngproblem = req.user?.id != null ? await checkPermission(req.user.id, 'can_manage_problems') : false;
    try {
        const conn = pool.getJudge();
        const resp = await conn.send('L', pool.packParams([String(offset), String(perPage), canmngproblem ? '1' : '0']));
        if (resp.command !== 'Y') return res.status(502).send('题目列表获取失败');
        const parts = pool.parsePack(resp.data).map(part => part.toString('utf8'));
        // protocol: first element is total count, following elements are the returned ids for this page
        const total = Number(parts.shift());
        if (validateInt(total, { positive: false, min: 0 })) throw new Error('Invalid total count');
        const ids = parts;
        const results = await Promise.all(ids.map(async id => {
            const problem = await getProblemFromMiddleware(id);
            if (!problem) {
                await logger.logError(`Problem list: failed to load problem ${id}`, new Error('Problem query rejected by middleware'));
                return null;
            }
            return { id: `${id}`, title: problem.title };
        }));
        const problems = results.filter(problem => problem !== null);
        const totalPages = Math.max(1, Math.ceil(total / perPage));

        // pagination links: first, current-5..current+5, last (unique, sorted)
        const pagesSet = new Set();
        pagesSet.add(1);
        const start = Math.max(1, page - 5);
        const end = Math.min(totalPages, page + 5);
        for (let i = start; i <= end; i++) pagesSet.add(i);
        pagesSet.add(totalPages);
        const pageLinks = Array.from(pagesSet).sort((a,b)=>a-b);

        const nav = isAdmin ? navigationAdmin : navigation;
        res.render('problemlist', { problems, page, totalPages, pageLinks, navigation: nav, user: req.user, problemmng: canmngproblem });
    } catch (err) {
        logger.logError(`Problem list failed: ${err.message}`, err);
        res.status(502).send('题目列表获取失败');
    }
});

// 新建题目编辑页面（放在 /problem/:id 路由之前，避免被参数路由捕获）
app.get('/problem/new', requireLogin, requirePermission('can_manage_problems'), async (req, res) => {
    const isAdmin = await checkAdmin(req);
    const nav = isAdmin ? navigationAdmin : navigation;
    res.render('problem-new', { title: '新建题目', navigation: nav, user: req.user, admin: isAdmin });
});

// 题目详情
app.get('/problem/:id', async (req, res) => {
    const id = req.params.id;
    const idErr = validateString(id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).send(`id: ${idErr}`);
    try {
        const problem = await getProblemFromMiddleware(id);
        if (!problem) return res.status(404).send('题目不存在');
        const isAdmin = await checkAdmin(req);
        const canmngproblem = req.user?.id != null ? await checkPermission(req.user.id, 'can_manage_problems') : false;
        if (!problem.opened && !canmngproblem) {
            return res.status(403).send('该题目尚未公开');
        }
        problem.author_meta = await getAuthorMeta(problem.author);
        const nav = isAdmin ? navigationAdmin : navigation;
        res.render('problem', { problem, navigation: nav, user: req.user, canmngproblem });
    } catch (err) {
        logger.logError(`Problem detail failed for ${id}: ${err.message}`, err);
        res.status(502).send('题目信息获取失败');
    }
});


// 编辑题目界面（作者或有权限的用户）
app.get('/problem/edit/:id', requireLogin, requirePermission('can_manage_problems'), async (req, res) => {
    const id = req.params.id;
    const idErr = validateString(id, { minLen: 1, maxLen: 50 });
    if (idErr) return res.status(400).send(`id: ${idErr}`);
    try {
        const problem = await getProblemFromMiddleware(id);
        if (!problem) return res.status(404).send('题目不存在');
        const isAdmin = await checkPermission(req.user.id, 'can_manage_problems');
        const isAuthor = Number(req.user.id) === Number(problem.author) || req.user.username === problem.author;
        if (!isAdmin && !isAuthor) return res.status(403).send('无权编辑该题目');
        const nav = isAdmin ? navigationAdmin : navigation;
        res.render('problem-edit', { title: '编辑题目', navigation: nav, user: req.user, admin: isAdmin, problem });
    } catch (err) {
        logger.logError(`Problem edit page failed for ${id}: ${err.message}`, err);
        res.status(502).send('题目信息获取失败');
    }
});

// 讨论列表
app.get('/discussions', async (req, res) => {
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
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
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
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
app.get('/record/list', requireLogin, async (req, res) => {
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
        if (err) return res.status(400).send(`page: ${err}`);
        page = Number(req.query.page);
    }
    const pageSize = pool.RECORD_PAGE_SIZE;
    let username = req.query.username || '';
    if (username) {
        const unErr = validateString(username, { minLen: 1, maxLen: 100 });
        if (unErr) return res.status(400).send(`username: ${unErr}`);
    }
    let problemId = req.query.id || '';
    if (problemId) {
        const idErr = validateInt(problemId, { positive: true, max: 2147483647 });
        if (idErr) return res.status(400).send(`id: ${idErr}`);
    }

    if(!username && !problemId){
        username = req.user.username
    }

    try {
        const targetUser = username ? await getAuthorMeta(username) : null;
        if (username && targetUser?.uid === undefined) {
            const isAdmin = await checkAdmin(req);
            const nav = isAdmin ? navigationAdmin : navigation;
            return res.render('submissionlist', {
                submissions: [], page, totalPages: 1, username, problemId, total: 0,
                navigation: nav, user: req.user
            });
        }
        const uid = targetUser ? targetUser.uid : (problemId ? -1 : Number(req.user.id));
        const pid = problemId ? Number(problemId) : -1;
        const response = await pool.getJudge().send('I', pool.packParams([
            getRequestCookie(req), String(uid), String(pid), String(page - 1), String(pageSize)
        ]));

        // console.log(response);
        // console.log(pool.parsePack(response.data).map(part => part.toString('utf8')));

        if (response.command !== 'Y') {
            const parts = pool.parsePack(response.data);
            throw new Error(parts[0]?.toString('utf8') || 'Submission index query failed');
        }
        const parts = pool.parsePack(response.data).map(part => part.toString('utf8'));
        if (parts.length === 0 || (parts.length - 1) % 10 !== 0) {
            throw new Error('Invalid submission index response');
        }
        const total = Number(parts[0]);
        if (validateInt(total, { positive: false, min: 0 })) throw new Error('Invalid submission count');
        const records = [];
        for (let i = 1; i < parts.length; i += 10) {
            records.push({
                id: parts[i],
                user_id: Number(parts[i + 1]),
                problem_id: parts[i + 2],
                statusCode: Number(parts[i + 3]),
                score: Number(parts[i + 4]),
                time_ms: Number(parts[i + 5]),
                memory_kb: Number(parts[i + 6]),
                language: Number(parts[i + 7]),
                submit_time: Number(parts[i + 8]) * 1000,
                state: parts[i + 9]
            });
        }
        const userIds = [...new Set(records.map(record => record.user_id))];
        const problemIds = [...new Set(records.map(record => record.problem_id))];
        const [userEntries, problemEntries] = await Promise.all([
            Promise.all(userIds.map(async id => [id, await getUserMetaById(id)])),
            Promise.all(problemIds.map(async id => [id, await getProblemFromMiddleware(id, ['id', 'title'])]))
        ]);
        const users = new Map(userEntries);
        const problems = new Map(problemEntries);
        const submissions = records.map(record => {
            const recordUser = users.get(record.user_id) || {
                username: String(record.user_id), role: 'user', badge: null, name_color: null
            };
            const problem = problems.get(record.problem_id);
            const finalCode = record.state.startsWith('finished:')
                ? Number(record.state.slice('finished:'.length))
                : record.statusCode === 1 ? 200 : null;
            const statusClasses = {
                200: 'AC', 400: 'CE', 406: 'WA', 408: 'TLE',
                413: 'MLE', 500: 'SE', 502: 'RE'
            };
            let status = statusClasses[finalCode] || 'finished';
            let statusText = finalCode === null ? '未通过' : resultDescription(finalCode);
            if (record.statusCode === 1 || finalCode === 200) {
                status = 'AC';
                statusText = 'Accepted';
            } else if (record.state === 'pending') {
                status = 'pending';
                statusText = '排队中';
            } else if (record.state === 'judging') {
                status = 'judging';
                statusText = '评测中';
            }
            return {
                ...record,
                username: recordUser.username,
                role: recordUser.role,
                badge: recordUser.badge,
                name_color: recordUser.name_color,
                problem_title: problem?.title || `题目 ${record.problem_id}`,
                status,
                statusText,
                isOwn: Number(req.user.id) === record.user_id
            };
        });
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const isAdmin = await checkAdmin(req);
        const nav = isAdmin ? navigationAdmin : navigation;
        res.render('submissionlist', {
            submissions, page, totalPages, username, problemId, total,
            navigation: nav, user: req.user
        });
    } catch (err) {
        logger.logError(`Submission index failed: ${err.message}`, err);
        res.status(502).send('评测记录列表获取失败');
    }
});

// 单个评测详情
app.get('/record/:rid', requireLogin, async (req, res) => {
    const rid = req.params.rid;
    const ridErr = validateInt(rid, { positive: true, max: 2147483647 });
    if (ridErr) return res.status(400).send(`rid: ${ridErr}`);
    try {
        const cookie = getRequestCookie(req);
        const [recordData, summaryResponse] = await Promise.all([
            getRecordFromMiddleware(cookie, rid),
            pool.getJudge().send('V', pool.packParams([cookie, rid]))
        ]);
        if (recordData.error) return res.status(403).send(recordData.error);
        if (summaryResponse.command !== 'Y') return res.status(404).send('评测记录不存在');
        const summary = pool.parsePack(summaryResponse.data).map(part => part.toString('utf8'));
        if (summary.length !== 8) throw new Error('Invalid record summary response');
        const uid = Number(summary[0]);
        const pid = summary[1];
        const [author, problem] = await Promise.all([
            getUserMetaById(uid),
            getProblemFromMiddleware(pid, ['id', 'title'])
        ]);
        const detail = recordData.result;
        const pending = !detail.total;
        const results = pending ? [] : (Array.isArray(detail.detail) ? detail.detail : []).map((subtask, index) => {
            const total = subtask.total || {};
            return {
                test_point_index: index + 1,
                status: resultDescription(total.c),
                description: total.des || '',
                score: Number(total.pts) || 0,
                time_ms: Number(total.t) || 0,
                memory_bytes: Number(total.m) || 0,
                testcases: Array.isArray(subtask.detail) ? subtask.detail.map((testcase, testIndex) => ({
                    test_point_index: testIndex + 1,
                    status: resultDescription(testcase.c),
                    time_ms: Number(testcase.t) || 0,
                    memory_bytes: Number(testcase.m) || 0
                })) : []
            };
        });
        const overallCode = pending ? (Number(detail.c) || 202) : Number(detail.total.c);
        const submission = {
            id: rid,
            uid,
            username: author?.username || String(uid),
            user_role: author?.role || 'user',
            user_badge: author?.badge || null,
            user_name_color: author?.name_color || null,
            problemname: pid,
            problemtitle: problem?.title || `题目 ${pid}`,
            submit_time: Number(summary[7]) * 1000
        };
        const totalScore = pending ? 0 : Number(detail.total.pts) || 0;
        const totalTime = pending ? 0 : Number(detail.total.t) || 0;
        const maxMemory = pending ? 0 : Number(detail.total.m) || 0;
        const overallDesc = pending
            ? (detail.des || 'Pending')
            : (detail.total.des || resultDescription(overallCode));
        const sourceCode = recordData.sourceCode;
        const isAdmin = await checkAdmin(req);
        const nav = isAdmin ? navigationAdmin : navigation;
        res.render('status', {
            submission, results, totalScore, totalTime, maxMemory,
            overallCode, overallDesc, sourceCode, pending,
            navigation: nav, user: req.user
        });
    } catch (err) {
        logger.logError(`Record detail failed for ${rid}: ${err.message}`, err);
        res.status(502).send('评测记录获取失败');
    }
});

// 比赛列表
app.get('/contests', async (req, res) => {
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
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
    let page = 1;
    if (req.query.page !== undefined) {
        const err = validateInt(req.query.page, { positive: true, max: 2147483647 });
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
app.use('/api', require('./routes/admin'));
// app.use('/api', require('./routes/community'));
// app.use('/api/contests', require('./routes/contest'));
// app.use('/api/profile', require('./routes/profile'));

// ---------- 静态资源（CSS, JS, 图片等） ----------
app.use('/assets', express.static(path.join(__dirname, 'webpage/assets'), {
    maxAge: '5m',
    etag: true,
    lastModified: true
}));
app.use('/admin/assets', express.static(path.join(__dirname, 'webpage/admin/assets'), {
    maxAge: '5m',
    etag: true,
    lastModified: true
}));
app.use('/favicon.ico', express.static(path.join(__dirname, 'webpage/favicon.ico'), {
    maxAge: '5m',
    etag: true,
    lastModified: true
}));

// 对于其他未匹配的静态文件（如 robots.txt），仍然允许通过原有静态中间件，但不提供 .html 文件
app.use(express.static(path.join(__dirname, 'webpage'), {
    index: false,
    extensions: ['txt', 'xml', 'ico', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
    maxAge: '5m',
    etag: true,
    lastModified: true
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
    res.status(404).send(JSON.stringify(
        {
            status: 'N',
            "error": "Route not found"
        }
    ));
});

// ---------- 启动服务器 ----------
async function ensureDirs() {
    // const dirs = [SUBMIT_ROOT, COMPILE_ROOT, DATA_ROOT, CHECKER_ROOT, TEMP_UPLOAD];
    // for (const d of dirs) {
    //     await fs.promises.mkdir(d, { recursive: true });
    // }
}

setInterval(async () => {
    await logger.logRuntime('STATS', 'Server periodic health check');
}, 10 * 60 * 1000);

// 未捕获的Promise拒绝处理
process.on('unhandledRejection', (reason, promise) => {
    logger.logError('Unhandled Rejection', reason).catch(e => console.error(e));
});

ensureDirs().then(() => {
    app.listen(appPort, () => {
        console.log(`Server running on http://0.0.0.0:${appPort}`);
    });
});

/*
## 标注汇总

### 需要对接中间件的页面路由（P0）

| 路由 | 标注位置 | 需要的数据 |
|------|---------|-----------|
| `/problem/list` | 替换 `pool.query` | 分页题目列表（id, title） |
| `/problem/me` | 替换 `pool.query` | 当前用户创建的题目列表 |
| `/problem/:id` | 替换 `pool.query` | 完整题目详情 + 作者信息 |
| `/problem/edit/:id` | 替换 `pool.query` | 完整题目详情（编辑用） |
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
| `/problem/:id` | `problem.ejs` | 中间件题目详情 |
| `/problem/edit/:id` | `problem-edit.ejs` | 中间件题目详情 |
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
| `/login` | `login.ejs` | 无数据依赖 |
| `/register` | `register.ejs` | 无数据依赖 |
| `/admin` | `admin.ejs` | 无数据依赖 |

注意：和上一次 commit 之间的所有 diff 都需要进一步 code review！
*/