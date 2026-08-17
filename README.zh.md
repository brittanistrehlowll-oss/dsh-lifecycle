# dsh-lifecycle

[English](README.md) | 中文

**dsh-lifecycle** 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端提供完整的生命周期控制：侧边栏的 **重启 / 关闭** 按钮、重启过程中的 macOS 风格全屏接管界面，以及 DSH 停止后仍可用的**独立启动页面**。

面向普通用户设计：界面不出现 PID、端口、Watchdog 等技术名词。真正的进程管理由一组标记文件 + 外部 watchdog 进程完成——插件绝不直接终止宿主进程（会话内重启是自杀式的，因为 agent 运行在宿主作业对象内）。

## 功能

- **重启** —— 确认卡片 → 全屏接管层（柔和模糊 + 呼吸图标）→ 新实例就绪后自动恢复，无需手动刷新。
- **关闭** —— 确认卡片 → 通过标记优雅停止 → 自动跳转独立启动页。
- **独立启动页** —— 由 `dsh-controller` 在 `http://127.0.0.1:3081/` 提供；DSH 停止后依然可用，随时可以再次启动 DSH。
- **真正的重启判定** —— 每次启动生成 `bootId`，重启前后比对；旧实例残留的 HTTP 200 不会被误判为成功。
- **慢启动与失败状态** —— 45 秒显示「启动时间比平时稍长」，90 秒出现恢复卡片（可重试）。
- **界面零技术名词**。

## 架构

```
浏览器（DSH 页面 / 启动页）
        │
        ▼
┌────────────────────────────┐
│  dsh-controller (3081)     │  独立进程，DSH 停止后仍运行
│  启动页 + /api/status      │
└──────────────┬─────────────┘
               │ 只写标记文件（绝不杀进程）
               ▼
┌────────────────────────────┐
│  watchdog（PowerShell）     │  轮询标记，负责真正的生命周期
│  restart / stop / start    │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│  DeepSeek Harness (3080)   │
└────────────────────────────┘
```

### 标记协议

| 标记文件 | 写入方 | 消费方 | 效果 |
|---|---|---|---|
| `logs/restart.requested` | 插件 `/api/restart` | watchdog | 强制停止 + 启动新实例 |
| `logs/stop.requested` | 插件 `/api/stop` | watchdog | 停止 DSH，控制器保持运行 |
| `logs/start.requested` | 控制器 `/api/start` | watchdog | 启动 DSH |

## 安装

1. 将文件复制到 DSH 根目录（`<dsh-root>`，即包含 `home/` 与 `node_modules/` 的目录）：

   ```sh
   cp lib/dsh-restart-button.mjs   <dsh-root>/home/profiles/web/plugins/
   cp controller/dsh-controller.mjs <dsh-root>/
   cp scripts/Start-DSH-Watchdog.ps1 <dsh-root>/
   cp scripts/Start-DSH-Web-Detached.ps1 <dsh-root>/
   ```

2. 在 profile 补丁中注册插件（完整示例见 `cordis.patch.yml`）：

   ```yaml
   - insert:
       - id: restart-button
         name: './plugins/dsh-restart-button.mjs'
         inject: [webServer]
   ```

3. 启动 watchdog（它会顺带拉起 3081 控制器）：

   ```powershell
   pwsh -NoProfile -File Start-DSH-Watchdog.ps1 -IntervalSeconds 30
   ```

4. 重启一次 DSH 以加载插件：写入重启标记

   ```powershell
   Set-Content logs/restart.requested -Value "requested" -Encoding utf8
   ```

   watchdog 会在约 30 秒内完成实际重启。

## 使用

- **重启**：点击左下角侧边栏（设置按钮上方）的小型 ⟳ **重启** 按钮，确认。页面进入接管层，新实例就绪后自动重新加载。
- **关闭**：点击 ⏻ **关闭** 按钮，确认。DSH 停止，浏览器跳转到 `http://127.0.0.1:3081/`。
- **启动**：在启动页点击 **启动 DSH**。完成后自动回到关闭前的页面（记录于 `localStorage.dsh_lastUrl`）。

## 配置

插件支持以下选项（通过 profile 补丁的 `config:` 块）：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `requestFile` | `<dsh-root>/logs/restart.requested` | 重启标记路径 |
| `stopFile` | `<dsh-root>/logs/stop.requested` | 关闭标记路径 |
| `watchdogPidFile` | `<dsh-root>/logs/watchdog.pid` | watchdog PID 文件（状态探测用） |
| `controllerUrl` | `http://127.0.0.1:3081/` | 启动页地址 |

控制器只监听 `127.0.0.1:3081`，绝不监听 `0.0.0.0`。

## 文件

| 路径 | 用途 |
|---|---|
| `lib/dsh-restart-button.mjs` | 宿主插件：路由 + 注入页面脚本 |
| `controller/dsh-controller.mjs` | 独立控制服务 + 启动页 |
| `scripts/Start-DSH-Watchdog.ps1` | 外部 watchdog，负责生命周期 |
| `scripts/Start-DSH-Web-Detached.ps1` | 分离式启动器（watchdog 调用） |
| `docs/design-v2.md` | V2 设计基线（英文） |
| `docs/design-v2.zh.md` | V2 设计基线（中文） |

## 许可证

MIT
