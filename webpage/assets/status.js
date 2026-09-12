document.addEventListener("DOMContentLoaded", async (e) => {
	if (!(await checkLogin())) {
		window.location.href = '/login';
	}
});

function dealresultcolor(result) {
	if (result === 200) return "green";
	else if (result === 403) return "yellow";
	else if (result === 400) return "yellow";
	else if (result === 408) return "lightblue";
	else if (result === 406) return "red";
	else if (result === 413) return "lightblue";
	else if (result === 502) return "purple";
	else return "white";
}

function dealresulttext(result) {
	if (result === 200) return "Accepted";
	else if (result === 403) return "Rejected";
	else if (result === 400) return "Compilation Error";
	else if (result === 408) return "Time Limit Exceeded";
	else if (result === 406) return "Wrong Answer";
	else if (result === 413) return "Memory Limit Exceeded";
	else if (result === 502) return "Runtime Error";
	else if (result === 500) return "System Error";
	else if (result === 202) return "In Queue";
	else if (result === 206) return "Judging";
	else if (result === 404) return "Not Evaluated";
	else return "Unknown Error";
}

// HTML转义函数，防止XSS
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

const urlParams = new URLSearchParams(window.location.search);
const submissionId = window.location.pathname.split('/').pop();
const cookie = getcookie();
if (submissionId !== null) {
	document.getElementById('PageTitle').textContent = `评测结果 - ${submissionId} - CBCOJ`;
	document.getElementById('record-content').textContent = '正在加载评测结果...';
} else {
	document.getElementById('record-content').textContent = '无效的提交ID';
}

document.addEventListener('DOMContentLoaded', async () => {
	const recordcontent = document.getElementById('record-content');
	try {
		const response = await fetch(BASE_URL + `/api/record?rid=${submissionId}&cookie=${cookie}`);
		const result = await response.json();

		if (result.status === "Y") {
			const details = result.result;
			document.getElementById('user').innerHTML = `<h3>提交用户</h3><p>${escapeHtml(await getusername(details.uid))}</p>`;

			// 构建HTML片段数组
			const htmlParts = [];

			// 1. 评测结果概要
			const overviewColor = dealresultcolor(details.overview.code);
			htmlParts.push(`
				<h3>评测结果</h3>
				<p style="color: ${overviewColor}">${escapeHtml(details.overview.describe)}</p>
				<p>时间: ${details.overview.time}ms</p>
				<p>内存: ${(details.overview.memory / 1024 / 1024).toFixed(2)}MB</p>
				<p>得分: ${details.overview.score}</p>
				<h4>测试点详情</h4>
				<details>
					<summary>点击查看</summary>
			`);

			// 2. 测试点卡片
			let cnt = 1;
			details.detail.forEach(testcase => {
				const statusColor = dealresultcolor(testcase.code);
				const statusText = dealresulttext(testcase.code);
				const memoryMB = (testcase.memory / 1024 / 1024).toFixed(2);
				htmlParts.push(`
					<div class="testcase-card" style="border-left: 4px solid ${statusColor};">
						<div class="testcase-card-header">
							<span class="testcase-title" style="color: ${statusColor}">
								测试点 ${cnt++} : ${escapeHtml(testcase.describe)}
							</span>
							<span class="testcase-score">${testcase.score} 分</span>
						</div>
						<div class="testcase-details">
							<div class="testcase-detail-item"><strong>状态</strong><br><span style="color: ${statusColor}">${statusText}</span></div>
							<div class="testcase-detail-item"><strong>时间</strong><br>${testcase.time} ms</div>
							<div class="testcase-detail-item"><strong>内存</strong><br>${memoryMB} MB</div>
						</div>
						${testcase.detail ? `<div class="testcase-description"><strong>详细描述</strong><br>${escapeHtml(testcase.detail)}</div>` : ''}
					</div>
				`);
			});

			// 3. 源代码折叠块
			htmlParts.push(`
				</details>
				<details>
					<summary>源代码</summary>
					<pre class="code"><code id="source-code"></code></pre>
				</details>
			`);

			// 一次性渲染所有内容
			recordcontent.innerHTML = htmlParts.join('');

			// 解码并显示源代码
			const sourceCodeElem = document.getElementById("source-code");
			if (sourceCodeElem && result.code) {
				const binaryString = atob(result.code);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}
				sourceCodeElem.textContent = new TextDecoder("utf-8").decode(bytes);
			}
		} else if (result.status === "P") {
			const details = result.data;
			document.getElementById('user').innerHTML = `<h3>提交用户</h3><p>${escapeHtml(await getusername(result.uid))}</p>`;
			recordcontent.innerHTML = `
				<h3>评测结果</h3>
				<p>评测尚未完成，当前状态如下，请耐心等待：</p>
				<p>状态: ${dealresulttext(details.code)}</p>
				<p>详情: ${escapeHtml(details.describe)}</p>
			`;
		} else {
			console.error('Error fetching record:', result);
			recordcontent.textContent = '加载评测结果失败：' + (result.error || '未知错误');
		}
	} catch (error) {
		console.error('Error fetching record:', error);
		recordcontent.textContent = '加载评测结果失败';
	}
});
