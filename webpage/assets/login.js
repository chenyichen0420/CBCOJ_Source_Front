checkLogin();
document.getElementById('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const formData = new FormData(this);
    try {
        const response = await fetch(BASE_URL + '/api/login?' + new URLSearchParams(formData));
        const result = await response.json();
        if (result.status === 'Y') {
            document.getElementById('message').textContent = '登录成功，正在跳转...';
            document.cookie = `user_cookie=${result.cookie}; expires=; path=/;`;
            setTimeout(() => {
                window.location.href = '/';
            }, 1000);
        } else {
            document.getElementById('message').textContent = '登录失败: ' + result.error;
        }
    } catch (error) {
        document.getElementById('message').textContent = '登录请求失败';
        console.error('Error during login request:', error);
    }
});