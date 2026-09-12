checkLogin();
async function getsaying() {
    try {
        let tmp = await fetch("https://international.v1.hitokoto.cn/?c=c&encode=text");
        document.getElementById('sayings').textContent = await tmp.text();
    } catch (error) {
        document.getElementById('sayings').textContent = "代码如诗，算法如歌。";
    }
}
getsaying();
