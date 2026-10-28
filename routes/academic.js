const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireLogin, requireAdmin, requirePermission, checkPermission } = require('../auth');
const multer = require('multer');
const { TextDecoder } = require('util');
const logger = require('../logger');
const upload = multer();
const { validateInt, validateString } = require('../validation');

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

module.exports = router;