const express = require('express');
// const sentemail = require('./email.js');
const router = express.Router();
const { packParams, parsePack } = require('../db');
const pool = require('../db');
const crypto = require('crypto');
const { getUserByCookie, requireLogin, getUserPermissions, currentNonce, verifyNonce, tryAcquireNonceSlot, SLOT_SECONDS, ALLOWED_PAST_SLOTS } = require('../auth');
const logger = require('../logger');
const multer = require('multer');
const { validateInt, validateString, contentLengthGuard } = require('../validation');

const MAX_FORM_BODY_BYTES = 128 * 1024;
const MAX_AVATAR_URL_LENGTH = 512;
const upload = multer({
	limits: {
		fieldSize: MAX_FORM_BODY_BYTES,
		fields: 16,
		files: 0,
		parts: 17
	}
});

function validateAvatarUrl(value) {
	const valueErr = validateString(value, { minLen: 1, maxLen: MAX_AVATAR_URL_LENGTH });
	if (valueErr) return valueErr;
	if (/[\u0000-\u0020\u007f]/.test(value)) return '头像 URL 不能包含空白或控制字符';
	try {
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
			url.username || url.password || url.href.length > MAX_AVATAR_URL_LENGTH) {
			return '头像 URL 必须是有效的 HTTP(S) 图片地址';
		}
	} catch (_) {
		return '头像 URL 必须是有效的 HTTP(S) 图片地址';
	}
	return null;
}

// 获取当前用户的所有权限
router.get('/mypermissions', requireLogin, async (req, res) => {
	const perms = await getUserPermissions(req.user.id);
	res.json({ status: 'Y', permissions: perms });
});

// ---------- 获取登录挑战：nonce + uid（客户端据此自行算 salt） ----------
router.get('/login', async (req, res) => {
	const username = req.query.username;
	const unErr = validateString(username, { minLen: 1, maxLen: 100 });
	if (unErr) return res.status(400).json({ status: 'N', error: `username: ${unErr}` });

	if (!tryAcquireNonceSlot(username)) {
		return res.status(429).json({ status: 'N', error: '请求过于频繁，请稍后再试' });
	}

	let uid = null;
	try {
		const conn = pool.getAccount();
		const resp = await conn.send('U', packParams(['username', username, 'uid']));
		if (resp.command === 'Y') {
			const parts = parsePack(resp.data);
			if (parts.length >= 1) {
				const n = parseInt(parts[0].toString('utf8'), 10);
				if (Number.isInteger(n) && n >= 0) uid = n;
			}
		}
	} catch (err) {
		logger.logError(`login nonce: uid lookup failed: ${err.message}`, err);
	}
	if (uid === null) uid = crypto.randomInt(0, 2 ** 31);  // 防枚举

	res.json({
		status: 'Y',
		nonce: currentNonce(),
		uid,
		expiresIn: (ALLOWED_PAST_SLOTS + 1) * SLOT_SECONDS,
	});
});

// ---------- 实际登录（POST，凭据不进 URL） ----------
router.post('/login', async (req, res) => {
	const ip = logger.getClientIp(req);
	const { username, nonce, argonval } = req.body || {};

	const unErr = validateString(username, { minLen: 1, maxLen: 100 });
	const nErr  = validateString(nonce,    { minLen: 3, maxLen: 80 });
	const aErr  = validateString(argonval, { minLen: 40, maxLen: 60 });
	if (unErr || nErr || aErr)
		return res.status(400).json({ status: 'N', error: 'Invalid request' });

	if (verifyNonce(nonce) === null) {
		await logger.logSecurity(null, null, ip, 'login_fail', null, 'Bad nonce');
		return res.json({ status: 'N', error: '登录失败' });
	}

	let argonBytes;
	try { argonBytes = Buffer.from(argonval, 'base64'); }
	catch { return res.status(400).json({ status: 'N', error: 'Invalid request' }); }
	if (argonBytes.length !== 32)
		return res.status(400).json({ status: 'N', error: 'Invalid request' });

	const fast = crypto.createHash('sha256').update(argonBytes).digest();

	try {
		const conn = pool.getAccount();
		const resp = await conn.send('L', packParams([username, fast]));
		const parts = parsePack(resp.data);
		if (resp.command === 'Y') {
			await logger.logSecurity(null, username, ip, 'login_success');
			return res.json({ status: 'Y', cookie: parts[0].toString('utf8') });
		}
		await logger.logSecurity(null, username, ip, 'login_fail', null, 'Middleware rejected');
		return res.json({ status: 'N', error: '用户名或密码错误' });
	} catch (err) {
		logger.logError(`login failed: ${err.message}`, err);
		await logger.logSecurity(null, username, ip, 'login_fail', null, 'Middleware error');
		return res.json({ status: 'N', error: '登录失败' });
	}
});

// ---------- 验证 cookie ----------
router.get('/verifycookie', async (req, res) => {
	const cookie = req.userCookie;
	const cErr = validateString(cookie, { minLen: 1, maxLen: 200 });
	if (cErr) return res.json({ status: 'N' });
	try {
		const user = await getUserByCookie(cookie);
		res.json({ status: user ? 'Y' : 'N' });
	} catch (err) {
		res.json({ status: 'N' });
	}
});

// ---------- 获取用户信息 ----------
router.get('/getinfoshort', async (req, res) => {
	const key = req.query.key;
	const keyErr = validateString(key, { minLen: 1, maxLen: 200 });
	if (keyErr) return res.json({ status: 'N', error: `key: ${keyErr}` });

	try {
		const conn = pool.getAccount();
		const data = packParams(['any', key, 'uid', 'username', 'pubcode', 'slogan', 'role', 'badge', 'name_color']);
		const resp = await conn.send('U', data);
		if (resp.command !== 'Y') {
			return res.json({ status: 'N', error: 'User not found' });
		}
		const parts = parsePack(resp.data);
		if (parts.length < 7) {
			return res.json({ status: 'N', error: 'Invalid response from middleware' });
		}
		const uid = parseInt(parts[0].toString('utf8'));
		const iderr = validateInt(parts[0].toString('utf8'), { positive: false, min: 0, max: 2147483647 });
		if (iderr) {
			return res.json({ status: 'N', error: 'Invalid uid in response' });
		}
		// 处理字段：pubcode 为 "yes"/"no"，badge/name_color 可能为空字符串（转为 null 或保留）
		const pubcode = parts[2].toString('utf8') || '';
		const slogan = parts[3].toString('utf8') || '';
		const role = parts[4].toString('utf8') || 'user';
		const badge = parts[5].toString('utf8') || null;
		const name_color = parts[6].toString('utf8') || null;
		res.json({
			status: 'Y',
			uid,
			username: parts[1].toString('utf8'),
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
router.post('/updinfoshort', requireLogin, contentLengthGuard(MAX_FORM_BODY_BYTES), upload.none(), async (req, res) => {
	const { usrname, old_argonval, new_argonval, publiccode, slogan } = req.body;
	const user = req.user;
	const ip = logger.getClientIp(req);
	const unErr = validateString(usrname, { minLen: 1, maxLen: 100 });
	if (unErr) return res.json({ status: 'N', error: `usrname: ${unErr}` });
	if (publiccode !== undefined && publiccode !== null) {
		if (publiccode !== 'yes' && publiccode !== 'no')
			return res.json({ status: 'N', error: "publiccode must be 'yes' or 'no'" });
	}
	if (slogan !== undefined && slogan !== null) {
		const slErr = validateString(slogan, { minLen: 0, maxLen: 200 });
		if (slErr) return res.json({ status: 'N', error: `slogan: ${slErr}` });
	}
	let oldPasswordHash;
	let newPasswordHash;
	if (old_argonval !== undefined || new_argonval !== undefined) {
		const decodeArgonHash = value => {
			if (typeof value !== 'string' || value.length !== 44) return null;
			const decoded = Buffer.from(value, 'base64');
			return decoded.length === 32 && decoded.toString('base64') === value ? decoded : null;
		};
		const oldArgonHash = decodeArgonHash(old_argonval);
		const newArgonHash = decodeArgonHash(new_argonval);
		if (!oldArgonHash || !newArgonHash)
			return res.status(400).json({ status: 'N', error: '密码校验数据无效，请刷新页面后重试' });
		oldPasswordHash = crypto.createHash('sha256').update(oldArgonHash).digest();
		newPasswordHash = crypto.createHash('sha256').update(newArgonHash).digest();
	}

	let cookie = req.userCookie;
	const usernameChanged = usrname !== user.username;
	const args = [cookie];
	if (usernameChanged) args.push('username', usrname);
	if (publiccode !== undefined && publiccode !== null) args.push('pubcode', publiccode);
	if (oldPasswordHash && newPasswordHash) args.push('password', oldPasswordHash, newPasswordHash);
	if (slogan !== undefined && slogan !== null) args.push('slogan', slogan);
	if (args.length === 1) return res.json({ status: 'Y' });

	try {
		const conn = pool.getAccount();
		const data = packParams(args);
		const resp = await conn.send('C', data);
		const parts = parsePack(resp.data);

		if (resp.command !== 'Y') {
			const rawErr = parts.length > 0 ? parts[0].toString('utf8') : '';
			await logger.logSecurity(user.id, user.username, ip, 'update_info_fail', null, `${rawErr}`);
			return res.json({ status: 'N', error: rawErr });
		}
		await logger.logSecurity(user.id, user.username, ip, 'update_info_success');
		const result = { status: 'Y' };
		return res.json(result);
	} catch (err) {
		await logger.logSecurity(user.id, user.username, ip, 'update_info_fail', null, err.message);
		return res.json({ status: 'N', error: err.message });
	}
});

const reglasttime = new Map();

router.post('/genregtoken', async (req, res) => {
	const { username, lguid } = req.body || {};
	const unErr = validateString(username, { minLen: 1, maxLen: 16, pattern: /^[A-Za-z0-9]+$/ });
	const uidErr = validateInt(lguid, { min: 1, max: (1 << 23) - 1 });
	if (unErr || uidErr) return res.status(400).json({ status: 'N', error: unErr ? `username: ${unErr}` : `Luogu UID: ${uidErr}` });
	if (!/[A-Za-z]/.test(username)) return res.status(400).json({ status: 'N', error: '用户名必须至少包含一个英文字母' });

	const ip = logger.getClientIp(req);
	const now = Date.now();
	const lastRequest = reglasttime.get(ip) || 0;
	if (now - lastRequest < 60_000) {
		return res.status(429).json({
			status: 'N',
			error: `请求过于频繁，请在 ${Math.ceil((60_000 - (now - lastRequest)) / 1000)} 秒后重试`
		});
	}
	for (const [key, timestamp] of reglasttime) {
		if (now - timestamp > 60 * 60_000) reglasttime.delete(key);
	}
	if (!reglasttime.has(ip) && reglasttime.size >= 10_000)
		reglasttime.delete(reglasttime.keys().next().value);
	reglasttime.set(ip, now);

	try {
		const conn = pool.getAccount();
		const response = await conn.send('P', packParams([username, String(lguid)]));
		const parts = parsePack(response.data);
		if (response.command !== 'Y' || parts.length < 3) {
			const error = parts[0] ? parts[0].toString('utf8') : '无法创建注册申请';
			return res.json({ status: 'N', error });
		}
		const token = parts[0].toString('utf8');
		const code = parts[1].toString('utf8');
		const recipientUid = parts[2].toString('utf8');
		if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{16}$/.test(code) ||
			!/^[1-9]\d*$/.test(recipientUid) || Number(recipientUid) >= (1 << 23))
			return res.status(502).json({ status: 'N', error: '注册服务返回了无效挑战信息' });
		return res.json({
			status: 'Y',
			token,
			code,
			recipientUid
		});
	} catch (error) {
		logger.logError(`registration challenge failed: ${error.message}`, error);
		return res.status(503).json({ status: 'N', error: '注册服务暂不可用' });
	}
});

router.post('/setregpassword', async (req, res) => {
	const { token, argonval } = req.body || {};
	const tokenErr = validateString(token, { minLen: 64, maxLen: 64, pattern: /^[a-f0-9]{64}$/ });
	const hashErr = validateString(argonval, { minLen: 44, maxLen: 44 });
	if (tokenErr || hashErr) return res.status(400).json({ status: 'N', error: 'Invalid registration request' });

	const argonHash = Buffer.from(argonval, 'base64');
	if (argonHash.length !== 32 || argonHash.toString('base64') !== argonval)
		return res.status(400).json({ status: 'N', error: 'Invalid password hash' });
	const passwordHash = crypto.createHash('sha256').update(argonHash).digest();
	try {
		const conn = pool.getAccount();
		const response = await conn.send('W', packParams([token, passwordHash]));
		const parts = parsePack(response.data);
		if (response.command !== 'Y') {
			const stateResponse = await conn.send('V', packParams([token]));
			const stateParts = parsePack(stateResponse.data);
			if (stateResponse.command === 'Y' &&
				stateParts[0] && stateParts[0].toString('utf8') === 'COMPLETED')
				return res.json({ status: 'Y' });
			return res.json({ status: 'N', error: parts[0] ? parts[0].toString('utf8') : '无法保存密码' });
		}
		return res.json({ status: 'Y' });
	} catch (error) {
		logger.logError(`registration password setup failed: ${error.message}`, error);
		return res.status(503).json({ status: 'N', error: '注册服务暂不可用' });
	}
});

router.post('/verifycode', async (req, res) => {
	const { token } = req.body || {};
	const tokenErr = validateString(token, { minLen: 64, maxLen: 64, pattern: /^[a-f0-9]{64}$/ });
	if (tokenErr) return res.status(400).json({ status: 'N', error: 'Invalid registration token' });

	try {
		const conn = pool.getAccount();
		const response = await conn.send('V', packParams([token]));
		const parts = parsePack(response.data);
		if (response.command !== 'Y') {
			const error = parts[0] ? parts[0].toString('utf8') : '注册校验失败';
			return res.json({ status: 'N', error });
		}
		const state = parts[0] ? parts[0].toString('utf8') : '';
		if (state === 'PENDING') return res.json({ status: 'P', message: '等待下一轮 Luogu 私信检查' });
		if (state === 'FAILED') return res.json({ status: 'N', error: '私信验证码不匹配或注册申请已失效' });
		if (state === 'COMPLETED') return res.json({ status: 'Y' });
		if (state !== 'VERIFIED' || parts.length < 2)
			return res.json({ status: 'N', error: '无效的注册校验状态' });
		const accountUid = Number(parts[1].toString('utf8'));
		if (!Number.isSafeInteger(accountUid) || accountUid < 0)
			return res.status(502).json({ status: 'N', error: '注册服务返回了无效账号编号' });
		return res.json({ status: 'V', accountUid });
	} catch (error) {
		logger.logError(`registration verification failed: ${error.message}`, error);
		return res.status(503).json({ status: 'N', error: '注册校验服务暂不可用' });
	}
});

// 导出在文件末尾（在附加路由之后）

// 文件上传头像已永久禁用；头像仅允许使用安全校验后的外链 URL 或首字母 SVG。
router.post('/upload-avatar', requireLogin, (req, res) =>
	res.status(410).json({ status: 'N', error: '头像文件上传已禁用，请改为设置 HTTP(S) 图片 URL' }));

/*
 * Avatar URL middleware contract (not implemented in the current middleware):
 * GET /api/avatar-url/:username
 *   middleware input: U command, ['username', username, 'avatar_url']
 *   web response: { status: 'Y', avatar_url: string | null }
 * POST /api/avatar-url
 *   web request: { avatar_url: string } (empty string clears the custom avatar)
 *   middleware input: C command, [cookie, 'avatar_url', avatar_url]
 *   middleware response: Y on persistence, otherwise N + an error string
 * URLs must be <= 512 characters and validated as HTTP(S) without credentials.
 */
router.get('/avatar-url/:username', requireLogin, (req, res) => {
	const usernameErr = validateString(req.params.username, { minLen: 1, maxLen: 100 });
	if (usernameErr) return res.status(400).json({ status: 'N', error: `username: ${usernameErr}` });
	return res.status(501).json({ status: 'N', error: '头像 URL 查询尚未接入中间件' });
});

router.post('/avatar-url', requireLogin, (req, res) => {
	const { avatar_url: avatarUrl } = req.body || {};
	if (typeof avatarUrl !== 'string')
		return res.status(400).json({ status: 'N', error: 'avatar_url 必须为字符串' });
	if (avatarUrl !== '') {
		const urlErr = validateAvatarUrl(avatarUrl);
		if (urlErr) return res.status(400).json({ status: 'N', error: urlErr });
	}
	return res.status(501).json({ status: 'N', error: '头像 URL 保存尚未接入中间件' });
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

// 无自定义头像时始终返回动态首字母 SVG；外链头像由浏览器端安全加载。
router.get('/avatar/:username', async (req, res) => {
	const username = req.params.username;
	const initial = (username && username[0]) ? username[0].toUpperCase() : '?';
	const svg = generateBlueBackgroundCharSVG(initial, { width: 80, height: 80 });
	res.setHeader('Content-Type', 'image/svg+xml');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.send(svg);
});

module.exports = router;

/*
Other account routes already talk to the account middleware:
`/login`, `/verifycookie`, `/getinfoshort`, `/updinfoshort`,
`/genregtoken`, `/setregpassword`, and `/verifycode`.
`/avatar/:username` only emits the escaped first-letter SVG.
`/avatar-url/:username` and POST `/avatar-url` are intentionally 501 until the
middleware adds the `avatar_url` field described in the contract above.
*/