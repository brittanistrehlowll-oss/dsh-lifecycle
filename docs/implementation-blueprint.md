# DSH 重启功能 V2 — Restart Takeover 设计文档

> 2026-08-14 20:35 沉淀。背景：V1（重启按钮 + watchdog 标记文件机制）已端到端验证通过。
> 本文档是 V2 的实现蓝图，供重启后的会话直接按此实现。

## 0. 结论与基线（不要重写）

- **V1 架构正确，保留**：DSH 内部只发出重启请求（写 `logs\restart.requested`），真正的进程重启交给外部 watchdog（`Start-DSH-Watchdog.ps1`）。绝不退回"Web 进程自己杀自己"。
- V1 闭环已验证：按钮 → 确认 → `POST /api/restart` → 写标记 → watchdog 检测 → DSH 退出 → 新实例拉起 → 页面恢复（证据：repair-report-20260814-1650.md、watchdog.log、web.instance.jsonl）。
- V2 目标：重启期间浏览器完全接管（Restart Takeover Mode），用户看到的是"受控重启进度"，而不是连接断开/白屏；并用 bootId 消除"HTTP 200 误判重启完成"的 race condition。

## 1. V2 目标闭环

```
按钮 → 确认 → 浏览器先进入 Restart Takeover Mode（UI 先接管）
  → POST /api/restart（拿到 restartId + oldBootId）
  → watchdog 接管：SIGTERM 优雅终止旧 DSH → 等待退出（超时兜底强杀）
  → 启动新 DSH → 健康检查 → 验证新 bootId
  → 浏览器后台轮询 /api/system/health
  → 发现新 bootId（≠ oldBootId 且 ready=true）→ 恢复原会话/页面
```

**关键原则：一旦用户确认重启，UI 不能再依赖 DSH 服务端。** 即使 3080 完全消失 20 秒，页面依然稳定显示进度。

## 2. 页面效果（全屏接管层）

确认后：整个页面轻微模糊、变暗，覆盖全屏接管层：

```
┌──────────────────────────────────────────────┐
│                     ◉ DSH                     │
│                 正在安全重启                   │
│   ● 保存当前状态              已完成          │
│   ● 请求 Watchdog 接管        已完成          │
│   ◌ 停止旧实例                进行中          │
│   ○ 启动新实例                                │
│   ○ 恢复连接                                  │
│                  12 秒                        │
│       当前页面会自动恢复，无需手动刷新         │
│               [ 查看详情 ]                    │
└──────────────────────────────────────────────┘
```

不做普通 loading spinner。核心信息：**DSH 没有崩，正在被受控重启。**

## 3. 状态机（前端）

```ts
type RestartState =
  | "idle"        // 未开始
  | "requesting"  // 正在提交重启请求
  | "accepted"    // 服务端已接受（拿到 restartId）
  | "stopping"    // watchdog 正在终止旧实例
  | "offline"     // DSH 已离线（3080 无响应）
  | "starting"    // 新实例启动中
  | "reconnecting"// 探测到 HTTP 响应，正在验证 bootId
  | "restored"    // 重启完成，恢复页面
  | "failed"      // 超时未恢复
```

用户可见文案简化：
`准备重启 → 正在关闭 DSH → DSH 已离线 → 正在启动 DSH → 正在恢复连接 → 重启完成`

## 4. 核心协议升级（消除 race condition）

### 4.1 DSH 启动时生成 bootId

```json
{
  "bootId": "dsh-20260814-173045-a8f3",
  "pid": 29860,
  "startedAt": "2026-08-14T17:30:48+08:00",
  "ready": true
}
```

### 4.2 新增健康检查端点

```http
GET /api/system/health
```

```json
{
  "ok": true,
  "ready": true,
  "bootId": "a8f3e72c",
  "pid": 29860,
  "uptime": 14.2
}
```

### 4.3 重启成功判定（三者缺一不可）

```
HTTP 200 AND ready === true AND bootId !== oldBootId
```

否则存在隐蔽 race：`POST /restart` 后浏览器立刻 GET /，旧 DSH 还没退出，返回 200 → 误判"已重启"。

### 4.4 /api/restart 响应升级

```json
{
  "ok": true,
  "restartId": "rst_20260814_173045_7f29",
  "watchdog": { "available": true, "pid": 36940 },
  "instance": { "bootId": "old-a72f", "pid": 29860 },
  "requestedAt": 1786709445000
}
```

前端所有后续状态围绕 `restartId` 追踪。

## 5. Watchdog → Restart Supervisor（V2 内实现）

职责清单：

```
DSH Web ── restart.requested ──▶ Restart Supervisor
  ├─ 确认请求
  ├─ 记录旧 PID
  ├─ SIGTERM（优雅，DSH 对 SIGINT/SIGTERM 有正常 Cordis root dispose）
  ├─ 等待正常退出（10 s）
  ├─ 超时兜底强杀（仅匹配 DSH 命令行，复用 Start-DSH-Web-Detached.ps1 -ForceRestart 的匹配逻辑）
  ├─ 启动新实例
  ├─ 等待 3080
  ├─ 健康检查（HTTP 200 + ready）
  ├─ 验证新 bootId
  └─ 记录 restart.completed（restartId → newBootId 映射，供前端核对）
```

**优雅终止优先**：`SIGTERM → 等 10 s → 正常退出则启动新实例；否则强制终止 → 启动`。

## 6. 前端接管实现要点（最容易踩坑的地方）

1. **UI 先接管，再触发服务器重启**（顺序必须如此）：
   ```ts
   showRestartTakeover()
   await nextPaint()
   const response = await fetch("/api/restart", { method: "POST" })
   ```
   绝不能 `await fetch(...)` 之后再显示接管层——POST 成功后 watchdog 可能极快触发，服务器退出，前端后续逻辑变得不确定。

2. **接管期间不要 `location.reload()` 循环**。正确方式：
   ```
   当前 SPA 保持存活 → 后台 fetch health → 发现新 bootId → 重新初始化 API connection → 必要时最后 reload 一次
   ```
   MVP 底线：保持接管页 → 发现新实例 ready → 显示「正在恢复工作区」→ `location.reload()` 一次。用户感知不到 ERR_CONNECTION_REFUSED。

3. **超时失败处理**（60 s 未恢复）：
   ```
   ⚠ DSH 尚未恢复
   Watchdog 已收到重启请求，但新实例暂未通过健康检查。
   旧实例：PID xxx  Watchdog：PID xxx  等待时间：61 秒
   [继续等待]  [再次启动 DSH]   查看详细信息
   ```
   不要直接显示"重启失败"，可能只是启动慢：
   ```
   0–45 s     正在重启
   45–90 s    启动时间较长
   >90 s      未能恢复
   ```

## 7. Agent 活动检测（安全重启，最终形态）

点击按钮时先判断 `activeAgents / activeTools / activeSubprocesses / pendingWrites`：

- 无任务 → 现在重启
- 有任务 → 弹窗列出正在执行的任务，提供：
  - `[等待任务完成后自动重启]`
  - `[立即重启]`

最终形态支持三种模式：`○ 立即重启 / ● 安全重启（等 Agent 进入安全点）/ ○ 强制重启`。

## 8. Watchdog 开机自启（必须做）

当前单点风险：DSH 正常但 watchdog 不存在 → 重启按钮只是无执行器的控制面。

- 方案：注册计划任务（Task Scheduler）或启动项，`Windows 登录 → Restart Supervisor 启动`。
- 远期 V3：Supervisor 成为 DSH 的父进程（Supervisor └── DSH），DSH 变成 child process，统一管理 Start/Stop/Restart/Crash Recovery/Health/PID/Logs/Boot ID/Auto Start。
- V3 后，关闭按钮、崩溃自动恢复、版本更新后自动重启、插件变更后重启全部复用同一 supervisor。

## 9. 版本规划

- **V1（已完成并验证）**：安全请求 + watchdog + restart.requested + UI 按钮 + watchdog 检测 + 自动恢复。
- **V2（本设计）**：① Full-screen takeover ② restartId ③ bootId ④ /api/system/health ⑤ graceful SIGTERM ⑥ startup health check ⑦ browser reconnect ⑧ timeout/recovery UI ⑨ watchdog 自启动。
- **V3（远期）**：DSH Process Supervisor（统一生命周期管理）。

## 10. 实施步骤（重启后按序执行）

1. 后端：`/api/system/health` + bootId（DSH 宿主启动时生成并记录；可从 `web.instance.jsonl` 的 pid/ts 派生，或插件内存生成）。
2. 后端：`/api/restart` 响应升级（restartId + watchdog 信息 + instance bootId/pid）。
3. watchdog：SIGTERM 优雅终止优先 + 10s 等待 + 超时强杀（复用现有 -ForceRestart 匹配逻辑）；记录 restart.completed（restartId → newBootId）。
4. 前端：`dsh-restart-button.mjs` 页面脚本升级为接管层（状态机 + 进度步骤 + 倒计时 + 后台 health 轮询 + bootId 对比 + 超时 UI + 最后 reload 一次）。
5. 可选：Agent 活动检测（读 session 状态 API 判断 active agents）。
6. 可选：watchdog 注册计划任务自启（需用户确认）。
7. 端到端验证：POST /api/restart → 观察接管页 → watchdog 重启 → 新 bootId 出现 → 页面恢复；核对 watchdog.log / web.instance.jsonl。

## 11. 相关文件清单

- 插件：`<dsh-root>\home\profiles\web\plugins\dsh-restart-button.mjs`（V1 基线，V2 升级前端）
- 配置：`<dsh-root>\home\profiles\web\cordis.patch.yml`（restart-button 条目）
- watchdog：`<dsh-root>\Start-DSH-Watchdog.ps1`（V2 升级为 supervisor 行为）
- 启动器：`<dsh-root>\Start-DSH-Web-Detached.ps1`（-ForceRestart 匹配逻辑，SIGTERM 改造参考）
- 报告：`<dsh-root>\repair-report-20260814-1650.md`（V1 端到端证据）
- 日志：`<dsh-root>\logs\watchdog.log`、`logs\web.instance.jsonl`
