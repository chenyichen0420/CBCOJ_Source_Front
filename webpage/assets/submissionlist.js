document.addEventListener("DOMContentLoaded", async(e) => {
	if (!(await checkLogin())) {
		window.location.href = '/login';
	}
	const urlParams = new URLSearchParams(window.location.search);
	const target = urlParams.get('target') || 'all';
	let currentPage = parseInt(urlParams.get('page'), 10) || 1;
	const perPage = 10;
	async function loadSubmissions(page) {
		try {
			const response = await fetch(BASE_URL + `/api/recordlist?target=${target}&page=${page}&cookie=${getcookie()}`);
			const data = await response.json();
			if (data.status !== 'Y') {
				console.error('Failed to load submissions:', data.error);
				return;
			}
			const submissionsDiv = document.getElementById('submissions');
			submissionsDiv.innerHTML = '';
			const ridlst = JSON.parse(data.recordlist);
			ridlst.forEach(rid => {
				const div = document.createElement('div');
				div.className = 'submission';
				div.innerHTML = `<a href="/record/${rid}">提交记录 #${rid}</a>`;
				submissionsDiv.appendChild(div);
			});
			const paginationDiv = document.getElementById('pagination');
			paginationDiv.innerHTML = '';
			let totalPages = data.page;
			for (let i = Math.max(1, page - 2); i <= totalPages && i <= page + 2; i++) {
				const a = document.createElement('a');
				if (i === page) {
					a.style.background = 'rgba(78,161,255,.24)';
				} else {
					a.href = '/record/list?page=' + i;
				}
				a.textContent = i;
				a.onclick = () => loadSubmissions(i);
				paginationDiv.appendChild(a);
			}
		} catch (error) {
			console.error('Error loading submissions:', error);
		}
	}
	loadSubmissions(currentPage);
});
