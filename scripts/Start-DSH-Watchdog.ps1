[CmdletBinding()]
param(
  [int]$Port = 3080,
  [int]$IntervalSeconds = 30,
  [int]$CrashLoopMax = 3,
  [int]$CrashLoopWindowMinutes = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$dshRoot = $PSScriptRoot
# 脚本从 stdin 执行时 $PSScriptRoot 为空；此时回退到可配置的默认根目录
if (-not $dshRoot) { $dshRoot = 'C:\DSH' }
$logsPath = Join-Path $dshRoot 'logs'
$launcher = Join-Path $dshRoot 'Start-DSH-Web-Detached.ps1'
$controller = Join-Path $dshRoot 'dsh-controller.mjs'
$requestFile = Join-Path $logsPath 'restart.requested'
$stopFile = Join-Path $logsPath 'stop.requested'
$startFile = Join-Path $logsPath 'start.requested'
$watchLog = Join-Path $logsPath 'watchdog.log'
$controllerPort = 3081
$url = "http://127.0.0.1:$Port/"

New-Item -ItemType Directory -Path $logsPath -Force | Out-Null

# ———— 拉起控制服务 dsh-controller（127.0.0.1:3081）————
# 控制服务只写 marker、提供启动页，不直接杀进程；生命周期由本 watchdog 执行。
function Start-Controller {
  $listener = Get-NetTCPConnection -LocalPort $controllerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { return }
  if (-not (Test-Path -LiteralPath $controller)) {
    Write-WatchLog "controller script not found: $controller"
    return
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-WatchLog "node not found, cannot start controller"; return }
  try {
    Start-Process -FilePath $node -ArgumentList @($controller) -WorkingDirectory $dshRoot -WindowStyle Hidden | Out-Null
    Write-WatchLog "dsh-controller started on port $controllerPort"
  } catch {
    Write-WatchLog "failed to start controller: $_"
  }
}

function Stop-DshByPort {
  # 只终止 3080 端口上确认是 DSH 的监听进程；绝不误杀 watchdog/controller。
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $false }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.CommandLine -notmatch 'dsh.*lib[\\/]bin\.js') { return $false }
  Stop-Process -Id $proc.ProcessId -Force
  Write-WatchLog "stopped DSH (pid $($proc.ProcessId))"
  return $true
}

function Write-WatchLog {
  param([string]$Message)
  $line = "{0} [watchdog] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff K'), $Message
  Add-Content -LiteralPath $watchLog -Value $line -Encoding utf8
  Write-Host $line
}

function Write-RestartCompleted {
  param(
    [string]$RestartId,
    [int]$OldPid,
    [int]$NewPid,
    [bool]$Ok
  )
  $completedPath = Join-Path $logsPath 'restart.completed.jsonl'
  $entry = [pscustomobject]@{
    ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff K')
    restartId = $RestartId
    oldPid = $OldPid
    newPid = $NewPid
    ok = $Ok
  }
  Add-Content -LiteralPath $completedPath -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
}

function Test-DshListening {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return $false }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  return ($proc.CommandLine -match 'dsh.*lib[\\/]bin\.js.*web')
}

$recentRestarts = @()

Write-WatchLog "watchdog started (port $Port, interval ${IntervalSeconds}s, pid $PID)"

$stoppedFlag = Join-Path $logsPath 'stopped.flag'

while ($true) {
  Start-Sleep -Seconds $IntervalSeconds

  # 每轮尝试确保控制服务在线（只拉起，不重复）
  Start-Controller

  $restartRequested = Test-Path -LiteralPath $requestFile
  $stopRequested = Test-Path -LiteralPath $stopFile
  $startRequested = Test-Path -LiteralPath $startFile
  $userStopped = Test-Path -LiteralPath $stoppedFlag
  $listening = Test-DshListening

  # ---- 1. 重启 ----
  if ($restartRequested) {
    # Read marker content to extract restartId (V2 format: restartId=rst_xxx ...)
    $markerContent = Get-Content -LiteralPath $requestFile -Raw -ErrorAction SilentlyContinue
    $restartId = 'unknown'
    if ($markerContent -match 'restartId=(\S+)') {
      $restartId = $Matches[1]
    }
    Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
    # 重启 = 恢复自动拉起（清除手动停止标志）
    Remove-Item -LiteralPath $stoppedFlag -Force -ErrorAction SilentlyContinue
    $oldPid = 0
    $oldListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($oldListener) { $oldPid = $oldListener.OwningProcess }

    # —— 优雅延迟重启（V3）——
    # marker 可携带 graceSeconds=N（秒）。当由 agent 写 marker 触发时，用延迟字段
    # 留出宽限窗口：让当前 agent 回合先完成并回复用户，watchdog 到点后才真正重启，
    # 避免宿主被杀连带掐断正在执行的 Pwsh 命令（结果 unknown 的中断）。
    # 交互按钮（/api/restart）不携带该字段，默认即时重启，保持人工等待覆盖层 UX。
    $graceSeconds = 0
    if ($markerContent -match 'graceSeconds=(\d+)') {
        $graceSeconds = [int]$Matches[1]
    }

    Write-WatchLog "restart.requested detected (restartId=$restartId, graceSeconds=$graceSeconds) -> restarting DSH"
    $recentRestarts += (Get-Date)
    if ($graceSeconds -gt 0) {
        Write-WatchLog "graceful restart: waiting ${graceSeconds}s before restarting (letting current turn finish)"
        Start-Sleep -Seconds $graceSeconds
        Write-WatchLog "grace window elapsed -> restarting now"
    }
    $launcherOutput = & $launcher -ForceRestart -Port $Port 2>&1
    $newPid = 0
    $ok = $false
    foreach ($line in $launcherOutput) {
      if ($line -is [System.Management.Automation.ErrorRecord]) { continue }
      $parsed = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($parsed -and $parsed.ProcessId) {
        $newPid = $parsed.ProcessId
        $ok = [bool]$parsed.Ready
        break
      }
    }
    Write-RestartCompleted -RestartId $restartId -OldPid $oldPid -NewPid $newPid -Ok $ok
    continue
  }

  # ---- 2. 关闭 ----
  if ($stopRequested) {
    $markerContent = Get-Content -LiteralPath $stopFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Write-WatchLog "stop.requested detected -> stopping DSH (controller stays up)"
    $stopped = Stop-DshByPort
    if ($stopped) {
      Set-Content -LiteralPath $stoppedFlag -Value (Get-Date).ToString('o') -Encoding utf8
    }
    continue
  }

  # ---- 3. 启动 ----
  if ($startRequested) {
    Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stoppedFlag -Force -ErrorAction SilentlyContinue
    Write-WatchLog "start.requested detected -> starting DSH"
    & $launcher -Port $Port | Out-Null
    continue
  }

  # ---- 4. 被动宕机自动恢复（用户主动关闭时不拉起）----
  if (-not $listening -and -not $userStopped) {
    $cutoff = (Get-Date).AddMinutes(-$CrashLoopWindowMinutes)
    $recentRestarts = @($recentRestarts | Where-Object { $_ -ge $cutoff })
    if ($recentRestarts.Count -ge $CrashLoopMax) {
      Write-WatchLog "crash-loop guard: $($recentRestarts.Count) restarts in $CrashLoopWindowMinutes min, skipping recovery"
      Start-Sleep -Seconds ($CrashLoopWindowMinutes * 60)
      continue
    }
    Write-WatchLog "DSH web is DOWN (port $Port not listening) -> starting"
    $recentRestarts += (Get-Date)
    & $launcher -Port $Port | Out-Null
  } elseif (-not $listening -and $userStopped) {
    Write-WatchLog "DSH stopped by user; waiting for start.requested"
  }
}
