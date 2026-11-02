// ローカル版の入口（local_obs.html / local_dock.html）から、起動中のサーバーへ移る。
// まず初期設定のポートを試し、応答が無ければサーバーが書き出した data/port.js のポートを試す。
// どちらも応答が無いときは、サーバーが起動するまで数秒おきに試し続ける。
// ファイルとして開かれたページからは fetch でサーバーに問い合わせられないので、script 要素で読み込んで確かめる。
window.ClockLocal = (() => {
  const DEFAULT_PORT = 8137;
  const RETRY_MS = 2000;

  function loadScript(src) {
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`;
      s.onload = () => { s.remove(); resolve(true); };
      s.onerror = () => { s.remove(); resolve(false); };
      document.head.appendChild(s);
    });
  }

  // 同じポートで別のソフトが応答することもあるので、Clock Player の印（clockPlayerPing）を確かめる
  async function isClockPlayer(port) {
    window.clockPlayerPing = null;
    await loadScript(`http://127.0.0.1:${port}/api/ping.js`);
    return !!(window.clockPlayerPing && window.clockPlayerPing.port === port);
  }

  async function findPort() {
    if (await isClockPlayer(DEFAULT_PORT)) return DEFAULT_PORT;
    window.clockPlayerPort = null;
    await loadScript('data/port.js');
    const port = window.clockPlayerPort;
    if (port && port !== DEFAULT_PORT && await isClockPlayer(port)) return port;
    return null;
  }

  async function connect(page, onWaiting) {
    let notified = false;
    for (;;) {
      const port = await findPort();
      if (port) {
        location.replace(`http://127.0.0.1:${port}/${page}`);
        return;
      }
      if (!notified && onWaiting) onWaiting();
      notified = true;
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }

  return { connect };
})();
