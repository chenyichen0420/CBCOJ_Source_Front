// 前端管理后台脚本
// 支持动态权限：根据 /api/mypermissions 返回的权限，只显示有权限的管理模块

let currentUserPerms = {};         // 当前登录用户的管理权限
let currentUser = null;            // 当前用户基本信息
let permissionFields = [];         // 所有可配置的权限字段（用于用户管理）

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
        const resp = await fetch(`${BASE_URL}/api/admin/banned-ips?cookie=${cookie}`);
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
                    const resp = await fetch(`${BASE_URL}/api/admin/ban-ip/${encodeURIComponent(ip)}?cookie=${cookie}`, { method: 'DELETE' });
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
                           currentUserPerms.can_manage_contests ||
                           currentUserPerms.can_manage_disk;
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
    if (currentUserPerms.can_manage_disk) {
        const activeClass = (!currentUserPerms.can_manage_users && !currentUserPerms.can_manage_problems && !currentUserPerms.can_manage_contests) ? 'active' : '';
        tabsHtml += `<button class="tab-btn ${activeClass}" data-tab="disk">网盘管理</button>`;
        panesHtml += `
            <div id="disk-pane" class="tab-pane ${activeClass}">
                <h2>网盘文件管理</h2>
                <div class="filter-row">
                    <input type="text" id="diskUsernameFilter" placeholder="按用户名筛选" />
                    <button id="diskFilterBtn" class="btn-sm">搜索</button>
                </div>
                <div id="disk-loading">加载中...</div>
                <div id="disk-table-container"></div>
                <div id="disk-pagination" class="pagination"></div>
            </div>
        `;
    }
    if (currentUser && currentUser.role === 'superadmin') {
        const activeClass = (!currentUserPerms.can_manage_users && !currentUserPerms.can_manage_problems && !currentUserPerms.can_manage_contests && !currentUserPerms.can_manage_disk) ? 'active' : '';
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
    if (currentUserPerms.can_manage_disk) {
        diskUsernameFilter = '';
        loadDiskFiles(1);
    }
    if (currentUser && currentUser.role === 'superadmin') {
        // 绑定封禁相关按钮
        document.getElementById('banip-btn').addEventListener('click', async () => {
            const ip = document.getElementById('banip-input').value.trim();
            const reason = document.getElementById('banip-reason').value.trim();
            if (!ip) { await modalAlert('请输入 IP'); return; }
            const cookie = getcookie();
            try {
                const resp = await fetch(`${BASE_URL}/api/admin/ban-ip?cookie=${cookie}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, reason }) });
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
                const resp = await fetch(`${BASE_URL}/api/admin/clear-ip-logs?cookie=${cookie}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
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
        const url = `${BASE_URL}/api/admin/logs?type=${encodeURIComponent(type)}&page=${page}&limit=${limit}&q=${encodeURIComponent(q)}&cookie=${cookie}`;
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
let allUsersList = []; // 全局缓存用户列表，用于权限弹窗

async function loadUsers() {
    const cookie = getcookie();
    try {
        const resp = await fetch(`${BASE_URL}/api/admin/users?cookie=${cookie}`);
        const data = await resp.json();
        if (data.status !== 'Y') throw new Error(data.error);
        // 动态提取权限字段（除去基本信息）
        if (data.users && data.users.length > 0) {
            const sampleUser = data.users[0];
            permissionFields = Object.keys(sampleUser).filter(key =>
                key.startsWith('can_')
            );
        }
        allUsersList = data.users; // 保存到全局
        renderUsersTable(data.users);
    } catch (err) {
        document.getElementById('users-loading').innerHTML = `<p class="error">加载失败: ${err.message}</p>`;
    }
}

function renderUsersTable(users) {
    document.getElementById('users-loading').style.display = 'none';
    const container = document.getElementById('users-table-container');
    container.style.display = 'block';

    // 分为 管理员 列表 与 普通用户 列表 以便更清晰的管理
    const admins = users.filter(u => u.role === 'admin' || u.role === 'superadmin');
    const normal = users.filter(u => !u.role || (u.role !== 'admin' && u.role !== 'superadmin'));

    const makeTable = (arr) => {
        let html = '<table class="permission-table"><thead><tr><th>ID</th><th>用户名</th><th>角色</th><th>操作</th></tr></thead><tbody>';
        arr.forEach(user => {
            html += '<tr>';
            html += `<td>${user.id}</td>`;
            html += `<td>${escapeHtml(user.username)}${user.badge?` <span class="user-badge" style="background:#333;color:#fff;padding:2px 6px;border-radius:8px;font-size:11px;margin-left:6px;">${escapeHtml(user.badge)}</span>`:''}</td>`;
            html += `<td class="role-cell" data-user-id="${user.id}" data-role="${user.role || 'user'}">${user.role || 'user'}</td>`;
            html += `<td class="action-buttons">
                        <button class="btn-sm btn-warning reset-pwd" data-user="${user.id}" data-username="${escapeAttr(user.username)}" style="width: 20%">重置密码</button>
                        <button class="btn-sm btn-primary manage-perms" data-user-id="${user.id}" style="width: 20%">管理权限</button>`;
            if (currentUser && currentUser.role === 'superadmin') {
                html += ` <button class="btn-sm btn-secondary change-role" data-user="${user.id}" data-current-role="${user.role || 'user'}" style="width: 20%">修改角色</button>`;
                html += ` <button class="btn-sm btn-info edit-badge" data-user-id="${user.id}" style="width: 20%">编辑Badge</button>`;
            }
            html += `</td>`;
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    };

    let html = '';
    html += '<h3>管理员列表</h3>' + (admins.length ? makeTable(admins) : '<p class="text-secondary">暂无管理员</p>');
    html += '<h3 style="margin-top:16px;">普通用户列表</h3>' + (normal.length ? makeTable(normal) : '<p class="text-secondary">暂无普通用户</p>');
    container.innerHTML = html;

    // 重置密码按钮事件（保持不变）
    document.querySelectorAll('.reset-pwd').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const userId = e.target.dataset.user;
            const username = e.target.dataset.username;
            const newPassword = await modalPrompt(`请输入用户 "${username}" 的新密码（至少6位）:`);
            if (!newPassword) return;
            if (newPassword.length < 6) {
                await modalAlert('密码长度至少6位');
                return;
            }
            const confirmPwd = await modalPrompt('请再次输入新密码确认:');
            if (newPassword !== confirmPwd) {
                await modalAlert('两次输入的密码不一致');
                return;
            }
            const cookie = getcookie();
            try {
                const resp = await fetch(`${BASE_URL}/api/admin/user/${userId}/reset-password?cookie=${cookie}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ newPassword })
                });
                const data = await resp.json();
                await modalAlert(data.status === 'Y' ? '密码重置成功' : '重置失败: ' + data.error);
                if (data.status === 'Y') loadUsers();
            } catch (err) {
                await modalAlert('请求失败: ' + err.message);
            }
        });
    });

    // 修改角色按钮事件（保持不变）
    document.querySelectorAll('.change-role').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const userId = e.target.dataset.user;
            const currentRole = e.target.dataset.currentRole;
            const newRole = await modalPrompt(`当前角色: ${currentRole}\n请输入新角色:`, currentRole);
            if (!newRole) return;
            const cookie = getcookie();
            try {
                const resp = await fetch(`${BASE_URL}/api/admin/user/${userId}/role?cookie=${cookie}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: newRole })
                });
                const data = await resp.json();
                await modalAlert(data.status === 'Y' ? '角色修改成功' : '修改失败: ' + data.error);
                if (data.status === 'Y') loadUsers();
            } catch (err) {
                await modalAlert('请求失败: ' + err.message);
            }
        });
    });

    // 新增：管理权限按钮事件
    document.querySelectorAll('.manage-perms').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const userId = parseInt(e.target.dataset.userId);
            manageUserPermissions(userId);
        });
    });

    // 编辑 badge 按钮事件（仅 superadmin 可见）
    document.querySelectorAll('.edit-badge').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const userId = parseInt(e.target.dataset.userId);
            const current = allUsersList.find(u => u.id === userId) || {};
            const badge = await modalPrompt('请输入 badge 文本（留空则清除）:', current.badge || '');
            if (badge === null) return;
            const color = await modalPrompt('名称颜色（CSS 颜色，如 #ff0000，留空使用默认）:', current.name_color || '');
            const cookie = getcookie();
            try {
                const resp = await fetch(`${BASE_URL}/api/admin/user/${userId}/badge?cookie=${cookie}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ badge: badge || null, name_color: color || null })
                });
                const data = await resp.json();
                if (data.status === 'Y') { await modalAlert('更新成功'); loadUsers(); }
                else await modalAlert('更新失败: ' + data.error);
            } catch (err) { await modalAlert('请求失败: ' + err.message); }
        });
    });
}

async function manageUserPermissions(userId) {
    // 从全局缓存中获取该用户数据
    const user = allUsersList.find(u => u.id === userId);
    if (!user) {
        await modalAlert('未找到用户数据，请刷新页面重试');
        return;
    }

    // 如果没有权限字段，尝试重新从列表获取（防御）
    if (!permissionFields.length && allUsersList.length) {
        const sampleUser = allUsersList[0];
        permissionFields = Object.keys(sampleUser).filter(key => key.startsWith('can_'));
    }

    // 构建权限复选框 HTML（网格布局）
    let permsHtml = '';
    permissionFields.forEach(field => {
        const displayName = field.replace(/^can_/, '').replace(/_/g, ' ');
        const isChecked = user[field] == 1;
        permsHtml += `
            <label class="perm-checkbox-label">
                <input type="checkbox" class="perm-checkbox" data-perm="${field}" ${isChecked ? 'checked' : ''}>
                ${displayName}
            </label>
        `;
    });

    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <h3>管理用户权限 - ${escapeHtml(user.username)}</h3>
            <div class="perms-grid">
                ${permsHtml || '<p>未发现可配置权限字段</p>'}
            </div>
            <div class="modal-actions" style="margin-top: 20px;">
                <button class="btn" id="cancel-perms-modal">取消</button>
                <button class="btn btn-primary" id="save-perms-modal">保存权限</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 关闭模态框
    const closeModal = () => {
        if (document.body.contains(modal)) document.body.removeChild(modal);
    };
    document.getElementById('cancel-perms-modal').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // 保存权限
    document.getElementById('save-perms-modal').addEventListener('click', async () => {
        const checkboxes = modal.querySelectorAll('.perm-checkbox');
        const permissions = {};
        checkboxes.forEach(cb => {
            permissions[cb.dataset.perm] = cb.checked ? 1 : 0;
        });

        const cookie = getcookie();
        try {
            const resp = await fetch(`${BASE_URL}/api/admin/user/permissions?cookie=${cookie}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, permissions })
            });
            const data = await resp.json();
            if (data.status === 'Y') {
                await modalAlert('权限更新成功');
                closeModal();
                loadUsers(); // 刷新列表
            } else {
                await modalAlert('更新失败: ' + data.error);
            }
        } catch (err) {
            await modalAlert('请求失败: ' + err.message);
        }
    });
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
                    <button class="btn-sm btn-danger delete-problem" data-id="${p.id}">删除</button>
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
        btn.addEventListener('click', () => editProblem(btn.dataset.id));
    });
    document.querySelectorAll('.delete-problem').forEach(btn => {
        btn.addEventListener('click', () => deleteProblem(btn.dataset.id));
    });
    document.getElementById('add-problem-btn').addEventListener('click', showAddProblemModal);
}

// 题目模态框（新增/编辑）
function showProblemModal(problem = null) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    let formHtml = `
        <div class="modal-content">
            <h3>${problem ? '编辑题目' : '添加题目'}</h3>
            <form id="problem-form">
                <div class="form-group"><label>标题</label><input type="text" name="title" value="${escapeAttr(problem?.title || '')}" required></div>
                <div class="form-row">
                    <div class="form-group"><label>时间限制(ms)</label><input type="number" name="timelimit" min="1" value="${problem?.timelm || 1000}"></div>
                    <div class="form-group"><label>空间限制(KB)</label><input type="number" name="memorylimit" min="1" value="${problem?.memlm || 262144}"></div>
                </div>
                <div class="form-group"><label>背景</label><textarea name="background">${escapeHtml(problem?.background || '')}</textarea></div>
                <div class="form-group"><label>题目描述</label><textarea name="description" required>${escapeHtml(problem?.description || '')}</textarea></div>
                <div class="form-group"><label>输入格式</label><textarea name="inputfmt">${escapeHtml(problem?.inputfmt || '')}</textarea></div>
                <div class="form-group"><label>输出格式</label><textarea name="outputfmt">${escapeHtml(problem?.outputfmt || '')}</textarea></div>
                <div class="form-row">
                    <div class="form-group"><label>样例(JSON数组)</label><input type="text" name="sample" value='${escapeAttr(problem?.sample ? JSON.stringify(problem.sample) : '[]')}'></div>
                </div>
                <div class="form-group"><label>说明提示</label><textarea name="hint">${escapeHtml(problem?.hint || '')}</textarea></div>
                <div class="form-group"><label>难度</label><input type="text" name="difficulty" value="${escapeAttr(problem?.difficulty || '')}"></div>
                ${problem ? `<div>最后更新: ${escapeHtml(problem.time || '—')}；更新者 UID: ${escapeHtml(problem.author || '—')}</div>` : ''}
                ${problem ? `<div class="form-group"><label><input type="checkbox" name="opened" ${problem.opened ? 'checked' : ''}> 公开题目</label></div>` : ''}
                ${problem ? `<div class="form-group"><label>ID</label><span>${escapeHtml(problem.id || '')}</span></div>` : ''}
            </form>
    `;

    if (problem && problem.id) {
        formHtml += `
            <div class="upload-section">
                <h4>📦 测试数据包上传 (.zip)</h4>
                <div class="upload-row">
                    <input type="file" id="dataFileInput" accept=".zip" />
                    <button class="btn-sm btn-primary" id="uploadDataBtn" data-problem-id="${problem.id}">上传数据包</button>
                </div>
                <div class="path-display" id="dataPathDisplay">测试数据上传状态</div>
            </div>
        `;
    } else {
        formHtml += `<div class="upload-section" style="color: var(--text-secondary);">提示: 题目创建成功后，可在编辑界面上传测试数据。</div>`;
    }

    formHtml += `
            <div class="modal-actions">
                <button class="btn" id="cancel-modal">取消</button>
                <button class="btn btn-primary" id="save-problem">保存</button>
            </div>
        </div>
    `;

    modal.innerHTML = formHtml;
    document.body.appendChild(modal);

    const closeModal = () => document.body.removeChild(modal);
    document.getElementById('cancel-modal').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // 保存题目
    document.getElementById('save-problem').addEventListener('click', async () => {
        const form = document.getElementById('problem-form');
        const formData = new FormData(form);
        const data = {};
        formData.forEach((value, key) => {
            if (key === 'sample') {
                try { data[key] = JSON.parse(value); } catch(e) { data[key] = []; }
            } else if (key === 'timelimit' || key === 'memorylimit') {
                data[key] = parseInt(value) || 0;
            } else if (key === 'opened') {
                data[key] = true;
            } else {
                data[key] = value;
            }
        });
        if (problem) data.opened = form.elements.opened.checked ? 1 : 0;

        const cookie = getcookie();
        const url = problem ?
            `${BASE_URL}/api/problem/edit/${problem.id}?cookie=${cookie}` :
            `${BASE_URL}/api/problem?cookie=${cookie}`;
        const method = problem ? 'PUT' : 'POST';

        try {
            const resp = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await resp.json();
            if (result.status === 'Y') {
                await modalAlert('保存成功');
                closeModal();
                loadProblems(currentProblemPage);
            } else {
                await modalAlert('保存失败: ' + result.error);
            }
            } catch (err) {
            await modalAlert('请求失败: ' + err.message);
        }
    });

    if (problem && problem.id) {
        // 上传数据包
        const uploadDataBtn = document.getElementById('uploadDataBtn');
        const dataFileInput = document.getElementById('dataFileInput');
        const dataPathDisplay = document.getElementById('dataPathDisplay');

        uploadDataBtn.addEventListener('click', async () => {
            const file = dataFileInput.files[0];
            if (!file) { await modalAlert('请选择ZIP文件'); return; }
            const formData = new FormData();
            formData.append('file', file);
            const cookie = getcookie();
            const problemId = uploadDataBtn.dataset.problemId;
            uploadDataBtn.disabled = true;
            uploadDataBtn.textContent = '上传中...';
            try {
                const resp = await fetch(`${BASE_URL}/api/admin/problem/${problemId}/upload-data?cookie=${cookie}`, {
                    method: 'POST',
                    body: formData
                });
                const result = await resp.json();
                if (result.status === 'Y') {
                    dataPathDisplay.textContent = `上传成功，共 ${result.file_count} 个文件`;
                    await modalAlert('数据包上传成功');
                } else {
                    await modalAlert('上传失败: ' + (result.error || '未知错误'));
                }
            } catch (err) {
                await modalAlert('请求失败: ' + err.message);
            } finally {
                uploadDataBtn.disabled = false;
                uploadDataBtn.textContent = '上传数据包';
            }
        });

    }
}

function showAddProblemModal() { showProblemModal(); }

async function editProblem(id) {
    const cookie = getcookie();
    try {
        const resp = await fetch(`${BASE_URL}/api/problem/${id}?cookie=${cookie}`);
        const data = await resp.json();
        if (data.status === 'Y') showProblemModal(data);
        else alert('获取题目失败: ' + data.error);
    } catch (err) {
        await modalAlert(err.message);
    }
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
        const resp = await fetch(`${BASE_URL}/api/admin/contests?cookie=${cookie}&page=${page}&limit=${contestLimit}`);
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
            const resp = await fetch(`${BASE_URL}/api/admin/contests/${contest.id}/problems?cookie=${cookie}`);
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
            `${BASE_URL}/api/admin/contests/${contest.id}?cookie=${cookie}` :
            `${BASE_URL}/api/admin/contests?cookie=${cookie}`;
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
        const resp = await fetch(`${BASE_URL}/api/admin/contests/${id}?cookie=${cookie}`);
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
        const resp = await fetch(`${BASE_URL}/api/admin/contests/${id}?cookie=${cookie}`, { method: 'DELETE' });
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

// ===================== 网盘管理 =====================
let currentDiskPage = 1;
const diskLimit = 10;
let diskUsernameFilter = '';

async function loadDiskFiles(page) {
    currentDiskPage = page;
    const cookie = getcookie();
    let url = `${BASE_URL}/api/disk/admin/files?cookie=${cookie}&page=${page}&limit=${diskLimit}`;
    if (diskUsernameFilter) url += `&username=${encodeURIComponent(diskUsernameFilter)}`;
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status !== 'Y') throw new Error(data.error);
        renderDiskTable(data);
    } catch (err) {
        document.getElementById('disk-loading').innerHTML = `<p class="error">加载失败: ${err.message}</p>`;
    }
}

function renderDiskTable(data) {
    document.getElementById('disk-loading').style.display = 'none';
    const container = document.getElementById('disk-table-container');
    container.style.display = 'block';
    let html = `<table class="problem-table"><thead><tr><th>ID</th><th>用户名</th><th>文件名</th><th>大小(MB)</th><th>上传时间</th><th>操作</th></tr></thead><tbody>`;
    for (const f of data.files) {
        const sizeMB = (f.file_size / 1024 / 1024).toFixed(2);
        html += `
            <tr>
                <td>${f.id}</td>
                <td>${escapeHtml(f.username)}</td>
                <td>${escapeHtml(f.filename)}</td>
                <td>${sizeMB}</td>
                <td>${new Date(f.upload_time).toLocaleString()}</td>
                <td>
                    <button class="btn-sm btn-danger" onclick="window.deleteDiskFile(${f.id})">删除</button>
                    <button class="btn-sm" onclick="window.adjustUserQuota(${f.user_id})">调整配额</button>
                </td>
            </tr>
        `;
    }
    html += `</tbody></table>`;
    container.innerHTML = html;

    let paginationHtml = '';
    for (let i = 1; i <= data.totalPages; i++) {
        paginationHtml += `<button class="page-btn ${i === currentDiskPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    document.getElementById('disk-pagination').innerHTML = paginationHtml;
    document.querySelectorAll('#disk-pagination .page-btn').forEach(btn => {
        btn.addEventListener('click', () => loadDiskFiles(parseInt(btn.dataset.page)));
    });
    document.getElementById('diskFilterBtn').addEventListener('click', () => {
        diskUsernameFilter = document.getElementById('diskUsernameFilter').value;
        loadDiskFiles(1);
    });
}

window.deleteDiskFile = async (fileId) => {
    if (!(await modalConfirm('永久删除该文件？'))) return;
    const cookie = getcookie();
    try {
        const resp = await fetch(`${BASE_URL}/api/disk/admin/file/${fileId}?cookie=${cookie}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.status === 'Y') loadDiskFiles(currentDiskPage);
        else await modalAlert('删除失败：' + data.error);
    } catch (err) {
        await modalAlert('请求失败：' + err.message);
    }
};

window.adjustUserQuota = async (userId) => {
    const newQuotaMB = await modalPrompt('请输入新的配额 (MB)', '50');
    if (!newQuotaMB) return;
    const quotaBytes = parseInt(newQuotaMB) * 1024 * 1024;
    const cookie = getcookie();
    try {
        const resp = await fetch(`${BASE_URL}/api/disk/admin/quota/${userId}?cookie=${cookie}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quota: quotaBytes })
        });
        const data = await resp.json();
        if (data.status === 'Y') await modalAlert('配额已更新');
        else await modalAlert('更新失败：' + data.error);
    } catch (err) {
        await modalAlert('请求失败：' + err.message);
    }
};

// 辅助函数：转义HTML
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
        return c;
    });
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
