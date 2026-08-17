/**
 * dsh-controller — 独立 DSH 生命周期控制服务 (V2)。
 *
 * 定位：DSH 停止后仍可用的独立控制页 + 生命周期 API。
 * 只监听 127.0.0.1:3081，零第三方依赖（仅 node 内置模块）。
 *
 * 关键安全边界：本服务**不直接终止进程**。它只写标记文件
 * (restart.requested / stop.requested / start.requested)，真正的进程
 * 生命周期由外部 watchdog (Start-DSH-Watchdog.ps1) 执行。这样本服务
 * 与 DSH 宿主进程、agent 会话完全解耦，绝不会发生“自杀式重启”。
 *
 * 提供：
 *   GET  /             —— 独立启动页（macOS 式极简界面，内嵌 HTML/CSS/JS）
 *   GET  /api/status   —— { state, bootId, pid, uptime, instanceId }
 *   POST /api/start    —— 写 start.requested   （仅当 DSH 未运行）
 *   POST /api/stop     —— 写 stop.requested     （仅当 DSH 运行中）
 *   POST /api/restart  —— 写 restart.requested
 *   GET  /api/logs     —— 读取 watchdog.log 尾部
 *
 * 约定（与插件 dsh-restart-button 一致）：
 *   - bootId 每次 DSH 启动变化，用于判定“真正完成一次重启”
 *   - 状态只暴露 running|stopped|starting|stopping|restarting|error
 */

import http from 'node:http';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
const PORT = 3081;
const DSH_PORT = 3080;
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;
const DSH_HEALTH = `${DSH_URL}/api/system/health`;

const ROOT = __dirname; // controller 与 watchdog 同放在 DSH 根目录
const LOGS = path.join(ROOT, 'logs');
const RESTART_MARKER = path.join(LOGS, 'restart.requested');
const STOP_MARKER = path.join(LOGS, 'stop.requested');
const START_MARKER = path.join(LOGS, 'start.requested');
const WATCH_LOG = path.join(LOGS, 'watchdog.log');
const CONTROLLER_LOG = path.join(LOGS, 'controller.log');

// ———— 极轻量日志 ————
function log(msg) {
  const line = `${new Date().toISOString()} [controller] ${msg}\n`;
  try { fs.appendFileSync(CONTROLLER_LOG, line, 'utf8'); } catch {}
  process.stdout.write(line);
}

// ———— ID 生成 ————
function rand4() { return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0'); }
function stamp(sepDate = '-', sepTime = '-') {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${sepDate}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sepTime}`;
}
function newBootId() { return `dsh-${stamp()}-${rand4()}`; }

// ———— 生命周期锁（内存级，防并发）————
let busy = false;           // 是否有生命周期动作进行中
let pendingAction = null;   // 当前动作名：start|stop|restart
let busySince = 0;

// ———— 探测 DSH 是否真正运行 ————
function httpGetJson(url, timeoutMs = 2500) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

async function probeDsh() {
  const r = await httpGetJson(DSH_HEALTH, 2500);
  if (r.status === 200 && r.json && r.json.ready) {
    return {
      running: true,
      bootId: r.json.bootId || null,
      pid: r.json.pid || null,
      uptime: r.json.uptime ?? null
    };
  }
  // 健康接口未就绪：回退到端口探测
  const r2 = await httpGetJson(DSH_URL, 2000);
  return {
    running: r2.status === 200,
    bootId: null,
    pid: null,
    uptime: null
  };
}

async function markerExists(p) { try { await fs.promises.access(p); return true; } catch { return false; } }

async function currentState() {
  const [probe, mkRestart, mkStop, mkStart] = await Promise.all([
    probeDsh(),
    markerExists(RESTART_MARKER),
    markerExists(STOP_MARKER),
    markerExists(START_MARKER)
  ]);
  let state;
  if (busy) {
    state = { start: 'starting', stop: 'stopping', restart: 'restarting' }[pendingAction] || 'restarting';
  } else if (mkRestart) {
    state = 'restarting';
  } else if (mkStop) {
    state = 'stopping';
  } else if (mkStart) {
    state = 'starting';
  } else {
    state = probe.running ? 'running' : 'stopped';
  }
  if (!probe.running && !busy && !mkStart && !mkRestart && !mkStop && state === 'stopped') {
    // 被动宕机（无任何动作标记），也归为 stopped，前端提示“已停止”
    state = 'stopped';
  }
  return { state, ...probe, instanceId: controllerBootId };
}

// ———— controller 自身的 bootId（用于启动页内部，非 DSH bootId）————
const controllerBootId = newBootId();

// ———— 写标记（带锁）————
async function requestLifecycle(action) {
  if (busy) {
    return { ok: false, error: 'busy', message: '已有操作正在进行，请稍候' };
  }
  const probe = await probeDsh();
  if (action === 'start' && probe.running) {
    return { ok: false, error: 'already-running' };
  }
  if (action === 'stop' && !probe.running) {
    return { ok: false, error: 'already-stopped' };
  }
  busy = true;
  pendingAction = action;
  busySince = Date.now();
  const marker = action === 'start' ? START_MARKER : action === 'stop' ? STOP_MARKER : RESTART_MARKER;
  const id = `${action}_${stamp('_', '_')}_${rand4()}`;
  try {
    await writeFile(marker, `${action}Id=${id} requested by dsh-controller at ${new Date().toISOString()}\n`, 'utf8');
    log(`${action} requested (id=${id}), marker=${path.basename(marker)}`);
    return { ok: true, id, action };
  } catch (e) {
    busy = false; pendingAction = null;
    return { ok: false, error: String(e) };
  }
}

// ———— 定期解锁：无动作标记后重置 busy（watchdog 已消费标记）————
async function releaseBusyIfIdle() {
  if (!busy) return;
  const [mkRestart, mkStop, mkStart] = await Promise.all([
    markerExists(RESTART_MARKER), markerExists(STOP_MARKER), markerExists(START_MARKER)
  ]);
  if (!mkRestart && !mkStop && !mkStart) {
    // 标记已被 watchdog 消费，动作“已提交”，可解锁
    busy = false; pendingAction = null;
  } else if (Date.now() - busySince > 120_000) {
    // 120s 仍未被消费（watchdog 未运行），解锁避免永久卡死
    busy = false; pendingAction = null;
    log('lifecycle lock released after 120s (marker not consumed, watchdog may be offline)');
  }
}

// ———— 启动页 HTML ————
function buildLaunchPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DeepSeek Harness</title>
<style>
  :root{--blue:#4d6bfe;--blue-h:#3f5bf0;--text:#1b1b1c;--muted:#868a91;--err:#d9444a;--ok:#188038}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    color:var(--text);
    background:
      radial-gradient(1200px 700px at 50% -10%, rgba(77,107,254,.10), transparent 60%),
      radial-gradient(1000px 600px at 50% 110%, rgba(147,130,246,.08), transparent 60%),
      linear-gradient(180deg, #fbfcff 0%, #ffffff 45%, #f6f7fd 100%);
    display:flex;align-items:center;justify-content:center;
    -webkit-font-smoothing:antialiased;
  }
  .stage{text-align:center;max-width:560px;padding:48px;width:100%}
  .logo{
    width:64px;height:64px;margin:0 auto 22px;border-radius:18px;
    background:linear-gradient(145deg,#4d6bfe,#7b5bf2);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 12px 32px rgba(77,107,254,.30);
    animation:breathe 2s ease-in-out infinite;
  }
  .logo svg{width:34px;height:34px;fill:#fff}
  @keyframes breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.72;transform:scale(.985)}}
  .brand{font-size:28px;font-weight:650;letter-spacing:.2px;margin:0 0 6px}
  .status{font-size:25px;font-weight:600;margin:22px 0 8px}
  .sub{font-size:14px;color:var(--muted);margin:0 0 30px;line-height:1.7}
  .sub.small{font-size:13px;margin-bottom:26px}
  .btn{
    display:inline-flex;align-items:center;gap:8px;justify-content:center;
    min-width:230px;height:48px;padding:0 26px;border:0;border-radius:13px;
    background:var(--blue);color:#fff;font-size:15px;font-weight:600;cursor:pointer;
    transition:background .16s ease,transform .16s ease,box-shadow .16s ease;
    box-shadow:0 8px 22px rgba(77,107,254,.28)
  }
  .btn:hover{background:var(--blue-h);transform:translateY(-1px)}
  .btn:active{transform:translateY(0)}
  .btn:disabled{opacity:.55;cursor:default;transform:none}
  .btn.cancel{background:#eef0f4;color:#4a4d52;box-shadow:none}
  .btn.cancel:hover{background:#e4e7ec}
  .btn.danger{background:#d9444a;box-shadow:0 8px 22px rgba(217,68,74,.28)}
  .btn.danger:hover{background:#c5353a}
  .link{margin-top:22px;display:inline-block;background:none;border:0;color:var(--muted);font-size:13px;cursor:pointer;text-decoration:none;padding:4px 8px;border-radius:6px}
  .link:hover{color:var(--text);background:rgba(0,0,0,.04)}
  .ok-badge{color:var(--ok)}
  .hidden{display:none!important}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .logs{display:none;margin:22px auto 0;text-align:left;background:#11131a;color:#cdd2da;border-radius:12px;padding:16px 18px;font-family:Consolas,"Cascadia Mono",Menlo,monospace;font-size:12px;line-height:1.7;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-all}
  .logs.open{display:block}
  .err-tip{color:var(--muted);font-size:13px;margin-top:14px}
</style>
</head>
<body>
<div class="stage" role="main" aria-live="polite">
  <div class="logo">
    <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10A10 10 0 0 1 2 12 10 10 0 0 1 12 2zm0 3a7 7 0 0 0-7 7 7 7 0 0 0 7 7 7 7 0 0 0 7-7 7 7 0 0 0-7-7zm0 3.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-3.5-3.5 3.5 3.5 0 0 1 3.5-3.5z"/></svg>
  </div>
  <h1 class="brand">DeepSeek Harness</h1>

  <!-- 已关闭 -->
  <div id="view-stopped">
    <div class="status">DSH 已关闭</div>
    <p class="sub">需要使用时，可以随时重新启动。</p>
    <button class="btn" id="btn-start">▶&nbsp; 启动 DSH</button>
    <div><button class="link" id="lnk-logs">查看日志</button></div>
  </div>

  <!-- 启动中 -->
  <div id="view-starting" class="hidden">
    <div class="status">正在启动 DSH</div>
    <p class="sub" id="starting-sub">通常只需要几秒钟</p>
    <button class="btn" id="btn-starting" disabled><span class="spinner"></span>&nbsp; 启动中…</button>
    <div><button class="link" id="lnk-logs2">查看日志</button></div>
  </div>

  <!-- 启动成功 -->
  <div id="view-ready" class="hidden">
    <div class="status ok-badge">✓&nbsp; DSH 已启动</div>
    <p class="sub">正在为你打开……</p>
  </div>

  <!-- 启动失败 -->
  <div id="view-failed" class="hidden">
    <div class="status" style="color:var(--err)">DSH 暂时没有启动成功</div>
    <p class="sub small">可以再试一次。</p>
    <button class="btn" id="btn-retry">重新启动</button>
    <div><button class="link" id="lnk-logs3">查看日志</button></div>
  </div>

  <pre class="logs" id="logs"></pre>
</div>
<script>
(function () {
  var POLL_MS = 1800;
  var heartbeatDeadline = 0;   // 0 = 停止
  var slowHinted = false;
  var startedAt = 0;
  var $ = function (id) { return document.getElementById(id); };
  function show(id) {
    ['view-stopped','view-starting','view-ready','view-failed'].forEach(function (n) {
      $(n).classList.toggle('hidden', n !== id);
    });
  }
  function setHash() {} // keep simple

  function poll() {
    fetch('/api/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var st = s.state;
        if (st === 'running') {
          show('view-ready');
          heartbeatDeadline = 0;
          setTimeout(function () {
            var target = localStorage.getItem('dsh_lastUrl') || 'http://127.0.0.1:3080/';
            window.location.replace(target);
          }, 900);
        } else if (st === 'starting' || st === 'restarting') {
          show('view-starting');
          if (startedAt && Date.now() - startedAt > 15000 && !slowHinted) {
            slowHinted = true;
            $('starting-sub').textContent = '启动时间比平时稍长，请稍候……';
          }
        } else if (st === 'stopping') {
          show('view-stopped');
        } else if (st === 'stopped') {
          if (startedAt && Date.now() - startedAt > 90000) {
            show('view-failed');
          } else {
            show('view-stopped');
          }
        }
      })
      .catch(function () {
        // controller 自身还在，忽略瞬时错误
      });
  }

  function doStart() {
    startedAt = Date.now();
    slowHinted = false;
    heartbeatDeadline = Date.now() + 5000;
    $('starting-sub').textContent = '通常只需要几秒钟';
    show('view-starting');
    var btn = $('btn-starting');
    btn.setAttribute('disabled', 'disabled');
    fetch('/api/start', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok && d.error === 'already-running') {
          // 已经在运行，直接进入 ready
          show('view-ready');
          window.location.replace(localStorage.getItem('dsh_lastUrl') || 'http://127.0.0.1:3080/');
        } else if (!d.ok && d.error === 'busy') {
          $('starting-sub').textContent = '已有操作正在进行，请稍候……';
        }
        // 其余情况交给 poll 轮询判定
      })
      .catch(function () {
        $('starting-sub').textContent = '启动请求未送达，请稍后重试。';
        btn.removeAttribute('disabled');
      });
  }

  $('btn-start').addEventListener('click', doStart);
  $('btn-retry').addEventListener('click', doStart);
  ['lnk-logs','lnk-logs2','lnk-logs3'].forEach(function (id) {
    $(id).addEventListener('click', function () {
      var logs = $('logs');
      logs.classList.toggle('open');
      if (logs.classList.contains('open')) {
        fetch('/api/logs').then(function (r) { return r.text(); }).then(function (t) {
          logs.textContent = t || '(暂无日志)';
        });
      }
    });
  });

  poll();
  setInterval(poll, POLL_MS);
})();
</script>
</body>
</html>`;
  return html;
}

// ———— HTTP 工具 ————
function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(data);
}

async function readTail(file, bytes = 24 * 1024) {
  try {
    const s = await stat(file);
    const start = Math.max(0, s.size - bytes);
    const fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(s.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// ———— 请求分发 ————
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method.toUpperCase();

  // Origin/Host 基础防护（只允许本地访问）
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return send(res, 403, { ok: false, error: 'forbidden host' });
  }

  if (p === '/' && method === 'GET') {
    return send(res, 200, buildLaunchPage(), 'text/html; charset=utf-8');
  }
  if (p === '/api/status' && (method === 'GET' || method === 'HEAD')) {
    const s = await currentState();
    return send(res, 200, s);
  }
  if (p === '/api/start' && method === 'POST') {
    return send(res, 200, await requestLifecycle('start'));
  }
  if (p === '/api/stop' && method === 'POST') {
    return send(res, 200, await requestLifecycle('stop'));
  }
  if (p === '/api/restart' && method === 'POST') {
    return send(res, 200, await requestLifecycle('restart'));
  }
  if (p === '/api/logs' && method === 'GET') {
    const tail = await readTail(WATCH_LOG);
    return send(res, 200, tail, 'text/plain; charset=utf-8');
  }
  return send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log(`dsh-controller listening on http://${HOST}:${PORT} (bootId=${controllerBootId})`);
});

// 周期性解锁 + 心跳清理
setInterval(releaseBusyIfIdle, 5000).unref();
