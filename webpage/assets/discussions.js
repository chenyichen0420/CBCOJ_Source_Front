// ================== 初始化与登录检查 ==================
checkLogin();

document.addEventListener("DOMContentLoaded", async (e) => {
    if (!(await checkLogin())) {
        window.location.href = '/login';
    }
});

// ================== 直接 UTF-8 ⇄ Base64 编解码（无额外膨胀） ==================
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUtf8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

// ================== HTML 转义（用于标题和作者名） ==================
function escapeHtml(unsafe) {
    return unsafe.replace(/[&<>"]/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        if (m === '"') return '&quot;';
        return m;
    });
}

// ================== 分页相关变量 ==================
let currentPage = 1;
let totalPages = 1;
const perPage = 10;

// ================== 获取讨论列表（支持分页） ==================
async function getdiscussionlist(page = 1) {
    const DiscussionList = document.getElementById('discussion-list');
    const paginationDiv = document.getElementById('pagination');

    try {
        // 请求时带上 page 和 perpage
        const response = await fetch(BASE_URL + `/api/getdisclist?cookie=${getcookie()}&page=${page}&perpage=${perPage}`);
        const data = await response.json();

        if (data.status !== 'Y') {
            DiscussionList.innerHTML = `<p>加载讨论列表失败：${data.error}</p>`;
            paginationDiv.style.display = 'none';
            return;
        }

        // 解析讨论数据（假设 data.data 是 JSON 字符串）
        const discussions = JSON.parse(data.data);

        // 处理总页数（假设后端返回 total 字段）
        const total = data.total || 0;
        totalPages = Math.ceil(total / perPage);
        currentPage = page;

        if (discussions.length === 0) {
            DiscussionList.innerHTML = '<p>暂无讨论</p>';
            paginationDiv.style.display = 'none';
            return;
        }

        // 清空原有内容
        DiscussionList.innerHTML = '';

        // 遍历每个讨论项
        for (const item of discussions) {
            const title = base64ToUtf8(item.title) || '无标题';
            const author = (await getusername(item.uid)) || '未知用户';
            const time = new Date(item.time * 1000).toLocaleString();

            const discussionItem = document.createElement('div');
            discussionItem.className = 'discussion-item card';
            discussionItem.innerHTML = `
                <div class="discussion-header">
                    <span class="discussion-author">${escapeHtml(author)}</span>
                    <span class="discussion-date">${time}</span>
                </div>
                <h4 class="discussion-title">
                    <a href="/discussion-detail/${item.cid || item.id}">${escapeHtml(title)}</a>
                </h4>
            `;
            DiscussionList.appendChild(discussionItem);
        }

        // 显示分页控件并渲染
        paginationDiv.style.display = 'block';
        renderPagination();
    } catch (error) {
        console.error('加载讨论列表失败:', error);
        document.getElementById('discussion-list').innerHTML = '<p>网络错误，无法加载讨论列表</p>';
        paginationDiv.style.display = 'none';
    }
}

// ================== 渲染分页控件 ==================
function renderPagination() {
    const paginationDiv = document.getElementById('pagination');
    if (!paginationDiv) return;

    // 清空原有内容
    paginationDiv.innerHTML = '';

    // 上一页按钮
    const prevLink = document.createElement('a');
    prevLink.href = '#';
    prevLink.textContent = '上一页';
    prevLink.className = currentPage === 1 ? 'disabled' : '';
    prevLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (currentPage > 1) {
            getdiscussionlist(currentPage - 1);
        }
    });
    paginationDiv.appendChild(prevLink);

    // 页码按钮（最多显示 5 个，可根据需要调整）
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageLink = document.createElement('a');
        pageLink.href = '#';
        pageLink.textContent = i;
        if (i === currentPage) {
            pageLink.className = 'active';
        }
        pageLink.addEventListener('click', (e) => {
            e.preventDefault();
            if (i !== currentPage) {
                getdiscussionlist(i);
            }
        });
        paginationDiv.appendChild(pageLink);
    }

    // 下一页按钮
    const nextLink = document.createElement('a');
    nextLink.href = '#';
    nextLink.textContent = '下一页';
    nextLink.className = currentPage === totalPages ? 'disabled' : '';
    nextLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (currentPage < totalPages) {
            getdiscussionlist(currentPage + 1);
        }
    });
    paginationDiv.appendChild(nextLink);
}

// 初始加载第一页
getdiscussionlist(1);

// ================== 发布新讨论 ==================
document.getElementById('new-discussion-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const messageDiv = document.getElementById('submit-message');
    messageDiv.textContent = '发送中...';

    const title = document.getElementById('discussion-title').value;
    const content = document.getElementById('discussion-content').value;

    const encodedTitle = utf8ToBase64(title);
    const encodedContent = utf8ToBase64(content);

    fetch(BASE_URL + '/api/newdisc', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            cookie: getcookie(),
            title: encodedTitle,
            content: encodedContent
        })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'Y') {
                messageDiv.textContent = '讨论发布成功！正在跳转...';
                setTimeout(() => {
                    window.location.href = `/discussion-detail/${data.cid}`;
                }, 1500);
            } else {
                messageDiv.textContent = `发布失败: ${data.error}`;
            }
        })
        .catch(error => {
            console.error('Error:', error);
            messageDiv.textContent = '发布失败: 网络错误';
        });

    setTimeout(() => {
        messageDiv.textContent = '';
    }, 3000);
});
