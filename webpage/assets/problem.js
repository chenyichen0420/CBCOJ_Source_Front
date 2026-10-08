/**
 * ArrayBuffer 转 Base64
 * @param {ArrayBuffer} buffer 
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// ========== 提交代码 ==========
const urlParams = new URLSearchParams(window.location.search);
const contestIdParam = urlParams.get('contestId');

if (contestIdParam) {
    // 在提交表单上方显示比赛模式横幅
    const submitFormCard = document.querySelector('.submit-form');
    if (submitFormCard) {
        const banner = document.createElement('div');
        banner.style.marginBottom = '12px';
        banner.style.padding = '8px';
        banner.style.background = '#5462e34d';
        banner.style.border = '1px solid';
        banner.style.borderRadius = '6px';
        banner.textContent = `比赛模式已启用，提交将计入比赛 ${contestIdParam}。`;
        submitFormCard.insertBefore(banner, submitFormCard.firstChild);
    }
}

document.getElementById('submit-form')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    const submitMsg = document.getElementById('submit-message');
    if (!submitMsg) return;

    // 获取 cookie
    const cookie = getcookie();

    if (!cookie) {
        submitMsg.textContent = '请先登录';
        return;
    }

    const formData = new FormData(this);
    const codeFile = formData.get('code');

    if (!codeFile || codeFile.size === 0) {
        submitMsg.textContent = '请选择代码文件';
        return;
    }

    try {
        // 读取文件并转 Base64
        const fileBuffer = await codeFile.arrayBuffer();
        const codeBase64 = arrayBufferToBase64(fileBuffer);

        // 构建请求 payload
        const payload = {
            id: problemId,
            language: formData.get('lan'),
            code: codeBase64
        };

        submitMsg.textContent = '提交中...';

        // 优化 UI：禁用提交按钮以防重复提交
        const submitBtn = this.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '提交中...';
        }

        let response;
        if (contestIdParam) {
            // 使用比赛提交接口，cookie 仍以 query 形式传递以兼容后端登录检查
            response = await fetch(`${BASE_URL}/api/contests/${encodeURIComponent(contestIdParam)}/submit?cookie=${cookie}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            // 普通提交接口（保持原 payload 兼容性）
            const normalPayload = Object.assign({ cookie }, payload);
            response = await fetch(BASE_URL + '/api/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(normalPayload)
            });
        }

        const text = await response.text();
        console.log('提交响应:', text);

        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            submitMsg.textContent = '服务器返回格式错误';
            return;
        }

        if (result.status === 'Y') {
            submitMsg.textContent = `提交成功：${result.rid}`;
            // 小优化：立即刷新局部状态再跳转，给用户短暂提示
            setTimeout(() => {
                if (result.rid) window.location.href = `/record/${result.rid}`;
                else window.location.reload();
            }, 1200);
        } else {
            submitMsg.textContent = `提交失败：${result.error || '未知错误'}`;
        }
    } catch (err) {
        console.error('提交请求失败:', err);
        submitMsg.textContent = '提交请求失败，请检查网络';
    }
    finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '提交';
        }
    }
});

document.addEventListener("DOMContentLoaded", () => {
if (typeof renderMathInElement !== 'undefined') {
    renderMathInElement(document.getElementById('problem-content') || document.body, {
        delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false},
            {left: '\\(', right: '\\)', display: false},
            {left: '\\[', right: '\\]', display: true}
        ],
        throwOnError: false
    });
} else {
    console.warn('auto-render not loaded, formula may not display');
}
});
