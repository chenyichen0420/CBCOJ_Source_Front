const express = require('express');
// const sentemail = require('./email.js');
const router = express.Router();
const { packParams, parsePack } = require('../db');
const { getUserByCookie, requireLogin, requireAdmin, getUserPermissions } = require('../auth');
const logger = require('../logger');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');
const { DATA_ROOT, CHECKER_ROOT } = require('../config');
const { validateInt, validateString, validateEmail, validateBoolean } = require('../validation');

function generateCookie() {
    return crypto.randomBytes(32).toString('hex');
}

// 获取当前用户的所有权限
router.get('/mypermissions', requireLogin, async (req, res) => {
    const perms = await getUserPermissions(req.user.id);
    res.json({ status: 'Y', permissions: perms });
});

// ---------- 登录 ----------
router.get('/login', async (req, res) => {
    const username = req.query.username, password = req.query.password;
    const ip = logger.getClientIp(req);
    const unErr = validateString(username, { minLen: 1, maxLen: 100 });
    if (unErr) {
        await logger.logSecurity(null, null, ip, 'login_fail', null, 'Missing credentials');
        return res.json({ status: 'N', error: `username: ${unErr}` });
    }
    const pwErr = validateString(password, { minLen: 1, maxLen: 100 });
    if (pwErr) {
        await logger.logSecurity(null, null, ip, 'login_fail', null, 'Missing credentials');
        return res.json({ status: 'N', error: `password: ${pwErr}` });
    }
    try {
        const cookie = await pool.login(username, password);  // db.js 已实现 login
        await logger.logSecurity(null, username, ip, 'login_success');
        res.json({ status: 'Y', cookie });
    } catch (err) {
        await logger.logSecurity(null, username, ip, 'login_fail', null, err.message);
        res.json({ status: 'N', error: err.message });
    }
});

// ---------- 验证 cookie ----------
router.get('/verifycookie', async (req, res) => {
    const cookie = req.query.cookie;
    const cErr = validateString(cookie, { minLen: 1, maxLen: 200 });
    if (cErr) return res.json({ status: 'N' });
    try {
        const user = await getUserByCookie(cookie);
        res.json({ status: user ? 'Y' : 'N' });
    } catch {
        res.json({ status: 'N' });
    }
});

// ---------- 获取用户信息（支持 username / uid） ----------
router.get('/getinfoshort', async (req, res) => {
    const key = req.query.key;
    const keyErr = validateString(key, { minLen: 1, maxLen: 200 });
    if (keyErr) return res.json({ status: 'N', error: `key: ${keyErr}` });

    try {
        const conn = pool.getAccount();
        // 使用中间件 'U' 指令的 'any' 类型，自动识别 key 为 uid 或 username
        const data = packParams(['any', key, 'uid', 'username', 'pubcode', 'slogan', 'role', 'badge', 'name_color']);
        const resp = await conn.send('U', data);
        if (resp.command !== 'Y') {
            return res.json({ status: 'N', error: 'User not found' });
        }
        const parts = parsePack(resp.data);
        if (parts.length < 8) {
            return res.json({ status: 'N', error: 'Invalid response from middleware' });
        }
        const uid = parseInt(parts[0]);
        if (isNaN(uid)) {
            return res.json({ status: 'N', error: 'Invalid uid in response' });
        }
        // 处理字段：pubcode 为 "yes"/"no"，badge/name_color 可能为空字符串（转为 null 或保留）
        const pubcode = parts[2] || '';
        const slogan = parts[3] || '';
        const role = parts[4] || 'user';
        const badge = parts[5] || null;
        const name_color = parts[6] || null;
        res.json({
            status: 'Y',
            uid,
            username: parts[1],
            pubcode,
            slogan,
            role,
            badge,
            name_color
        });
    } catch (err) {
        logger.logError(`getinfoshort failed for key ${key}: ${err.message}`, err);
        res.json({ status: 'N', error: 'Database error' });
    }
});

// 更新个人信息
router.post('/updinfoshort', requireLogin, upload.none(), async (req, res) => {
    const { usrname, paswd, old_paswd, publiccode, slogan } = req.body;
    const user = req.user;
    const ip = logger.getClientIp(req);
    // 校验必填字段
    const unErr = validateString(usrname, { minLen: 1, maxLen: 100 });
    if (unErr) return res.json({ status: 'N', error: `usrname: ${unErr}` });
    if (publiccode !== undefined && publiccode !== null) {
        const pcErr = validateString(publiccode, { minLen: 0, maxLen: 10 });
        if (pcErr) return res.json({ status: 'N', error: `publiccode: ${pcErr}` });
    }
    if (slogan !== undefined && slogan !== null) {
        const slErr = validateString(slogan, { minLen: 0, maxLen: 200 });
        if (slErr) return res.json({ status: 'N', error: `slogan: ${slErr}` });
    }
    if (paswd && paswd.length > 100) {
        return res.json({ status: 'N', error: '密码长度不能超过100位' });
    }
    /*
    DB Interface, waiting for implement

    Input: usrname (string, required), paswd (string, optional), old_paswd (string, required if changing password),
            publiccode (string, optional), slogan (string, optional), user (from auth)
    Output: { status: 'Y' } | { status: 'N', error: string }

    Expected middleware behavior:
    - If paswd provided: verify old_paswd matches current password
    - Update username, password (if provided), publiccode, slogan
    - Return success or error
    - On username change: frontend expects avatar files to be renamed (handled separately in this file)
    */
});

var reglasttime = {};

// 生成注册验证码
router.get('/genregtoken', async (req, res) => {
    const { email, username, password } = req.query;
    const emErr = validateEmail(email);
    if (emErr) return res.json({ status: 'N', error: `email: ${emErr}` });
    const unErr = validateString(username, { minLen: 1, maxLen: 100 });
    if (unErr) return res.json({ status: 'N', error: `username: ${unErr}` });
    const pwErr = validateString(password, { minLen: 1, maxLen: 100 });
    if (pwErr) return res.json({ status: 'N', error: `password: ${pwErr}` });
    
    if (Date.now() / 1000 - reglasttime[req.ip] < 60) {
       return res.json({ status: 'N', error: `too fast. please wait for at least ${60 - (Date.now() / 1000 - reglasttime[req.ip])} seconds`});
    }
    
    reglasttime[req.ip] = Date.now() / 1000;
    
    /*
    DB Interface, waiting for implement

    Input: email (string), username (string), password (string)
    Output: { status: 'Y', token: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Check if email already registered → return error if exists
    - Generate a random 8-digit verification code
    - Generate a token (for later verification)
    - Store (email, username, password, token, code) temporarily (expires after 30 min)
    - The actual email sending is done by the separate email module (call sentemail.sentRegisterToken)
    - Return token to client
    */
});

// 验证注册码并创建用户
router.get('/verifycode', async (req, res) => {
    const { code, token } = req.query;
    const ip = logger.getClientIp(req);
    const codeErr = validateString(code, { minLen: 1, maxLen: 50 });
    if (codeErr) return res.json({ status: 'N', error: `code: ${codeErr}` });
    const tkErr = validateString(token, { minLen: 1, maxLen: 100 });
    if (tkErr) return res.json({ status: 'N', error: `token: ${tkErr}` });

    /*
    DB Interface, waiting for implement

    Input: code (string, 8-digit), token (string)
    Output: { status: 'Y' } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify token + code match a pending registration record
    - Check if username already exists → return error
    - Create new user account with provided username/password/email
    - Generate cookie for the new user
    - Delete the pending registration record
    - Log the registration (security log)
    - Return success
    */
});

// 导出在文件末尾（在附加路由之后）

// 头像上传
router.post('/upload-avatar', requireLogin, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.json({ status: 'N', error: 'Missing file' });
        const username = req.user.username;
        const ext = (req.file.mimetype || '').split('/').pop() || 'png';
        const avatarDir = path.join(__dirname, '..', 'webpage', 'assets', 'avatars');
        await fs.promises.mkdir(avatarDir, { recursive: true });
        const filename = `${username}.${ext}`;
        const filepath = path.join(avatarDir, filename);
        await fs.promises.writeFile(filepath, req.file.buffer);
        return res.json({ status: 'Y', url: `/assets/avatars/${encodeURIComponent(filename)}` });
    } catch (err) {
        console.error('avatar upload error', err);
        return res.json({ status: 'N', error: '保存失败' });
    }
});

/**
 * 生成一个蓝色背景、白色字符的SVG HTML代码
 * @param {string} char - 要显示的Unicode字符（如果传入多个字符，只取第一个）
 * @param {Object} options - 可选配置项
 * @param {number} options.width - SVG宽度（像素），默认200
 * @param {number} options.height - SVG高度（像素），默认200
 * @param {string} options.bgColor - 背景颜色（CSS颜色），默认'#2196F3'（蓝色）
 * @param {string} options.textColor - 文字颜色，默认'#FFFFFF'（白色）
 * @param {number} options.relativeFontSize - 相对于100x100坐标系的字体大小，默认70
 * @param {string} options.fontFamily - 字体族，已包含emoji支持
 * @returns {string} 完整的SVG HTML代码
 * @throws {Error} 当char参数无效时抛出错误
 */
function generateBlueBackgroundCharSVG(char, options = {}) {
    // 参数校验
    if (typeof char !== 'string' || char.length === 0) {
        throw new Error('必须提供一个有效的字符');
    }

    // 只取第一个字符（符合"一个字符"的要求）
    const singleChar = char.charAt(0);
    
    // XML特殊字符转义（防止注入，提升安全性）
    const escapeXml = (unsafe) => {
        if (!unsafe) return '';
        return unsafe.replace(/[<>&'"]/g, (c) => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
                default: return c;
            }
        });
    };
    const escapedChar = escapeXml(singleChar);

    // 合并默认配置
    const {
        width = 200,
        height = 200,
        bgColor = '#2196F3',   // 明亮的蓝色
        textColor = '#FFFFFF',
        relativeFontSize = 70, // 在100x100坐标系中的字体大小（适配大多数字符）
        fontFamily = "Arial, Helvetica, sans-serif, 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'",
        borderRadius = 12
    } = options;

    // 使用固定100x100的viewBox，确保文字居中逻辑简单且缩放友好
    const viewBoxSize = 100;
    // 计算圆角半径（相对于viewBox，且不超过viewBox尺寸的一半）
    const rx = Math.min(borderRadius * (viewBoxSize / Math.max(width, height)), viewBoxSize / 2);
    
    // 生成SVG字符串
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}">
  <rect width="100%" height="100%" fill="${bgColor}" rx="${rx}" ry="${rx}" />
  <text x="50%" y="50%" fill="${textColor}" font-size="${relativeFontSize}" font-family="${fontFamily}" text-anchor="middle" dominant-baseline="central">${escapedChar}</text>
</svg>`;
}

// 返回头像（如果有则直接返回静态文件，否则返回动态 SVG）
router.get('/avatar/:username', async (req, res) => {
    const username = req.params.username;
    const unErr = validateString(username, { minLen: 1, maxLen: 100 });
    if (unErr) return res.status(400).json({ status: 'N', error: `username: ${unErr}` });
    const avatarDir = path.join(__dirname, '..', 'webpage', 'assets', 'avatars');
    const tryExt = ['png','jpg','jpeg','webp','gif'];
    for (const e of tryExt) {
        const p = path.join(avatarDir, `${username}.${e}`);
        if (fs.existsSync(p)) return res.sendFile(p);
    }
    // 返回动态 SVG
    const initial = (username && username[0]) ? username[0].toUpperCase() : '?';
    const svg = generateBlueBackgroundCharSVG(initial, { width: 80, height: 80 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

// 用户新建题目（默认不公开 opened=0，selected=0），入口在题目列表
router.post('/problem/new', requireLogin, upload.none(), async (req, res) => {
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

router.post('/problem/:id/upload-data', requireLogin, uploadZipUser.single('file'), async (req, res) => {
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

// 用户上传 checker（仅题目作者或有权限的用户），要求 .cpp
const uploadCheckerUser = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fs.mkdirSync(CHECKER_ROOT, { recursive: true });
            cb(null, CHECKER_ROOT);
        },
        filename: (req, file, cb) => {
            const safeName = `${req.params.id}-${file.originalname}`;
            cb(null, safeName);
        }
    })
});

router.post('/problem/:id/upload-checker', requireLogin, uploadCheckerUser.single('file'), async (req, res) => {
    const problemId = req.params.id;
    const idErr = validateInt(problemId, { positive: true });
    if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
    const file = req.file;
    if (!file) return res.status(400).json({ status: 'N', error: '未选择文件' });
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.cpp') { fs.unlinkSync(file.path); return res.status(400).json({ status: 'N', error: '只允许上传 .cpp 文件' }); }
    /*
    DB Interface, waiting for implement

    Input: problemId (int), file (multipart .cpp), user (from auth)
    Output: { status: 'Y', message: string, checker_path: string } | { status: 'N', error: string }

    Expected middleware behavior:
    - Verify user has permission (author or admin)
    - Compile the .cpp file with g++ (requires testlib.h)
    - Store compiled checker in CHECKER_ROOT
    - Update problem's checker_path field
    - Return success with checker_path
    */
});

// 作者或管理员编辑题目
router.post('/problem/edit', requireLogin, upload.none(), async (req, res) => {
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

以下是在 `user.js` 中标注的数据库通信接口：

| 路由 | 方法 | 标注位置 | 说明 |
|------|------|---------|------|
| `/login` | GET | 替换原 `pool.query` | 用户名密码验证 → 返回 cookie |
| `/verifycookie` | GET | 替换原 `pool.query` | Cookie 有效性验证 |
| `/getinfoshort` | GET | 替换原 `pool.query` | 多方式用户信息查询 |
| `/updinfoshort` | POST | 替换原 `pool.query` | 更新用户个人信息 |
| `/genregtoken` | GET | 替换原 `pool.query` | 预注册 + 验证码生成 |
| `/verifycode` | GET | 替换原 `pool.query` | 验证码验证 + 用户创建 |
| `/problem/new` | POST | 替换原 `pool.query` | 创建新题目 |
| `/problem/:id/upload-data` | POST | 替换原 `pool.query` | 上传题目数据包 |
| `/problem/:id/upload-checker` | POST | 替换原 `pool.query` | 上传并编译检查器 |
| `/problem/edit` | POST | 替换原 `pool.query` | 编辑题目 |

**未标注的接口**（保持不变）：
- `/mypermissions` — 调用 `auth.getUserPermissions`，与数据库无关
- `/upload-avatar` — 纯文件操作
- `/avatar/:username` — 纯文件操作
*/