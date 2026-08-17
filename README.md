# dsh-lifecycle

[English](README.md) | [中文](README.zh.md)

**dsh-lifecycle** brings clean lifecycle controls to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web surface: **Restart** and **Stop** buttons in the sidebar, a macOS-style full-screen takeover while a restart is in progress, and an independent launch page that keeps working even after DSH has been stopped.

It is designed for regular users: no PIDs, no ports, no watchdog jargon in the UI. Behind the scenes a small set of marker files plus an external watchdog process do the real process management — the plugin never kills the host process itself (in-session restarts are suicidal, since the agent runs inside the host job object).

## Features

- **Restart** — confirm card → full-screen takeover overlay (soft blur + breathing icon) → automatic recovery when the new instance is ready. No manual refresh.
- **Stop** — confirm card → graceful stop via marker → redirect to the independent launch page.
- **Independent launch page** — served by `dsh-controller` on `http://127.0.0.1:3081/`; stays available after DSH stops, so you can always start DSH again.
- **True restart detection** — a per-boot `bootId` is compared across the restart; a stale HTTP 200 from the old instance is never mistaken for success.
- **Slow-start & failure states** — friendly copy at 45 s ("taking longer than usual") and a recovery card at 90 s with a retry button.
- **Zero technical jargon** in the user-facing UI.

## Architecture

```
Browser (DSH page / launch page)
        │
        ▼
┌────────────────────────────┐
│  dsh-controller (3081)     │  independent, keeps running when DSH stops
│  launch page + /api/status │
└──────────────┬─────────────┘
               │ writes markers only (never kills processes)
               ▼
┌────────────────────────────┐
│  watchdog (PowerShell)     │  polls marker files, owns the real lifecycle
│  restart/stop/start        │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│  DeepSeek Harness (3080)   │
└────────────────────────────┘
```

### Marker protocol

| Marker | Written by | Consumed by | Effect |
|---|---|---|---|
| `logs/restart.requested` | plugin `/api/restart` | watchdog | force-stop + start new instance |
| `logs/stop.requested` | plugin `/api/stop` | watchdog | stop DSH, keep controller up |
| `logs/start.requested` | controller `/api/start` | watchdog | start DSH |

## Installation

1. Copy the files into your DSH root (`<dsh-root>`, the directory containing `home/` and `node_modules/`):

   ```sh
   cp lib/dsh-restart-button.mjs   <dsh-root>/home/profiles/web/plugins/
   cp controller/dsh-controller.mjs <dsh-root>/
   cp scripts/Start-DSH-Watchdog.ps1 <dsh-root>/
   cp scripts/Start-DSH-Web-Detached.ps1 <dsh-root>/
   ```

2. Register the plugin in your profile patch (see `cordis.patch.yml` for a full example):

   ```yaml
   - insert:
       - id: restart-button
         name: './plugins/dsh-restart-button.mjs'
         inject: [webServer]
   ```

3. Start the watchdog (it also launches the controller on 3081):

   ```powershell
   pwsh -NoProfile -File Start-DSH-Watchdog.ps1 -IntervalSeconds 30
   ```

4. Restart DSH once so the plugin is loaded: write the restart marker

   ```powershell
   Set-Content logs/restart.requested -Value "requested" -Encoding utf8
   ```

   The watchdog performs the actual restart within ~30 s.

## Usage

- **Restart**: click the small ⟳ **Restart** button in the bottom-left sidebar (above Settings). Confirm. The page enters the takeover overlay and automatically reloads into the new instance.
- **Stop**: click the ⏻ **Stop** button, confirm. DSH stops, the browser is redirected to `http://127.0.0.1:3081/`.
- **Start**: on the launch page, click **Start DSH**. It returns to your previous URL automatically (stored in `localStorage.dsh_lastUrl`).

## Configuration

The plugin accepts these options (via the `config:` block in the profile patch):

| Option | Default | Description |
|---|---|---|
| `requestFile` | `<dsh-root>/logs/restart.requested` | restart marker path |
| `stopFile` | `<dsh-root>/logs/stop.requested` | stop marker path |
| `watchdogPidFile` | `<dsh-root>/logs/watchdog.pid` | watchdog pid file for status |
| `controllerUrl` | `http://127.0.0.1:3081/` | launch page URL |

The controller listens on `127.0.0.1:3081` only — never on `0.0.0.0`.

## Files

| Path | Purpose |
|---|---|
| `lib/dsh-restart-button.mjs` | host plugin: routes + injected page script |
| `controller/dsh-controller.mjs` | independent control service + launch page |
| `scripts/Start-DSH-Watchdog.ps1` | external watchdog, owns the lifecycle |
| `scripts/Start-DSH-Web-Detached.ps1` | detached launcher used by the watchdog |
| `docs/design-v2.md` | the V2 design baseline (EN) |
| `docs/design-v2.zh.md` | the V2 design baseline (ZH) |

## License

MIT
