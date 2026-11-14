const express = require('express');
const router = express.Router();
const { requirePermission } = require('../auth');
const { validateInt, validateString } = require('../validation');

const ARTICLE_TYPES = new Set(['solution', 'other']);
const MAX_ARTICLE_CONTENT_LENGTH = 100_000;

/*
 * Article API contract for the future middleware adapter:
 *
 * GET /api/articles?page=&page_size=
 *   input: page (1-based), page_size (1..50)
 *   output: { status:'Y', articles:[ArticleSummary], page, total, total_pages }
 *   Return only public type="other" articles; this is the article plaza.
 *   All JSON API routes require can_manage_articles, like problem management APIs.
 *
 * GET /api/articles/:id
 *   input: id
 *   output: { status:'Y', article:Article }
 *   Article = { id,title,type,is_public,problem_id,problem_title,author:{id,username},
 *               updated_at,content }. This JSON API requires can_manage_articles.
 *   The public webpage must load public content through its server-side page route.
 *
 * POST /api/articles and PUT /api/articles/:id
 *   input JSON: { title,type,is_public,problem_id,content }
 *   type is "solution" or "other"; problem_id is required only for "solution".
 *   content is UTF-8 Markdown (the adapter may persist it as Base64).
 *   output: { status:'Y', id } for create, { status:'Y', article } for update.
 *   The adapter must enforce author/permission checks and validate the referenced
 *   problem; only public articles are visible to other logged-in users.
 *
 * GET /api/problems/:id/solutions
 *   input: problem id
 *   output: { status:'Y', solutions:[ArticleSummary] }, visible solutions only.
 *
 * These endpoints intentionally return 501 until the middleware supports article
 * storage. Public webpage routes must use server-side data loading, not these
 * admin-only JSON endpoints.
 */
function middlewareUnavailable(res) {
	return res.status(501).json({ status: 'N', error: '文章服务尚未接入中间件' });
}

function validArticleId(value) {
	return validateInt(value, { positive: true, min: 1, max: 2147483647 });
}

function validateArticleInput(body) {
	const titleErr = validateString(body.title, { minLen: 1, maxLen: 200 });
	if (titleErr) return `title: ${titleErr}`;
	if (!ARTICLE_TYPES.has(body.type)) return 'type 必须为 solution 或 other';
	if (typeof body.is_public !== 'boolean') return 'is_public 必须为布尔值';
	const contentErr = validateString(body.content, { minLen: 0, maxLen: MAX_ARTICLE_CONTENT_LENGTH });
	if (contentErr) return `content: ${contentErr}`;
	if (body.type === 'solution') {
		const problemErr = validArticleId(body.problem_id);
		if (problemErr) return `problem_id: ${problemErr}`;
	} else if (body.problem_id !== null && body.problem_id !== undefined && body.problem_id !== '') {
		return 'other 类型文章不能关联题目';
	}
	return null;
}

router.get('/articles', requirePermission('can_manage_articles'), (req, res) => {
	const page = req.query.page === undefined ? 1 : Number(req.query.page);
	const pageSize = req.query.page_size === undefined ? 20 : Number(req.query.page_size);
	if (validArticleId(page)) return res.status(400).json({ status: 'N', error: 'page 必须是正整数' });
	if (validArticleId(pageSize) || pageSize > 50)
		return res.status(400).json({ status: 'N', error: 'page_size 必须为 1-50' });
	return middlewareUnavailable(res);
});

router.get('/articles/:id', requirePermission('can_manage_articles'), (req, res) => {
	const idErr = validArticleId(req.params.id);
	if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
	return middlewareUnavailable(res);
});

router.post('/articles', requirePermission('can_manage_articles'), (req, res) => {
	const inputErr = validateArticleInput(req.body || {});
	if (inputErr) return res.status(400).json({ status: 'N', error: inputErr });
	return middlewareUnavailable(res);
});

router.put('/articles/:id', requirePermission('can_manage_articles'), (req, res) => {
	const idErr = validArticleId(req.params.id);
	if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
	const inputErr = validateArticleInput(req.body || {});
	if (inputErr) return res.status(400).json({ status: 'N', error: inputErr });
	return middlewareUnavailable(res);
});

router.get('/problems/:id/solutions', requirePermission('can_manage_articles'), (req, res) => {
	const idErr = validArticleId(req.params.id);
	if (idErr) return res.status(400).json({ status: 'N', error: `id: ${idErr}` });
	return middlewareUnavailable(res);
});

module.exports = router;
