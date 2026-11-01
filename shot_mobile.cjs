// 在 375x812 的 iframe 里渲染同一页面（独立视口，媒体查询会生效），并裁剪截图
const http = require("http");
const fs = require("fs");

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: 9222, path }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILD_IFRAME = `(async () => {
  const old = document.getElementById('__probe_frame');
  if (old) old.remove();
  const f = document.createElement('iframe');
  f.id = '__probe_frame';
  f.style.cssText = 'position:fixed;left:0;top:0;width:375px;height:812px;border:0;z-index:999999;background:#0f1115';
  f.src = location.pathname + '?sharecode=7XVCZA6HXZ';
  document.body.appendChild(f);
  await new Promise(function (res) { f.onload = res; setTimeout(res, 12000); });

  const d = f.contentDocument, w = f.contentWindow;
  const hasStyle = function () {
    return Array.from(d.styleSheets).some(function (s) { return (s.href || '').indexOf('styles.css') >= 0; });
  };
  if (!hasStyle()) {
    await new Promise(function (res) {
      const l = d.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'styles.css';
      l.onload = res;
      l.onerror = res;
      d.head.appendChild(l);
      setTimeout(res, 5000);
    });
  }
  await new Promise(function (r) { setTimeout(r, 700); });

  const login = d.getElementById('view-login');
  if (login) login.classList.add('hidden');
  const app = d.getElementById('view-app');
  if (app) app.classList.remove('hidden');
  const up = d.getElementById('user-phone');
  if (up) up.textContent = '134****3863';
  const list = d.getElementById('album-list');
  if (list) list.innerHTML = [1,2,3,4,5,6].map(function (i) {
    return '<div class="album-tile"><div class="album-cover"></div><div class="album-body"><div class="album-name">东京旅行 ' + i + '</div><div class="count">个人</div></div><div class="album-actions"><button class="mini">改名</button><button class="mini">删除</button></div></div>';
  }).join('');
  await new Promise(function (r) { setTimeout(r, 600); });

  const topbar = d.querySelector('.topbar');
  const head = d.querySelector('.panel-head');
  const h3 = d.querySelector('.panel-head h3');
  const userbox = d.querySelector('.userbox');
  return JSON.stringify({
    innerWidth: w.innerWidth,
    docScrollWidth: d.documentElement.scrollWidth,
    horizontalOverflow: d.documentElement.scrollWidth > w.innerWidth + 1,
    styleApplied: hasStyle(),
    viewAppDisplay: getComputedStyle(app).display,
    topbarHeight: Math.round(topbar.getBoundingClientRect().height),
    topbarStyle: getComputedStyle(topbar).flexDirection,
    userboxHeight: Math.round(userbox.getBoundingClientRect().height),
    panelHeadHeight: Math.round(head.getBoundingClientRect().height),
    h3Height: Math.round(h3.getBoundingClientRect().height),
    h3Width: Math.round(h3.getBoundingClientRect().width)
  });
})()`;

(async () => {
  const outFile = process.argv[2] || "shot-mobile.png";
  const list = JSON.parse(await httpGet("/json/list"));
  const page = list.find((t) => t.type === "page") || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", {
    url: "https://stellar-memories.app.workbuddy.host/?sharecode=7XVCZA6HXZ",
  });
  await sleep(5000);

  const ev = await send("Runtime.evaluate", {
    expression: BUILD_IFRAME,
    returnByValue: true,
    awaitPromise: true,
  });
  const v = ev.result && ev.result.result && ev.result.result.value;
  console.log("measure:", v);
  if (ev.result && ev.result.exceptionDetails) {
    console.log("exception:", JSON.stringify(ev.result.exceptionDetails).slice(0, 300));
  }

  await sleep(800);
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 375, height: 812, scale: 2 },
    captureBeyondViewport: false,
  });
  fs.writeFileSync(outFile, Buffer.from(shot.result.data, "base64"));
  console.log("saved:", outFile, fs.statSync(outFile).size, "bytes");
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
