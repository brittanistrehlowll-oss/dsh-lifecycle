# DSH Lifecycle Design Baseline (V2.0)

> Full Chinese specification: [design-v2.zh.md](design-v2.zh.md)

**Goal:** Give DeepSeek Harness Web a complete, stable, low-cognitive-load Start / Restart / Stop experience, with an independent launch page that survives DSH shutdown.

## Core principles

1. **Users see three actions only** — Start, Restart, Stop. Never expose PID, watchdog, boot ID, health checks, ports, or restart requests in the UI.
2. **macOS-like experience** — generous whitespace, central focus, minimal copy, soft gradients, subtle glow, simple state changes, auto-advance between states.
3. **Complex backend, simple frontend** — the UI only ever says "Starting…", "Taking longer than usual…", "Did not start successfully."
4. **The control page must outlive DSH** — "Start DSH" must never depend on a stopped DSH. A local control service owns the lifecycle.
5. **Recover automatically** — no manual refresh, no re-entering, no re-selecting sessions.
6. **Do not disturb the DSH UI** — lifecycle is an enhancement layer; only the bottom of the left sidebar gains controls.

## Two surfaces

### Page A — running DSH

Buttons inserted at the bottom of the left sidebar, above Settings:

```
┌──────────────┬──────────────┐
│   ↻ Restart  │   ⏻ Stop     │
└──────────────┴──────────────┘
```

- Height 38 px, radius 9 px, subtle gray border, dark gray text, 14 px font / 16 px icon.
- Restart hover: slightly darker background, icon rotates 15–25°.
- Stop hover: warm red text/border appear only on hover.

### Page B — independent launch page

Served by the control service (`127.0.0.1:3081`), survives DSH shutdown:

```
                DSH Logo
           DeepSeek Harness
              DSH 已关闭 (DSH is stopped)
   需要使用时，可以随时重新启动。 (Start it again anytime)
            [ ▶ 启动 DSH ]
               查看日志 (View logs)
```

- Soft cold-white gradient background, centered composition, logo 48–64 px with gentle breathing animation (1.8–2.2 s loop).
- Single primary action, blue, 220–260 × 46–50 px, radius 12–14 px.
- "View logs" is a weak text link only.
- States: stopped → starting ("usually a few seconds") → slow-start hint (>15 s) → success ("DSH 已启动 / 正在为你打开…", 600–1000 ms, auto-redirect) → failure ("暂时没有启动成功", retry + logs).

## Restart flow

```
click restart → confirm card → show takeover UI → wait one paint → POST restart
→ watchdog stops old instance → starts new instance
→ health probe confirms NEW instance (bootId changed) → "已重新启动 / 正在恢复…" → reload
```

- **Order is mandatory:** ① show takeover UI, ② wait for a browser paint, ③ then send the restart request — never the reverse.
- Takeover: current page dims (opacity 0.2–0.3, blur 6–10 px), centered breathing icon, "正在重启 DSH / 请稍候……".
- Success: ✓ "DSH 已重新启动 / 正在恢复……" for 500–1000 ms, then reload back to the previous URL/session.

## Stop flow

```
click stop → confirm (red) → save page info → switch to launch page → then stop DSH
```

Switching to the independent page **before** stopping DSH prevents `ERR_CONNECTION_REFUSED`.

## Startup

- From the launch page: disable double-clicks, show "正在启动 DSH / 通常只需要几秒钟", poll status, auto-return to the previous URL (or DSH home).
- Success requires: HTTP reachable + core endpoint responds + new instance ready.

## Backend

- Control service: `dsh-controller`, listens on `127.0.0.1:3081` only, never `0.0.0.0`.
- API: `GET /api/status`, `POST /api/start|stop|restart`, `GET /api/logs`. States: `running|stopped|starting|stopping|restarting|error`.
- Internal instance ID (bootId) must change across a real restart — an HTTP 200 alone is never proof of success.
- Lifecycle lock: only one lifecycle action at a time; concurrent actions return `busy`.
- Windows auto-start of the control service (Phase 2), optional `autoStartDSH` config.
- Security: localhost-only, Host/Origin checks, POST-only lifecycle, no arbitrary shell, whitelisted params.

## Migration path

1. **Phase 1 (current):** keep `restart.requested`; add `stop.requested` / `start.requested`; ship the new UI (page A buttons + takeover + page B launch page).
2. **Phase 2:** unify all three requests into `dsh-controller`.
3. **Phase 3:** replace file-polling with an IPC/HTTP lifecycle interface.

## Copy table (recommended)

| Scenario | Copy |
|---|---|
| Restart confirm | 重启 DSH？ / Restart DSH? |
| Restart note | 重启过程中页面会暂时无法使用，完成后会自动恢复。 |
| Data note | 当前会话和设置不会被删除。 |
| Restarting | 正在重启 DSH |
| Restart done | DSH 已重新启动 / 正在恢复…… |
| Stop confirm | 关闭 DSH？ |
| Stopped | DSH 已关闭 / 需要使用时，可以随时重新启动。 |
| Start | 启动 DSH |
| Starting | 正在启动 DSH / 通常只需要几秒钟 |
| Slow start | 启动时间比平时稍长，请稍候…… |
| Started | DSH 已启动 / 正在为你打开…… |
| Failed | DSH 暂时没有启动成功 / 可以再试一次。 |
| Auxiliary | 查看日志 |

## Forbidden in user-facing copy

`Watchdog`, `Supervisor`, `Daemon`, `PID`, `Process`, `Port`, `Boot ID`, `Health Check`, `Host`, `Child Process`, `SIGTERM`, `IPC`, `Restart Flag`, `Kill Process` — these belong only in detailed/developer logs.

## Acceptance criteria (V2)

- [ ] Restart & Stop buttons in the bottom-left sidebar, matching DSH style
- [ ] No technical jargon in normal pages
- [ ] Launch page is macOS-like, one strong primary action
- [ ] Restart: confirm → no browser error → auto-detect new DSH → confirmed real restart → restore session
- [ ] Stop: confirm → launch page shown before DSH stops → page still usable → no ERR_CONNECTION_REFUSED
- [ ] Start: no double-click → starting state → slow-start state → failure state → auto-enter DSH → restore previous page
- [ ] Backend: mutual exclusion, controller independent of DSH, localhost-only, auto-start on login, full lifecycle logging
