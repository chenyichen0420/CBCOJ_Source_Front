// ================== UTF-8 ⇄ Base64 编解码 ==================
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

document.addEventListener('submit', function(e) {
	if (e.target && e.target.id === 'reply-form') {
		e.preventDefault();
		const message = document.getElementById('reply-message').value;
		if (!message) {
			alert('回复内容不能为空');
			return;
		}
		// 对回复内容进行 Base64 编码
		const encodedMessage = utf8ToBase64(message);
		try {
			const response = fetch(BASE_URL + `/api/postdisc`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					cookie: getcookie(),
					cid: discussionId,
					content: encodedMessage // 发送编码后的内容
				})
			});
			response.then(res => res.json()).then(data => {
				if (data.status === 'Y') {
					window.location.reload();
				} else {
					alert('回复失败');
				}
			});
		} catch (error) {
			console.error("提交回复时出错:", error);
		}
	}
});
