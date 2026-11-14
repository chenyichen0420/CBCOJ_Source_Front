(function () {
	const URL_LIMIT = 512;
	const requests = new WeakMap();

	function fallbackAvatar(image) {
		const username = image.dataset.avatarUsername || '';
		image.src = image.dataset.avatarFallback || `/api/avatar/${encodeURIComponent(username)}`;
	}

	function validateAvatarImageUrl(value, maxLength = URL_LIMIT) {
		if (typeof value !== 'string' || value.length < 1 || value.length > maxLength)
			return `头像 URL 长度必须为 1-${maxLength} 个字符`;
		if (/[\u0000-\u0020\u007f]/.test(value))
			return '头像 URL 不能包含空白或控制字符';
		try {
			const url = new URL(value);
			if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
				url.username || url.password || url.href.length > maxLength) {
				return '请输入有效的 HTTP(S) 图片地址，且不能包含用户名或密码';
			}
		} catch (_) {
			return '请输入有效的 HTTP(S) 图片地址';
		}
		return null;
	}

	function loadAvatarImage(image, value, timeoutMs = 2000) {
		const validationError = validateAvatarImageUrl(value);
		if (validationError) {
			fallbackAvatar(image);
			return Promise.resolve(false);
		}

		const url = new URL(value);
		const requestId = (requests.get(image) || 0) + 1;
		requests.set(image, requestId);
		image.referrerPolicy = 'no-referrer';

		return new Promise(resolve => {
			let settled = false;
			const finish = loaded => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				image.removeEventListener('load', onLoad);
				image.removeEventListener('error', onError);
				const isCurrentRequest = requests.get(image) === requestId;
				if (isCurrentRequest && !loaded) fallbackAvatar(image);
				resolve(isCurrentRequest && loaded);
			};
			const timer = setTimeout(() => {
				finish(false);
			}, Math.max(0, timeoutMs));
			const onLoad = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
			const onError = () => finish(false);
			image.addEventListener('load', onLoad);
			image.addEventListener('error', onError);
			image.src = url.href;
		});
	}

	async function loadConfiguredAvatar(image) {
		const username = image.dataset.avatarUsername;
		if (!username) return;
		const fallback = image.dataset.avatarFallback || `/api/avatar/${encodeURIComponent(username)}`;
		image.dataset.avatarFallback = fallback;
		image.referrerPolicy = 'no-referrer';
		const startedAt = Date.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		try {
			const response = await fetch(`/api/avatar-url/${encodeURIComponent(username)}`, {
				signal: controller.signal,
				credentials: 'same-origin'
			});
			if (!response.ok) return;
			const result = await response.json();
			if (result.status !== 'Y' || !result.avatar_url) return;
			const remaining = 2000 - (Date.now() - startedAt);
			if (remaining <= 0) return;
			await loadAvatarImage(image, result.avatar_url, remaining);
		} catch (_) {
			fallbackAvatar(image);
		} finally {
			clearTimeout(timeout);
		}
	}

	window.validateAvatarImageUrl = validateAvatarImageUrl;
	window.loadAvatarImage = loadAvatarImage;
	window.loadConfiguredAvatar = loadConfiguredAvatar;

	document.addEventListener('DOMContentLoaded', () => {
		document.querySelectorAll('img[data-avatar-username]').forEach(loadConfiguredAvatar);
	});
})();
