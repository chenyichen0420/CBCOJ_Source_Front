// 前端管理后台脚本
// 支持动态权限：根据 /api/mypermissions 返回的权限，只显示有权限的管理模块

let currentUserPerms = {};         // 当前登录用户的管理权限
let currentUser = null;            // 当前用户基本信息

// 简易模态对话框（替代原生 prompt/confirm/alert），带模糊背景
function createModal(html) {
	const overlay = document.createElement('div');
	overlay.className = 'copilot-modal-overlay';
	overlay.style.position = 'fixed';
	overlay.style.left = 0; overlay.style.top = 0; overlay.style.right = 0; overlay.style.bottom = 0;
	overlay.style.zIndex = 9999;
	overlay.style.display = 'flex';
	overlay.style.alignItems = 'center';
	overlay.style.justifyContent = 'center';
	overlay.style.backdropFilter = 'blur(4px)';
	overlay.innerHTML = `<div class="copilot-modal" style="padding:16px;border-radius:8px;max-width:90%;min-width:320px;box-shadow:0 6px 24px rgba(0,0,0,0.2)">${html}</div>`;
	document.body.appendChild(overlay);
	return overlay;
}

// 注入模态样式（如未存在）
if (!document.getElementById('copilot-modal-style')) {
	const s = document.createElement('style'); s.id = 'copilot-modal-style';
	s.innerHTML = `
	.copilot-modal-overlay { background: rgba(0,0,0,0.18); }
	.copilot-modal { max-width: 900px; }
	.copilot-modal input { font-size: 14px; }
	`;
	document.head.appendChild(s);
}

// 加载被封禁 IP 列表（superadmin）
async function loadBans() {
	const container = document.getElementById('bans-table-container');
	const loading = document.getElementById('bans-loading');
	loading.textContent = '加载中...';
	container.innerHTML = '';
	try {
		const cookie = getcookie();
		const resp = await fetch(`${BASE_URL}/api/banned-ips?cookie=${cookie}`);
		const data = await resp.json();
		if (data.status !== 'Y') throw new Error(data.error || '查询失败');
		loading.style.display = 'none';
		if (!data.bans || data.bans.length === 0) { container.innerHTML = '<p class="text-secondary">暂无封禁记录</p>'; return; }
		let html = `<table class="problem-table"><thead><tr><th>IP</th><th>原因</th><th>封禁时间</th><th>操作</th></tr></thead><tbody>`;
		data.bans.forEach(b => {
			html += `<tr><td>${escapeHtml(b.ip_address)}</td><td>${escapeHtml(b.reason||'')}</td><td>${new Date(b.created_at).toLocaleString()}</td><td><button class="btn-sm btn-danger" data-ip="${escapeAttr(b.ip_address)}">解除封禁</button></td></tr>`;
		});
		html += '</tbody></table>';
		container.innerHTML = html;
		container.querySelectorAll('button[data-ip]').forEach(btn => {
			btn.addEventListener('click', async () => {
				const ip = btn.dataset.ip;
				if (!(await modalConfirm('确定解除封禁 ' + ip + ' ?'))) return;
				const cookie = getcookie();
				try {
					const resp = await fetch(`${BASE_URL}/api/ban-ip/${encodeURIComponent(ip)}?cookie=${cookie}`, { method: 'DELETE' });
					const j = await resp.json();
					if (j.status === 'Y') { await modalAlert('已解除封禁'); loadBans(); } else await modalAlert('解除失败: ' + (j.error||''));
				} catch (e) { await modalAlert('请求失败: ' + e.message); }
			});
		});
	} catch (err) {
		loading.textContent = '加载失败: ' + err.message;
	}
}

function modalAlert(msg) {
	return new Promise(resolve => {
		const overlay = createModal(`<div style="margin-bottom:12px">${escapeHtml(msg)}</div><div style="text-align:right"><button id="copilot-ok">确定</button></div>`);
		overlay.querySelector('#copilot-ok').addEventListener('click', () => { document.body.removeChild(overlay); resolve(); });
	});
}

function modalConfirm(msg) {
	return new Promise(resolve => {
		const overlay = createModal(`<div style="margin-bottom:12px">${escapeHtml(msg)}</div><div style="text-align:right;display:flex;gap:8px;justify-content:flex-end"><button id="copilot-cancel">取消</button><button id="copilot-ok">确定</button></div>`);
		overlay.querySelector('#copilot-cancel').addEventListener('click', () => { document.body.removeChild(overlay); resolve(false); });
		overlay.querySelector('#copilot-ok').addEventListener('click', () => { document.body.removeChild(overlay); resolve(true); });
	});
}

function modalPrompt(msg, defaultVal) {
	return new Promise(resolve => {
		const overlay = createModal(`<div style="margin-bottom:8px">${escapeHtml(msg)}</div><input id="copilot-input" style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:8px" value="${defaultVal ? escapeHtml(defaultVal) : ''}" /><div style="text-align:right;display:flex;gap:8px;justify-content:flex-end"><button id="copilot-cancel">取消</button><button id="copilot-ok">确定</button></div>`);
		overlay.querySelector('#copilot-cancel').addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
		overlay.querySelector('#copilot-ok').addEventListener('click', () => { const v = overlay.querySelector('#copilot-input').value; document.body.removeChild(overlay); resolve(v); });
		setTimeout(() => { const inp = overlay.querySelector('#copilot-input'); if (inp) inp.focus(); }, 50);
	});
}

// 页面加载时检查登录和权限
document.addEventListener('DOMContentLoaded', async () => {
	if (!(await checkLogin())) {
		window.location.href = '/login';
		return;
	}
	await initAdmin();
});

// 获取当前用户的所有管理权限
async function getMyPermissions() {
	const cookie = getcookie();
	if (!cookie) return {};
	try {
		const resp = await fetch(`${BASE_URL}/api/mypermissions?cookie=${cookie}`);
		const data = await resp.json();
		if (data.status === 'Y') return data.permissions;
		return {};
	} catch (err) {
		console.error('获取权限失败', err);
		return {};
	}
}

// 检查是否为管理员（兼容旧版，实际以权限为准）
async function checkAdmin() {
	const cookie = getcookie();
	if (!cookie) {
		document.getElementById('admin-content').innerHTML = '<p class="error">请先登录</p>';
		return false;
	}
	try {
		// 获取用户基本信息
		const infoResp = await fetch(`${BASE_URL}/api/getinfoshort?key=${cookie}`);
		const infoData = await infoResp.json();
		if (infoData.status !== 'Y') throw new Error('获取用户信息失败');
		currentUser = infoData;

		// 获取权限
		currentUserPerms = await getMyPermissions();

		const hasAnyPerm = currentUserPerms.can_manage_users ||
						   currentUserPerms.can_manage_problems ||
						   currentUserPerms.can_manage_contests;
		if (!hasAnyPerm) {
			document.getElementById('admin-content').innerHTML = '<p class="error">您没有任何管理权限</p>';
			return false;
		}

		// 准备权限字段列表（用于用户管理页面显示复选框）
		// 从后端获取用户列表时动态填充 permissionFields
		return true;
	} catch (err) {
		document.getElementById('admin-content').innerHTML = `<p class="error">${err.message}</p>`;
		return false;
	}
}

// 初始化管理界面（根据权限动态生成选项卡）
async function initAdmin() {
	const isValid = await checkAdmin();
	if (!isValid) return;
	renderAdminUI();
}

// 渲染管理界面
function renderAdminUI() {
	const container = document.getElementById('admin-content');
	let tabsHtml = '<div class="admin-tabs">';
	let panesHtml = '';

	if (currentUserPerms.can_manage_users) {
		tabsHtml += '<button class="tab-btn active" data-tab="users">用户管理</button>';
		panesHtml += `
			<div id="users-pane" class="tab-pane active">
				<h2>用户权限管理</h2>
				<div id="users-loading">加载用户列表...</div>
				<div id="users-table-container" style="display:none;"></div>
			</div>
		`;
	}
	if (currentUserPerms.can_manage_problems) {
		const activeClass = !currentUserPerms.can_manage_users ? 'active' : '';
		tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="problems">题目管理</button>`;
		panesHtml += `
			<div id="problems-pane" class="tab-pane ${activeClass}">
				<h2>题目管理</h2>
				<button class="btn" id="add-problem-btn">+ 添加题目</button>
				<div id="problems-loading">加载题目列表...</div>
				<div id="problems-table-container" style="display:none;"></div>
				<div id="problems-pagination" class="pagination"></div>
			</div>
		`;
	}
	if (currentUserPerms.can_manage_contests) {
		const activeClass = (!currentUserPerms.can_manage_users && !currentUserPerms.can_manage_problems) ? 'active' : '';
		tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="contests">比赛管理</button>`;
		panesHtml += `
			<div id="contests-pane" class="tab-pane ${activeClass}">
				<h2>比赛管理</h2>
				<button class="btn" id="add-contest-btn">+ 创建比赛</button>
				<div id="contests-loading">加载比赛列表...</div>
				<div id="contests-table-container" style="display:none;"></div>
				<div id="contests-pagination" class="pagination"></div>
			</div>
		`;
	}
	if (currentUser && currentUser.role === 'superadmin') {
		const activeClass = (!currentUserPerms.can_manage_users && !currentUserPerms.can_manage_problems && !currentUserPerms.can_manage_contests) ? 'active' : '';
		tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="bans">封禁管理</button>`;
		tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="logs">系统日志</button>`;
		panesHtml += `
			<div id="bans-pane" class="tab-pane ${activeClass}">
				<h2>封禁 IP 管理</h2>
				<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
					<input type="text" id="banip-input" placeholder="IP 地址" />
					<input type="text" id="banip-reason" placeholder="原因 (可选)" />
					<button id="banip-btn" class="btn-sm">封禁</button>
					<button id="refresh-bans" class="btn-sm">刷新列表</button>
				</div>
				<div id="bans-loading">加载中...</div>
				<div id="bans-table-container"></div>
			</div>
			<div id="logs-pane" class="tab-pane ${activeClass}">
				<h2>系统日志</h2>
				<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">
					<select id="logs-type-select"><option value="access">访问</option><option value="security">安全</option><option value="runtime">运行</option></select>
					<input type="text" id="logs-search" placeholder="关键字、用户名、URL 等" style="flex:1;min-width:200px;" />
					<input type="text" id="logs-ip-clear" placeholder="按 IP 清除日志" style="width:160px;" />
					<button id="logs-clear-ip-btn" class="btn-sm">清除该 IP 日志</button>
					<button id="logs-search-btn" class="btn-sm">查询</button>
					<select id="logs-limit-select"><option>25</option><option selected>50</option><option>100</option></select>
				</div>
				<div id="logs-loading">请输入查询条件或直接点击查询</div>
				<div id="logs-table-container"></div>
				<div id="logs-pagination" class="pagination"></div>
			</div>
		`;
	}

	tabsHtml += '</div>';
	container.innerHTML = tabsHtml + panesHtml;

	// 绑定选项卡切换事件
	document.querySelectorAll('.tab-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
			btn.classList.add('active');
			document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
			document.getElementById(btn.dataset.tab + '-pane').classList.add('active');
		});
	});

	// 加载各个模块的数据
	if (currentUserPerms.can_manage_users) loadUsers();
	if (currentUserPerms.can_manage_problems) loadProblems(1);
	if (currentUserPerms.can_manage_contests) loadContests(1);
	if (currentUser && currentUser.role === 'superadmin') {
		// 绑定封禁相关按钮
		document.getElementById('banip-btn').addEventListener('click', async () => {
			const ip = document.getElementById('banip-input').value.trim();
			const reason = document.getElementById('banip-reason').value.trim();
			if (!ip) { await modalAlert('请输入 IP'); return; }
			const cookie = getcookie();
			try {
				const resp = await fetch(`${BASE_URL}/api/ban-ip?cookie=${cookie}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, reason }) });
				const j = await resp.json();
				if (j.status === 'Y') { await modalAlert('封禁成功'); loadBans(); } else await modalAlert('封禁失败: ' + (j.error||''));
			} catch (e) { await modalAlert('请求失败: ' + e.message); }
		});
		document.getElementById('refresh-bans').addEventListener('click', () => loadBans());
		// logs pane 清除 ip 按钮
		document.getElementById('logs-clear-ip-btn').addEventListener('click', async () => {
			const ip = document.getElementById('logs-ip-clear').value.trim();
			if (!ip) { await modalAlert('请输入 IP'); return; }
			if (!(await modalConfirm('确定清除该 IP 的访问记录吗？此操作将删除访问与安全日志')) ) return;
			const cookie = getcookie();
			try {
				const resp = await fetch(`${BASE_URL}/api/clear-ip-logs?cookie=${cookie}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
				const j = await resp.json();
				if (j.status === 'Y') await modalAlert('已删除条目数: ' + (j.deleted||0)); else await modalAlert('删除失败: ' + (j.error||''));
			} catch (e) { await modalAlert('请求失败: ' + e.message); }
		});
		loadBans();
		// 绑定查询按钮
		document.getElementById('logs-search-btn').addEventListener('click', () => loadLogs(1));
		document.getElementById('logs-type-select').addEventListener('change', () => loadLogs(1));
		document.getElementById('logs-limit-select').addEventListener('change', () => loadLogs(1));
		loadLogs(1);
	}
}

// 加载系统日志（仅 superadmin）
async function loadLogs(page) {
	page = page || 1;
	const type = document.getElementById('logs-type-select').value || 'access';
	const q = document.getElementById('logs-search').value || '';
	const limit = parseInt(document.getElementById('logs-limit-select').value) || 50;
	const container = document.getElementById('logs-table-container');
	const loading = document.getElementById('logs-loading');
	loading.textContent = '查询中...';
	container.innerHTML = '';
	try {
		const cookie = getcookie();
		const url = `${BASE_URL}/api/logs?type=${encodeURIComponent(type)}&page=${page}&limit=${limit}&q=${encodeURIComponent(q)}&cookie=${cookie}`;
		const resp = await fetch(url);
		const data = await resp.json();
		if (data.status !== 'Y') throw new Error(data.error || '查询失败');
		loading.style.display = 'none';
		if (!data.logs || data.logs.length === 0) {
			container.innerHTML = '<p class="text-secondary">没有匹配的日志</p>';
			document.getElementById('logs-pagination').innerHTML = '';
			return;
		}
		let html = '';
		if (data.type === 'access') {
			html += `<table class="problem-table"><thead><tr><th>ID</th><th>时间</th><th>用户</th><th>IP</th><th>方法</th><th>URL</th><th>状态</th><th>响应(ms)</th></tr></thead><tbody>`;
			data.logs.forEach(l => {
				html += `<tr><td>${l.id}</td><td>${new Date(l.created_at).toLocaleString()}</td><td>${escapeHtml(l.username || '')}</td><td>${escapeHtml(l.ip_address)}</td><td>${l.method}</td><td>${escapeHtml(l.url)}</td><td>${l.status_code}</td><td>${l.response_time_ms}</td></tr>`;
			});
			html += '</tbody></table>';
		} else if (data.type === 'security') {
			html += `<table class="problem-table"><thead><tr><th>ID</th><th>时间</th><th>用户</th><th>IP</th><th>动作</th><th>目标</th><th>详情</th></tr></thead><tbody>`;
			data.logs.forEach(l => {
				html += `<tr><td>${l.id}</td><td>${new Date(l.created_at).toLocaleString()}</td><td>${escapeHtml(l.username || '')}</td><td>${escapeHtml(l.ip_address)}</td><td>${escapeHtml(l.action)}</td><td>${escapeHtml(l.target || '')}</td><td>${escapeHtml(l.details || '')}</td></tr>`;
			});
			html += '</tbody></table>';
		} else if (data.type === 'runtime') {
			html += `<table class="problem-table"><thead><tr><th>ID</th><th>时间</th><th>类型</th><th>消息</th><th>CPU(%)</th><th>内存(MB)</th><th>运行秒数</th></tr></thead><tbody>`;
			data.logs.forEach(l => {
				html += `<tr><td>${l.id}</td><td>${new Date(l.created_at).toLocaleString()}</td><td>${escapeHtml(l.log_type)}</td><td>${escapeHtml(l.message || '')}</td><td>${l.cpu_usage || ''}</td><td>${l.memory_usage_mb || ''}</td><td>${l.uptime_seconds || ''}</td></tr>`;
			});
			html += '</tbody></table>';
		}
		container.innerHTML = html;

		// 分页 (折叠显示：只显示第一页，当前页前后5页，以及最后一页)
		const total = data.total || 0;
		const totalPages = Math.max(1, Math.ceil(total / limit));
		const pagesSet = new Set();
		pagesSet.add(1);
		pagesSet.add(totalPages);
		for (let i = Math.max(1, page - 5); i <= Math.min(totalPages, page + 5); i++) pagesSet.add(i);
		const pagesArr = Array.from(pagesSet).sort((a,b)=>a-b);
		let paginationHtml = '';
		let lastAdded = 0;
		for (const pnum of pagesArr) {
			if (lastAdded && pnum - lastAdded > 1) paginationHtml += `<span class="ellipsis">...</span>`;
			paginationHtml += `<button class="page-btn ${pnum === page ? 'active' : ''}" data-page="${pnum}">${pnum}</button>`;
			lastAdded = pnum;
		}
		document.getElementById('logs-pagination').innerHTML = paginationHtml;
		document.querySelectorAll('#logs-pagination .page-btn').forEach(btn => btn.addEventListener('click', () => loadLogs(parseInt(btn.dataset.page))));
	} catch (err) {
		loading.textContent = '查询失败: ' + err.message;
		container.innerHTML = '';
	}
}

// ===================== 用户管理 =====================
let currentUserPage = 1;
const userLimit = 10;
const permissionFields = [
	{ key: 'ADMIN_USER', label: '用户管理', kind: 'admin' },
	{ key: 'ADMIN_PROBLEM', label: '题目管理', kind: 'admin' },
	{ key: 'ADMIN_CONTEST', label: '比赛管理', kind: 'admin' },
	{ key: 'ADMIN_CHAT', label: '聊天管理', kind: 'admin' },
	{ key: 'ADMIN_ARTICLE', label: '文章管理', kind: 'admin' },
	{ key: 'LOCK_NO_SUBMIT', label: '禁止提交', kind: 'lock' },
	{ key: 'LOCK_NO_DISCUSSION', label: '禁止讨论', kind: 'lock' },
	{ key: 'LOCK_NO_CHAT', label: '禁止聊天', kind: 'lock' },
	{ key: 'LOCK_NO_VIEW_RECORD', label: '禁止查看他人评测', kind: 'lock' },
	{ key: 'LOCK_NO_OPEN_RECORD', label: '禁止公开评测', kind: 'lock' },
	{ key: 'LOCK_USER_BANNED', label: '封禁用户', kind: 'ban' }
];
const userApi = (id, action = '') => `${BASE_URL}/api/user/${id}${action ? `/${action}` : ''}`;

async function loadUsers(page = 1) {
	currentUserPage = page;
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/users?cookie=${cookie}&page=${page}`);
		const data = await resp.json();
		if (!resp.ok || data.status !== 'Y') throw new Error(data.error || `用户列表请求失败 (${resp.status})`);
		renderUsersTable(data.users, data.totalPages, data.page);
	} catch (err) {
		console.error('loadUsers failed:', err);
		document.getElementById('users-loading').innerHTML = `<p class="error">加载失败: ${escapeHtml(err.message)}</p>`;
	}
}

function renderUsersTable(users, totalPages, page) {
	document.getElementById('users-loading').style.display = 'none';
	const container = document.getElementById('users-table-container');
	container.style.display = 'block';
	let html = '<div style="overflow-x:auto"><table class="permission-table"><thead><tr><th>ID</th><th>用户名</th><th>角色</th>';
	permissionFields.forEach(field => { html += `<th>${field.label}</th>`; });
	html += '</tr></thead><tbody>';
	users.forEach(user => {
		html += `<tr data-user-id="${user.id}"><td class="user-id">${user.id}</td><td class="user-name">${escapeHtml(user.username)}</td><td class="user-role">${escapeHtml(user.role || 'user')}</td>`;
		permissionFields.forEach(field => {
			const canEdit = field.kind === 'admin' || field.kind === 'ban'
				? currentUser && currentUser.role === 'superadmin'
				: true;
			const checked = user.permissions && user.permissions[field.key] ? ' checked' : '';
			html += `<td><input type="checkbox" class="user-permission" data-user-id="${user.id}" data-permission="${field.key}"${checked}${canEdit ? '' : ' disabled'}></td>`;
		});
		html += '</tr>';
	});
	html += '</tbody></table></div><div id="users-pagination" class="pagination">';
	for (let i = 1; i <= totalPages; i++) {
		html += `<button class="page-btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
	}
	html += '</div>';
	container.innerHTML = html;
	document.querySelectorAll('#users-pagination .page-btn').forEach(btn => {
		btn.addEventListener('click', () => loadUsers(parseInt(btn.dataset.page, 10)));
	});
	document.querySelectorAll('.user-permission').forEach(checkbox => {
		checkbox.addEventListener('change', () => updateUserPermission(checkbox));
	});
}

async function refreshUserInfo(userId) {
	const resp = await fetch(`${userApi(userId)}?cookie=${getcookie()}`);
	const data = await resp.json();
	if (!resp.ok || data.status !== 'Y' || !data.user) {
		throw new Error(data.error || `用户信息刷新失败 (${resp.status})`);
	}
	const row = document.querySelector(`tr[data-user-id="${CSS.escape(String(userId))}"]`);
	if (!row) return;
	row.querySelector('.user-name').textContent = data.user.username;
	row.querySelector('.user-role').textContent = data.user.role || 'user';
	row.querySelectorAll('.user-permission').forEach(checkbox => {
		checkbox.checked = !!data.user.permissions?.[checkbox.dataset.permission];
	});
}

async function updateUserPermission(checkbox) {
	const previous = !checkbox.checked;
	checkbox.disabled = true;
	const permission = checkbox.dataset.permission;
	const endpoint = permission === 'LOCK_USER_BANNED' ? 'ban' :
		permission.startsWith('ADMIN_') ? 'adjadmin' : 'adjperm';
	try {
		const resp = await fetch(`${userApi(checkbox.dataset.userId, endpoint)}?cookie=${getcookie()}`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ permission, value: checkbox.checked ? 1 : 0 })
		});
		const data = await resp.json();
		if (data.status !== 'Y') throw new Error(data.error || '权限更新失败');
		await refreshUserInfo(checkbox.dataset.userId);
	} catch (err) {
		checkbox.checked = previous;
		await modalAlert(err.message);
	} finally {
		checkbox.disabled = false;
	}
}

// ===================== 题目管理 =====================
let currentProblemPage = 1;
const problemLimit = 10;

async function loadProblems(page) {
	currentProblemPage = page;
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/problems?cookie=${cookie}&page=${page}&limit=${problemLimit}`);
		const data = await resp.json();
		if (data.status !== 'Y') throw new Error(data.error);
		renderProblemsTable(data.problems, data.totalPages);
	} catch (err) {
		document.getElementById('problems-loading').innerHTML = `<p class="error">加载失败: ${err.message}</p>`;
	}
}

function renderProblemsTable(problems, totalPages) {
	document.getElementById('problems-loading').style.display = 'none';
	const container = document.getElementById('problems-table-container');
	container.style.display = 'block';

	let html = `
		<table class="problem-table">
			<thead><tr><th>ID</th><th>标题</th><th>时间(ms)</th><th>内存(KB)</th><th>操作</th></tr></thead>
			<tbody>
	`;
	problems.forEach(p => {
		html += `
			<tr>
				<td>${p.id}</td>
				<td>${escapeHtml(p.title)}</td>
				<td>${p.timelm}</td>
				<td>${p.memlm}</td>
				<td class="problem-actions">
					<button class="btn-sm btn-primary edit-problem" data-id="${p.id}">编辑</button>
					<!-- <button class="btn-sm btn-danger delete-problem" data-id="${p.id}">删除</button> -->
				</td>
			</tr>
		`;
	});
	html += '</tbody></table>';
	container.innerHTML = html;

	// 分页
	let paginationHtml = '';
	for (let i = 1; i <= totalPages; i++) {
		paginationHtml += `<button class="page-btn ${i === currentProblemPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
	}
	document.getElementById('problems-pagination').innerHTML = paginationHtml;
	document.querySelectorAll('#problems-pagination .page-btn').forEach(btn => {
		btn.addEventListener('click', () => loadProblems(parseInt(btn.dataset.page)));
	});

	// 编辑/删除按钮
	document.querySelectorAll('.edit-problem').forEach(btn => {
		btn.addEventListener('click', () => {
			window.location.href = `/problem/edit/${encodeURIComponent(btn.dataset.id)}`;
		});
	});
	document.querySelectorAll('.delete-problem').forEach(btn => {
		btn.addEventListener('click', () => deleteProblem(btn.dataset.id));
	});
	document.getElementById('add-problem-btn').addEventListener('click', showAddProblemModal);
}

async function deleteProblem(id) {
	if (!(await modalConfirm('确定删除该题目吗？'))) return;
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/problem/${id}?cookie=${cookie}`, { method: 'DELETE' });
		const data = await resp.json();
		if (data.status === 'Y') {
			await modalAlert('删除成功');
			loadProblems(currentProblemPage);
		} else {
			await modalAlert('删除失败: ' + data.error);
		}
	} catch (err) {
		await modalAlert('请求失败: ' + err.message);
	}
}

// ===================== 比赛管理 =====================
let currentContestPage = 1;
const contestLimit = 10;

async function loadContests(page) {
	currentContestPage = page;
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/contests?cookie=${cookie}&page=${page}&limit=${contestLimit}`);
		const data = await resp.json();
		if (data.status !== 'Y') throw new Error(data.error);
		renderContestsTable(data.contests, data.totalPages);
	} catch (err) {
		document.getElementById('contests-loading').innerHTML = `<p class="error">加载失败: ${err.message}</p>`;
	}
}

function renderContestsTable(contests, totalPages) {
	document.getElementById('contests-loading').style.display = 'none';
	const container = document.getElementById('contests-table-container');
	container.style.display = 'block';

	let html = `
		<table class="contest-table">
			<thead><tr><th>ID</th><th>标题</th><th>开始时间</th><th>结束时间</th><th>操作</th></tr></thead>
			<tbody>
	`;
	contests.forEach(c => {
		html += `
			<tr>
				<td>${c.id}</td>
				<td>${escapeHtml(c.title)}</td>
				<td>${new Date(c.start_time).toLocaleString()}</td>
				<td>${new Date(c.end_time).toLocaleString()}</td>
				<td class="contest-actions">
					<button class="btn-sm btn-primary edit-contest" data-id="${c.id}">编辑</button>
					<button class="btn-sm btn-danger delete-contest" data-id="${c.id}">删除</button>
				</td>
			</tr>
		`;
	});
	html += '</tbody></table>';
	container.innerHTML = html;

	let paginationHtml = '';
	for (let i = 1; i <= totalPages; i++) {
		paginationHtml += `<button class="page-btn ${i === currentContestPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
	}
	document.getElementById('contests-pagination').innerHTML = paginationHtml;
	document.querySelectorAll('#contests-pagination .page-btn').forEach(btn => {
		btn.addEventListener('click', () => loadContests(parseInt(btn.dataset.page)));
	});

	document.querySelectorAll('.edit-contest').forEach(btn => {
		btn.addEventListener('click', () => editContest(btn.dataset.id));
	});
	document.querySelectorAll('.delete-contest').forEach(btn => {
		btn.addEventListener('click', () => deleteContest(btn.dataset.id));
	});
	document.getElementById('add-contest-btn').addEventListener('click', showAddContestModal);
}

async function getAllProblems() {
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/problems/all?cookie=${cookie}`);
		const data = await resp.json();
		if (data.status === 'Y') return data.problems;
		return [];
	} catch (err) {
		console.error('获取题目列表失败', err);
		return [];
	}
}

async function showContestModal(contest = null) {
	const allProblems = await getAllProblems();
	const modal = document.createElement('div');
	modal.className = 'modal';
	const startTime = contest ? new Date(contest.start_time).toISOString().slice(0, 16) : '';
	const endTime = contest ? new Date(contest.end_time).toISOString().slice(0, 16) : '';

	let selectedProblemIds = [];
	if (contest && contest.id) {
		const cookie = getcookie();
		try {
			const resp = await fetch(`${BASE_URL}/api/contests/${contest.id}/problems?cookie=${cookie}`);
			const data = await resp.json();
			if (data.status === 'Y') selectedProblemIds = data.problem_ids;
		} catch (e) {}
	}

	let problemsHtml = '';
	allProblems.forEach(p => {
		const checked = selectedProblemIds.includes(p.id) ? 'checked' : '';
		problemsHtml += `<label><input type="checkbox" name="problem_ids" value="${p.id}" ${checked}> ${escapeHtml(p.id)} - ${escapeHtml(p.title)}</label><br>`;
	});

	modal.innerHTML = `
		<div class="modal-content">
			<h3>${contest ? '编辑比赛' : '创建比赛'}</h3>
			<form id="contest-form">
				<div class="form-group"><label>标题</label><input type="text" name="title" value="${escapeAttr(contest?.title || '')}" required></div>
				<div class="form-group"><label>简介 (Markdown)</label><textarea name="description" rows="5">${escapeHtml(contest?.description || '')}</textarea></div>
				<div class="form-row">
					<div class="form-group"><label>开始时间</label><input type="datetime-local" name="start_time" value="${startTime}" required></div>
					<div class="form-group"><label>结束时间</label><input type="datetime-local" name="end_time" value="${endTime}" required></div>
				</div>
				<div class="form-group">
					<label>题目选择</label>
					<div class="select-problems">
						${problemsHtml}
					</div>
				</div>
			</form>
			<div class="modal-actions">
				<button class="btn" id="cancel-modal">取消</button>
				<button class="btn btn-primary" id="save-contest">保存</button>
			</div>
		</div>
	`;

	document.body.appendChild(modal);
	const closeModal = () => document.body.removeChild(modal);
	document.getElementById('cancel-modal').addEventListener('click', closeModal);
	modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

	document.getElementById('save-contest').addEventListener('click', async () => {
		const form = document.getElementById('contest-form');
		const formData = new FormData(form);
		const data = {
			title: formData.get('title'),
			description: formData.get('description'),
			start_time: formData.get('start_time'),
			end_time: formData.get('end_time'),
			problem_ids: Array.from(form.querySelectorAll('input[name="problem_ids"]:checked')).map(cb => parseInt(cb.value))
		};
		if (!data.title || !data.start_time || !data.end_time || data.problem_ids.length === 0) {
			alert('请填写完整信息并至少选择一道题目');
			return;
		}
		const cookie = getcookie();
		const url = contest ?
			`${BASE_URL}/api/contests/${contest.id}?cookie=${cookie}` :
			`${BASE_URL}/api/contests?cookie=${cookie}`;
		const method = contest ? 'PUT' : 'POST';
		try {
			const resp = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data)
			});
			const result = await resp.json();
			if (result.status === 'Y') {
				alert('保存成功');
				closeModal();
				loadContests(currentContestPage);
			} else {
				alert('保存失败: ' + result.error);
			}
		} catch (err) {
			alert('请求失败: ' + err.message);
		}
	});
}

function showAddContestModal() { showContestModal(); }

async function editContest(id) {
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/contests/${id}?cookie=${cookie}`);
		const data = await resp.json();
		if (data.status === 'Y') showContestModal(data);
		else alert('获取比赛失败: ' + data.error);
	} catch (err) {
		alert(err.message);
	}
}

async function deleteContest(id) {
	if (!(await modalConfirm('确定删除该比赛吗？'))) return;
	const cookie = getcookie();
	try {
		const resp = await fetch(`${BASE_URL}/api/contests/${id}?cookie=${cookie}`, { method: 'DELETE' });
		const data = await resp.json();
		if (data.status === 'Y') {
			await modalAlert('删除成功');
			loadContests(currentContestPage);
		} else {
			await modalAlert('删除失败: ' + data.error);
		}
	} catch (err) {
		await modalAlert('请求失败: ' + err.message);
	}
}

// 辅助函数：转义HTML
function escapeHtml(str) {
	if (str === undefined || str === null) return '';
	return String(str).replace(/[&<>]/g, function(m) {
		if (m === '&') return '&amp;';
		if (m === '<') return '&lt;';
		if (m === '>') return '&gt;';
		return m;
	}).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
		return c;
	});
}

function escapeAttr(str) {
	if (str === undefined || str === null) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}