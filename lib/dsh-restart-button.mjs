/**
 * dsh-restart-button — DSH 生命周期控制（V2）。
 *
 * 页面 A（DSH 运行中）注入左下角统一控制栏（胶囊形）：[额度胶囊] | [↻ 重启] [⏻ 关闭]，并实现：
 *   - 若安装了 dsh-quota-panel 插件，其 #dsh-quota-panel 会被 DOM 移动到本控制栏内
 *     （CSS override：position:static + flex-row），额度卡片展开时 anchored 到控制栏上方；
 *     未安装则该插件独立工作，控制栏只显示 [↻ 重启] [⏻ 关闭]。
 *   - 重启确认卡片 → 全屏接管层（macOS 式极简）→ 轮询新实例 → 自动恢复
 *   - 关闭确认卡片 → 写 stop 标记 → 跳转独立启动页（dsh-controller, 3081）
 * 用户界面遵循 V2 设计基线：不暴露 watchdor/PID/bootId/端口 等任何技术名词。
 *
 * 后端路由：
 *   POST /api/restart       —— 写 logs/restart.requested（含 restartId）
 *   POST /api/stop          —— 写 logs/stop.requested
 *   GET  /api/system/health —— 返回 { ready, bootId, pid, uptime }
 *
 * 重启标记文件格式（watchdog 解析）：
 *   即时：   restartId=rst_<ts>_<hex> requested by ...     （无 graceSeconds → watchdog 立即重启）
 *   优雅延迟：restartId=... graceSeconds=<N> ...            （N 秒后 watchdog 才重启，供 agent 先完成回合）
 * 交互按钮走"即时"（人工点击后面临全屏等待覆盖层）；需要让当前 agent 回合
 * 先收尾并回复用户时，写 marker 时附带 graceSeconds（建议 30~90s）。
 *
 * 安全边界：本插件绝不终止宿主进程；真正的进程生命周期由外部
 * watchdog（Start-DSH-Watchdog.ps1）消费标记后执行。
 */

import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'restart-button';
export const inject = ['webServer'];

const CONTROLLER_URL = 'http://127.0.0.1:3081/';

function newBootId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `dsh-${ts}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}
function newRestartId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `rst_${ts}_${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}
function newActionId(prefix) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}_${ts}_${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function dshRoot() {
  const home = process.env.DSH_HOME;
  return home ? path.dirname(home) : 'D:\\CodexD\\DSH';
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const root = dshRoot();
  return {
    requestFile: cfg.requestFile || path.join(root, 'logs', 'restart.requested'),
    stopFile: cfg.stopFile || path.join(root, 'logs', 'stop.requested'),
    watchdogPidFile: cfg.watchdogPidFile || path.join(root, 'logs', 'watchdog.pid'),
    controllerUrl: cfg.controllerUrl || CONTROLLER_URL,
    buttonLabel: cfg.buttonLabel || '重启 DSH'
  };
}

async function watchdogInfo(pidFile) {
  try {
    const text = await readFile(pidFile, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid: null };
    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

function buildPageScript(opts) {
  const controllerUrl = JSON.stringify(opts.controllerUrl).replace(/</g, '\\u003C');
  return `<script>
(function () {
  var API_RESTART = '/api/restart';
  var API_STOP = '/api/stop';
  var API_HEALTH = '/api/system/health';
  var CONTROLLER = ${controllerUrl};
  var rootId = 'dsh-lifecycle';
  var POLL_MS = 2000;
  var FETCH_TIMEOUT_MS = 3500;
  var SLOW_AT = 45;
  var FAIL_AT = 90;

  var stage = 'idle'; // idle|confirm-restart|confirm-stop|restarting|stopping|reconnecting|restored|failed
  var oldBootId = null;
  var startedAt = 0;
  var pollTimer = null;
  var tickTimer = null;
  var bar = null, card = null, overlay = null, txTitle = null, txSub = null, txTimer = null, railTip = null;

  var css = [
    /* 统一左下角控制条：token 驱动（light/dark 自动跟随 DSH） */
    '#dsh-lifecycle{position:fixed;left:12px;bottom:16px;z-index:900;display:flex;flex-direction:row;align-items:center;gap:0;min-width:0;padding:4px 6px;border-radius:18px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.93));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));box-shadow:0 2px 12px var(--dsw-alias-shadow-1,rgba(0,0,0,.07));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.4;color:var(--dsw-alias-text-primary,#1b1b1c);transition:opacity .3s ease}',
    '#dsh-lifecycle .lc-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-text-secondary,#3c4043);font-size:12px;line-height:1;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}',
    '#dsh-lifecycle .lc-sep{width:1px;height:16px;background:var(--dsw-alias-border-subtle,rgba(0,0,0,.12));margin:0 3px;flex:none}',
    '#dsh-lifecycle:has(#dsh-quota-capsule[hidden]) .lc-sep{display:none}',
    '#dsh-lifecycle #dsh-quota-panel{position:static!important;right:auto!important;bottom:auto!important;left:auto!important;top:auto!important;display:inline-flex!important;flex-direction:row!important;align-items:center!important;gap:0!important;margin:0!important}',
    '#dsh-lifecycle #dsh-quota-capsule{height:24px;padding:0 6px!important;border:none!important;border-radius:12px!important;background:transparent!important;box-shadow:none!important;cursor:pointer;transition:background .15s ease;display:inline-flex!important;align-items:center;justify-content:center;gap:4px;font-size:11px!important;color:var(--dsw-alias-text-primary,#1b1b1c)}',
    '#dsh-lifecycle #dsh-quota-capsule:hover{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.05))!important}',
    '#dsh-lifecycle #dsh-quota-capsule .dsh-capsule-dot{display:none!important}',
    '#dsh-lifecycle #dsh-quota-capsule .dsh-capsule-item{font-size:11px!important;line-height:1!important;white-space:nowrap!important;color:inherit!important}',
    '#dsh-lifecycle #dsh-quota-capsule .dsh-capsule-chevron{font-size:9px!important;margin-left:-1px}',
    '#dsh-lifecycle #dsh-quota-card{position:fixed!important;left:12px!important;right:auto!important;bottom:96px!important;width:260px!important;max-width:calc(100vw - 24px)!important;margin-top:0!important;z-index:901!important;padding:10px 12px!important;border-radius:12px!important;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1))!important;background:var(--dsw-alias-bg-layer-2,#fff)!important;box-shadow:0 8px 28px var(--dsw-alias-shadow-2,rgba(0,0,0,.14))!important;color:var(--dsw-alias-text-primary,#1b1b1c)!important}',
    /* 额度卡片内部紧凑化 */
    '#dsh-lifecycle #dsh-quota-card .dsh-quota-header{margin-bottom:8px!important;min-height:auto!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-quota-title{font-size:13px!important;font-weight:600!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-quota-divider{margin:6px 0!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-provider-main{gap:8px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-status-dot{width:7px!important;height:7px!important;margin-top:5px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-provider-name{font-size:12px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-provider-value{font-size:12px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-provider-sub{font-size:11px!important;margin-top:1px!important;line-height:16px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-progress{height:4px!important;margin-top:5px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-usage-values{font-size:11px!important;margin-top:2px!important;line-height:16px!important}',
    '#dsh-lifecycle #dsh-quota-card .dsh-usage-caption{font-size:11px!important;margin-top:3px!important;line-height:16px!important}',
    '#dsh-lifecycle .lc-btn .lc-ico{font-size:12px;line-height:1;display:inline-block;transition:transform .2s ease}',
    '#dsh-lifecycle .lc-btn:hover{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.06))}',
    '#dsh-lifecycle .lc-btn:active{transform:translateY(1px)}',
    '#dsh-lifecycle .lc-btn-restart:hover .lc-ico{transform:rotate(18deg)}',
    '#dsh-lifecycle .lc-btn-stop:hover{color:#d94a4a;border:1px solid rgba(217,74,74,.45);background:rgba(217,74,74,.06)}',
    /* 侧边栏中宽（120~200px）：按钮只留图标，额度信息保留 */
    '#dsh-lifecycle.lc-mid .lc-btn{padding:0 5px!important;font-size:0!important;width:26px}',
    '#dsh-lifecycle.lc-mid .lc-ico{font-size:13px!important}',
    '#dsh-lifecycle.lc-mid #dsh-quota-capsule{padding:0 5px!important}',
    /* 侧边栏折叠 rail 模式：竖排图标列，额度变成圆点指示灯 */
    '#dsh-lifecycle.lc-rail{width:36px!important;padding:4px 3px!important;flex-direction:column!important;align-items:center!important;border-radius:12px!important}',
    '#dsh-lifecycle.lc-rail .lc-btn{width:30px;height:30px;padding:0!important;font-size:0!important;justify-content:center!important}',
    '#dsh-lifecycle.lc-rail .lc-ico{font-size:14px!important}',
    '#dsh-lifecycle.lc-rail .lc-sep{display:none!important}',
    '#dsh-lifecycle.lc-rail #dsh-quota-capsule{height:28px;width:30px;padding:0!important;display:flex!important;align-items:center;justify-content:center;font-size:0!important;position:relative}',
    '#dsh-lifecycle.lc-rail #dsh-quota-capsule::after{content:"";width:7px;height:7px;border-radius:50%;background:var(--dsw-static-neutral-bluish-400,#adb2b8);display:block;transition:background .2s ease}',
    '#dsh-lifecycle.lc-rail.lc-dot-ok #dsh-quota-capsule::after{background:var(--dsw-static-green-500,#22c55e)}',
    '#dsh-lifecycle.lc-rail.lc-dot-warn #dsh-quota-capsule::after{background:var(--dsw-static-amber-500,#f59e0b)}',
    '#dsh-lifecycle.lc-rail.lc-dot-error #dsh-quota-capsule::after{background:var(--dsw-static-red-500,#ef4444)}',
    '#dsh-lifecycle.lc-rail #dsh-quota-capsule .dsh-capsule-item{display:none!important}',
    '#dsh-lifecycle.lc-rail #dsh-quota-capsule .dsh-capsule-chevron{display:none!important}',
    '#dsh-lifecycle.lc-rail #dsh-quota-card{display:none!important}',
    /* rail 模式悬停提示 */
    '.lc-rail-tip{position:fixed;z-index:902;padding:5px 10px;border-radius:8px;background:rgba(30,30,30,.88);color:#fff;font-size:11px;line-height:1.3;white-space:nowrap;pointer-events:none;backdrop-filter:blur(6px);box-shadow:0 2px 8px rgba(0,0,0,.15);transition:opacity .15s ease}',
    '.lc-card{position:fixed;left:12px;bottom:130px;z-index:901;width:160px;max-width:calc(100vw - 24px);padding:16px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.1));border-radius:14px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 40px var(--dsw-alias-shadow-2,rgba(0,0,0,.18));font-size:14px;color:var(--dsw-alias-text-primary,#1b1b1c);font-family:inherit;box-sizing:border-box}',
    '.lc-card-title{font-size:16px;font-weight:650;margin-bottom:8px}',
    '.lc-card-desc{color:var(--dsw-alias-text-secondary,#61666b);font-size:13px;line-height:1.6;margin-bottom:4px}',
    '.lc-card-sub{color:var(--dsw-alias-text-tertiary,#868a91);font-size:12.5px;line-height:1.6;margin-bottom:16px}',
    '.lc-card-actions{display:flex;gap:8px;justify-content:flex-end}',
    '.lc-action{padding:7px 14px;border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.12));border-radius:8px;font-size:13.5px;line-height:1.2;cursor:pointer;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-text-primary,#3c4043);transition:background .15s ease,color .15s ease,border-color .15s ease}',
    '.lc-action:hover{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.05))}',
    '.lc-action-primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}',
    '.lc-action-primary:hover{background:#3f5bf0}',
    '.lc-action-danger{background:#d9444a;border-color:#d9444a;color:#fff}',
    '.lc-action-danger:hover{background:#c5353a}',
    '.lc-esc-hint{color:var(--dsw-alias-text-tertiary,#b0b3b8);font-size:11.5px;margin-top:10px}',
    '.lc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-2,rgba(255,255,255,.72));backdrop-filter:blur(9px);-webkit-backdrop-filter:blur(9px)}',
    '.lc-overlay .lc-inner{text-align:center;max-width:520px;padding:48px;width:100%;color:var(--dsw-alias-text-primary,#1b1b1c)}',
    '.lc-circles{position:relative;width:96px;height:96px;margin:0 auto 26px}',
    '.lc-circles .lc-ring{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 42%,#4d6bfe 0%,#7b5bf2 100%);box-shadow:0 16px 44px rgba(77,107,254,.32);display:flex;align-items:center;justify-content:center;animation:breathe 2.1s ease-in-out infinite}',
    '.lc-circles .lc-ring .lc-sym{color:#fff;font-size:40px;line-height:1}',
    '.lc-circles .lc-glow{position:absolute;inset:-14px;border-radius:50%;background:radial-gradient(circle,rgba(77,107,254,.18),transparent 70%);animation:breatheGlow 2.1s ease-in-out infinite}',
    '.lc-title{font-size:24px;font-weight:650;margin:0 0 8px}',
    '.lc-sub{font-size:14px;color:var(--dsw-alias-text-secondary,#61666b);margin:0 0 6px;line-height:1.6}',
    '.lc-timer{font-size:13px;color:var(--dsw-alias-text-tertiary,#b0b3b8);font-variant-numeric:tabular-nums;margin-top:22px}',
    '.lc-inner.lc-done .lc-ring{background:radial-gradient(circle at 50% 42%,#188038 0%,#2aa64e 100%);box-shadow:0 16px 44px rgba(24,128,56,.30);animation:none}',
    '.lc-inner.lc-done .lc-glow{background:radial-gradient(circle,rgba(24,128,56,.16),transparent 70%);animation:none}',
    '.lc-inner.lc-err .lc-ring{background:radial-gradient(circle at 50% 42%,#d9444a 0%,#ef5350 100%);box-shadow:0 16px 44px rgba(217,68,74,.28);animation:none}',
    '.lc-inner.lc-err .lc-glow{background:radial-gradient(circle,rgba(217,68,74,.14),transparent 70%);animation:none}',
    '.lc-fail-actions{display:flex;gap:10px;justify-content:center;margin-top:24px}',
    '@keyframes breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.74;transform:scale(.97)}}',
    '@keyframes breatheGlow{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.94)}}',
    '.lc-hide{display:none!important}'
  ].join('');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // 按钮栏 fixed 定位在左下角（设置按钮上方），不依赖侧边栏 DOM 渲染时机。
  function mount() {
    if (document.getElementById(rootId)) return;
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    bar = el('div');
    bar.id = rootId;

    var btnRestart = el('button', 'lc-btn lc-btn-restart');
    btnRestart.setAttribute('aria-label', '重启 DSH');
    btnRestart.appendChild(el('span', 'lc-ico', '\\u21bb'));
    btnRestart.appendChild(document.createTextNode('重启'));
    btnRestart.addEventListener('click', function () { openConfirm('restart'); });

    var btnStop = el('button', 'lc-btn lc-btn-stop');
    btnStop.setAttribute('aria-label', '关闭 DSH');
    btnStop.appendChild(el('span', 'lc-ico', '\\u23fb'));
    btnStop.appendChild(document.createTextNode('关闭'));
    btnStop.addEventListener('click', function () { openConfirm('stop'); });

    bar.appendChild(btnRestart);
    bar.appendChild(btnStop);
    // Force horizontal layout via inline styles (DSH global CSS may override stylesheet rules)
    bar.style.cssText = 'position:fixed;z-index:900;display:inline-flex!important;flex-direction:row!important;align-items:center;gap:0;min-width:0;padding:4px 6px;border-radius:18px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.93));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.08));box-shadow:0 2px 12px var(--dsw-alias-shadow-1,rgba(0,0,0,.07));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;line-height:1.4;color:var(--dsw-alias-text-primary,#1b1b1c)';
    document.body.appendChild(bar);

    // Keep the bar pinned inside the DSH sidebar column (works expanded & collapsed rail)
    watchSidebar();

    // Integrate quota capsule into unified bottom-left bar
    integrateQuota();
    // Retry polling in case quota panel loads after this plugin (async)
    var quotaPoll = setInterval(function () {
      if (integrateQuota()) clearInterval(quotaPoll);
    }, 500);
    setTimeout(function () { clearInterval(quotaPoll); }, 15000);
  }

  /* Locate the DSH sidebar root (flex column, full height, left edge ≈ 0, contains a
     "new session" button among its direct children). CSS-module hashed class names are
     not stable across versions, so we detect by structure instead. */
  function findSidebarRoot() {
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.tagName !== 'DIV') continue;
      var cs = getComputedStyle(n);
      if (cs.display !== 'flex' || cs.flexDirection !== 'column') continue;
      var r = n.getBoundingClientRect();
      if (r.left > 2 || r.width < 40 || r.width > 560 || r.height < window.innerHeight * 0.7) continue;
      var kids = n.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].tagName === 'BUTTON' && /新建会话|New session|New Session/i.test(kids[k].getAttribute('aria-label') || '')) return n;
      }
    }
    return null;
  }

  var sidebarRoot = null, sidebarObserver = null;

  /* Re-measure the sidebar column and pin the bar (and any open card) inside it. */
  function applyGeometry() {
    if (!bar) return;
    // Enforce horizontal pill layout via inline styles (DSH global CSS may override stylesheet rules)
    bar.style.setProperty('display', 'inline-flex', 'important');
    bar.style.setProperty('flex-direction', 'row', 'important');
    bar.style.setProperty('align-items', 'center', 'important');
    if (!sidebarRoot || !sidebarRoot.isConnected) {
      sidebarRoot = findSidebarRoot();
      if (sidebarRoot && sidebarObserver) {
        sidebarObserver.disconnect();
        sidebarObserver = new ResizeObserver(function () { applyGeometry(); });
        sidebarObserver.observe(sidebarRoot);
      }
      if (!sidebarRoot) {
        bar.style.left = '12px'; bar.style.width = 'auto'; bar.style.maxWidth = '320px'; bar.style.bottom = '60px';
        bar.style.setProperty('flex-direction', 'row', 'important');
        bar.classList.remove('lc-rail');
        return;
      }
    }
    var s = sidebarRoot.getBoundingClientRect();
    var rail = s.width < 120;
    var mid = !rail && s.width < 210;
    var wasRail = bar.classList.contains('lc-rail');
    bar.classList.toggle('lc-rail', rail);
    bar.classList.toggle('lc-mid', mid);
    var qcap = document.getElementById('dsh-quota-capsule');
    var qcard = document.getElementById('dsh-quota-card');
    if (rail) {
      // Force quota back to capsule (card can't float over the rail)
      if (qcap && qcap.hidden && qcard) qcard.hidden = true;
      bar.style.left = (s.left + 10) + 'px';
      bar.style.width = '36px';
      bar.style.maxWidth = '36px';
      bar.style.setProperty('flex-direction', 'column', 'important');
      bar.style.bottom = (window.innerHeight - s.bottom + 60) + 'px';
    } else {
      // Leaving rail: restore the capsule so quota stays reachable
      if (wasRail && qcap) qcap.hidden = false;
      if (wasRail && qcard) qcard.hidden = true;
      bar.style.left = (s.left + 12) + 'px';
      bar.style.width = (s.width - 24) + 'px';
      bar.style.maxWidth = (s.width - 24) + 'px';
      bar.style.setProperty('flex-direction', 'row', 'important');
      bar.style.setProperty('justify-content', 'space-between', 'important');
      bar.style.bottom = (window.innerHeight - s.bottom + 60) + 'px';
    }
    // Confirm card & quota card open above the bar, aligned to its left edge
    var cards = document.querySelectorAll('.lc-card, #dsh-quota-card');
    var br = bar.getBoundingClientRect();
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      c.style.left = (br.left) + 'px';
      c.style.bottom = (window.innerHeight - br.top + 8) + 'px';
    }
  }

  /* In rail mode the quota capsule collapses to a status dot; sync its color and
     hover tooltip from the real capsule item states (quota plugin refreshes async). */
  function syncQuotaDot() {
    if (!bar || !bar.classList.contains('lc-rail')) {
      // Clean up tooltip when leaving rail mode
      if (railTip) { railTip.style.display = 'none'; }
      return;
    }
    var cap = document.getElementById('dsh-quota-capsule');
    if (!cap) return;
    var items = cap.querySelectorAll('.dsh-capsule-item');
    var worst = 'ok';
    var parts = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var txt = (it.textContent || '').trim();
      if (!txt) continue;
      parts.push(txt);
      if (it.classList.contains('state-error')) worst = 'error';
      else if (it.classList.contains('state-warn') && worst !== 'error') worst = 'warn';
    }
    bar.classList.toggle('lc-dot-error', worst === 'error');
    bar.classList.toggle('lc-dot-warn', worst === 'warn');
    bar.classList.toggle('lc-dot-ok', worst === 'ok');
    var tipText = parts.length ? parts.join(' · ') : '模型额度';
    cap.title = tipText;

    // Rail hover tooltip — create on first call
    if (!railTip) {
      railTip = el('div', 'lc-rail-tip');
      railTip.style.display = 'none';
      document.body.appendChild(railTip);
    }
    // Attach hover handlers once
    if (!cap._lcTipBound) {
      cap._lcTipBound = true;
      cap.addEventListener('mouseenter', function () {
        if (!bar.classList.contains('lc-rail')) return;
        var curTip = cap.title || '模型额度';
        railTip.textContent = curTip;
        var br = bar.getBoundingClientRect();
        railTip.style.left = (br.right + 6) + 'px';
        railTip.style.top = (br.top + 2) + 'px';
        railTip.style.opacity = '1';
        railTip.style.display = 'block';
      });
      cap.addEventListener('mouseleave', function () {
        railTip.style.opacity = '0';
        setTimeout(function () { railTip.style.display = 'none'; }, 150);
      });
    }
    // Update tooltip text even if handlers already bound
    if (railTip.style.display === 'block') railTip.textContent = tipText;
  }

  /* Observe sidebar width/position changes (collapse/expand, drag resize, window resize). */
  function watchSidebar() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      sidebarRoot = findSidebarRoot();
      if (sidebarRoot || tries > 30) {
        clearInterval(timer);
        if (sidebarRoot && !sidebarObserver) {
          sidebarObserver = new ResizeObserver(function () { applyGeometry(); });
          sidebarObserver.observe(sidebarRoot);
        }
        applyGeometry();
      } else {
        // Keep the bar visible in a safe default spot until the sidebar appears
        bar.style.left = '12px'; bar.style.width = 'auto'; bar.style.maxWidth = '320px'; bar.style.bottom = '60px';
        bar.classList.remove('lc-rail');
      }
    }, 250);
    window.addEventListener('resize', applyGeometry);

    // When the quota capsule/card toggles (click), re-pin the card above the bar
    var quotaM = new MutationObserver(function () {
      var qc = document.getElementById('dsh-quota-card');
      if (qc && !qc.hidden) {
        var br = bar.getBoundingClientRect();
        qc.style.left = br.left + 'px';
        qc.style.bottom = (window.innerHeight - br.top + 8) + 'px';
      }
      syncQuotaDot();
    });
    quotaM.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    // Periodic re-sync: quota values refresh async and status classes change over time
    setInterval(syncQuotaDot, 2000);
    applyGeometry();
  }

  /* Move #dsh-quota-panel into #dsh-lifecycle bar, add separator before buttons */
  function integrateQuota() {
    if (!bar) return false;
    var qp = document.getElementById('dsh-quota-panel');
    if (!qp || bar.contains(qp)) return !!qp;
    // Move quota panel to the front of the bar
    bar.insertBefore(qp, bar.firstChild);
    // Force quota panel to inline-flex row (override any DSH/quota-plugin CSS)
    qp.style.setProperty('display', 'inline-flex', 'important');
    qp.style.setProperty('flex-direction', 'row', 'important');
    qp.style.setProperty('align-items', 'center', 'important');
    qp.style.setProperty('position', 'static', 'important');
    qp.style.setProperty('right', 'auto', 'important');
    qp.style.setProperty('bottom', 'auto', 'important');
    qp.style.setProperty('left', 'auto', 'important');
    qp.style.setProperty('top', 'auto', 'important');
    qp.style.setProperty('margin', '0', 'important');
    // Add separator between quota capsule and restart button
    var sep = el('span', 'lc-sep');
    bar.insertBefore(sep, qp.nextSibling);
    return true;
  }

  function openConfirm(kind) {
    if (stage !== 'idle' && stage !== 'failed') return;
    closeCard();
    var isStop = kind === 'stop';
    try { localStorage.setItem('dsh_lastUrl', location.href); } catch (e) {}

    card = el('div', 'lc-card');
    card.appendChild(el('div', 'lc-card-title', isStop ? '关闭 DSH？' : '重启 DSH？'));
    card.appendChild(el('div', 'lc-card-desc',
      isStop ? '关闭 DSH？你可以随时从启动页重新打开。' : '重启 DSH？当前页面会短暂断开。'));
    card.appendChild(el('div', 'lc-card-sub',
      isStop ? '需要使用时，可以随时重新启动。' : '重启完成后会自动恢复当前页面。'));

    var actions = el('div', 'lc-card-actions');
    var cancel = el('button', 'lc-action', '取消');
    cancel.addEventListener('click', closeCard);
    var go = el('button', 'lc-action ' + (isStop ? 'lc-action-danger' : 'lc-action-primary'), isStop ? '关闭' : '重启');
    go.addEventListener('click', function () { if (isStop) doStop(); else doRestart(); });
    actions.appendChild(cancel);
    actions.appendChild(go);
    card.appendChild(actions);
    card.appendChild(el('div', 'lc-esc-hint', '按 Esc 取消'));

    document.body.appendChild(card);
    positionCard(card);
    function onKey(e) {
      if (e.key === 'Escape') { closeCard(); document.removeEventListener('keydown', onKey); }
    }
    document.addEventListener('keydown', onKey);
    card._onKey = onKey;
  }

  /* Place a floating card just above the bar (same left edge, above its top).
     The confirm card is a popup: keep a usable width even when the bar is a narrow rail. */
  function positionCard(cardEl) {
    if (!bar) return;
    var br = bar.getBoundingClientRect();
    var cardW = Math.max(220, Math.min(280, br.width));
    cardEl.style.left = br.left + 'px';
    cardEl.style.width = cardW + 'px';
    cardEl.style.bottom = (window.innerHeight - br.top + 8) + 'px';
  }

  function closeCard() {
    if (card) {
      if (card._onKey) document.removeEventListener('keydown', card._onKey);
      card.remove(); card = null;
    }
  }

  function showOverlay(symbol, title, sub, kind) {
    if (overlay) overlay.remove();
    overlay = el('div', 'lc-overlay');
    var inner = el('div', 'lc-inner');
    if (kind) inner.className = 'lc-inner ' + kind;
    var circles = el('div', 'lc-circles');
    circles.appendChild(el('div', 'lc-glow'));
    var ring = el('div', 'lc-ring');
    ring.appendChild(el('span', 'lc-sym', symbol));
    circles.appendChild(ring);
    inner.appendChild(circles);
    txTitle = el('h2', 'lc-title', title);
    txSub = el('p', 'lc-sub', sub);
    inner.appendChild(txTitle);
    inner.appendChild(txSub);
    txTimer = el('div', 'lc-timer', '');
    inner.appendChild(txTimer);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);
  }

  function setOverlayText(symbol, title, sub, kind) {
    if (!overlay) { showOverlay(symbol, title, sub, kind); return; }
    var inner = overlay.querySelector('.lc-inner');
    inner.className = 'lc-inner' + (kind ? ' ' + kind : '');
    var sym = inner.querySelector('.lc-sym');
    if (sym) sym.textContent = symbol;
    txTitle.textContent = title;
    txSub.textContent = sub;
  }

  function elapsed() { return startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0; }

  function tick() {
    if (!txTimer) return;
    var s = elapsed();
    txTimer.textContent = s ? ('已等待 ' + s + ' 秒') : '';
    if (stage === 'restarting') {
      if (s >= FAIL_AT) { showFailed(); }
      else if (s >= SLOW_AT) {
        setOverlayText('\\u21bb', '正在重启 DSH', '启动时间比平时稍长，请稍候……');
      }
    }
  }

  function doRestart() {
    closeCard();
    stage = 'restarting';
    startedAt = Date.now();
    oldBootId = null;
    showOverlay('\\u21bb', '正在重启 DSH', '请稍候……');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        tickTimer = setInterval(tick, 1000);
        fetch(API_RESTART, { method: 'POST', headers: { 'content-type': 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (d) {
            if (!d.ok) { enterFailed(); return; }
            oldBootId = d.instance && d.instance.bootId;
            setTimeout(function () {
              pollTimer = setInterval(pollHealth, POLL_MS);
              pollHealth();
            }, 2000);
          })
          .catch(function () { enterFailed(); });
      });
    });
  }

  function pollHealth() {
    if (stage === 'restored' || stage === 'failed') return;
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    fetch(API_HEALTH, { signal: ctrl.signal, cache: 'no-store' })
      .then(function (r) {
        clearTimeout(to);
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (d) {
        if (stage === 'restored' || stage === 'failed') return;
        if (d && d.ready && d.bootId && oldBootId && d.bootId !== oldBootId) {
          clearInterval(pollTimer); clearInterval(tickTimer);
          stage = 'reconnecting';
          setOverlayText('\\u2713', 'DSH 已重新启动', '正在恢复……', 'lc-done');
          txTimer.textContent = '';
          setTimeout(function () {
            stage = 'restored';
            location.reload();
          }, 900);
        } else {
          setOverlayText('\\u21bb', '正在重启 DSH', '请稍候……');
        }
      })
      .catch(function () {
        clearTimeout(to);
        if (stage !== 'restored' && stage !== 'failed') {
          setOverlayText('\\u21bb', '正在重启 DSH', '请稍候……');
        }
      });
  }

  function enterFailed() {
    stage = 'failed';
    clearInterval(pollTimer); clearInterval(tickTimer);
    setOverlayText('!', 'DSH 暂时没有启动成功', '可以再试一次。', 'lc-err');
    txTimer.textContent = '';
    if (overlay.querySelector('.lc-fail-actions')) return;
    var actions = el('div', 'lc-fail-actions');
    var retry = el('button', 'lc-action lc-action-primary', '重新启动');
    retry.addEventListener('click', function () { doRestart(); });
    var logs = el('button', 'lc-action', '打开恢复页');
    logs.addEventListener('click', function () { window.open(CONTROLLER, '_blank'); });
    actions.appendChild(retry);
    actions.appendChild(logs);
    overlay.querySelector('.lc-inner').appendChild(actions);
  }

  function doStop() {
    closeCard();
    stage = 'stopping';
    startedAt = Date.now();
    showOverlay('\\u23fb', '正在关闭 DSH', '请稍候……');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        fetch(API_STOP, { method: 'POST', headers: { 'content-type': 'application/json' } })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function () {
            setTimeout(function () { window.location.href = CONTROLLER; }, 600);
          })
          .catch(function () {
            setTimeout(function () { window.location.href = CONTROLLER; }, 600);
          });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
<\/script>`;
}

export function apply(ctx, config) {
  const { requestFile, stopFile, watchdogPidFile, controllerUrl } = normalizeConfig(config);
  const bootId = newBootId();

  ctx.effect(() => {
    const disposeRestart = ctx.webServer.register({
      kind: 'exact',
      path: '/api/restart',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        try {
          const restartId = newRestartId();
          const wd = await watchdogInfo(watchdogPidFile);
          await writeFile(requestFile, `restartId=${restartId} requested by restart-button at ${new Date().toISOString()}\\n`, 'utf8');
          sendJson(res, 200, {
            ok: true,
            restartId,
            watchdog: { available: wd.alive, pid: wd.pid },
            instance: { bootId, pid: process.pid },
            requestedAt: Date.now()
          });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      }
    });

    const disposeStop = ctx.webServer.register({
      kind: 'exact',
      path: '/api/stop',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        try {
          const actionId = newActionId('stop');
          const wd = await watchdogInfo(watchdogPidFile);
          await writeFile(stopFile, `stopId=${actionId} requested by restart-button at ${new Date().toISOString()}\\n`, 'utf8');
          sendJson(res, 200, { ok: true, actionId, watchdog: { available: wd.alive, pid: wd.pid } });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e) });
        }
      }
    });

    const disposeHealth = ctx.webServer.register({
      kind: 'exact',
      path: '/api/system/health',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        sendJson(res, 200, { ok: true, ready: true, bootId, pid: process.pid, uptime: process.uptime() });
      }
    });

    const disposeTap = ctx.webServer.tapIndex((html) =>
      html.replace('</body>', buildPageScript({ controllerUrl }) + '</body>'));

    return () => { disposeRestart(); disposeStop(); disposeHealth(); disposeTap(); };
  }, 'restart-button: lifecycle routes + index tap (V2)');
}
