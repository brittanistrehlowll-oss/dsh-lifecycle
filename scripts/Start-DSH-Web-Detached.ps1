[CmdletBinding()]
param(
  [int]$Port = 3080,
  [switch]$ForceRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dshRoot = $PSScriptRoot
$dshHomePath = Join-Path $dshRoot 'home'
$dshCmd = Join-Path $dshRoot 'node_modules\.bin\dsh.cmd'
$logsPath = Join-Path $dshRoot 'logs'
$instanceLog = Join-Path $logsPath 'web.instance.jsonl'

if (-not (Test-Path -LiteralPath $dshCmd)) {
  throw "DSH launcher not found: $dshCmd"
}
if (-not (Test-Path -LiteralPath $dshHomePath)) {
  throw "DSH_HOME not found: $dshHomePath"
}

New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
$env:DSH_HOME = $dshHomePath

function Get-DshWebProcess {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  if ($proc.CommandLine -notmatch 'dsh.*lib[\\/]bin\.js.*web.*--port\s+3080') {
    # 端口被其他程序占用，不视为 DSH 实例
    return $null
  }
  return $proc
}

function Write-InstanceLog {
  param(
    [string]$Event,
    [int]$ProcId,
    [string]$Detail
  )
  $entry = [pscustomobject]@{
    ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff K')
    event = $Event
    pid = $ProcId
    detail = $Detail
  }
  Add-Content -LiteralPath $instanceLog -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
}

if (-not $ForceRestart) {
  $existing = Get-DshWebProcess
  if ($existing) {
    Write-InstanceLog -Event 'reuse' -ProcId ([int]$existing.ProcessId) -Detail "port $Port already served by DSH"
    [pscustomobject]@{
      ProcessId = $existing.ProcessId
      Url = "http://127.0.0.1:$Port/"
      DshHome = $dshHomePath
      Reused = $true
      CommandLine = $existing.CommandLine
    } | ConvertTo-Json -Compress
    exit 0
  }
}

if ($ForceRestart) {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    $old = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($old -and $old.CommandLine -match 'dsh.*lib[\\/]bin\.js') {
      Stop-Process -Id $old.ProcessId -Force
      Write-InstanceLog -Event 'force-stop' -ProcId ([int]$old.ProcessId) -Detail 'ForceRestart requested'
      Start-Sleep -Seconds 2
    }
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logsPath "web.detached-$stamp.stdout.log"
$stderrPath = Join-Path $logsPath "web.detached-$stamp.stderr.log"

$child = Start-Process `
  -FilePath $dshCmd `
  -ArgumentList @('web', '--host', '127.0.0.1', '--port', [string]$Port) `
  -WorkingDirectory $dshRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

Write-InstanceLog -Event 'start' -ProcId $child.Id -Detail "launched dsh web on port $Port"

# 等待就绪（最多 60 秒）
$ready = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 -UseBasicParsing
    if ($resp.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 3
  }
}

if (-not $ready) {
  Write-InstanceLog -Event 'start-failed' -ProcId $child.Id -Detail "no HTTP 200 on port $Port within 60s"
  [pscustomobject]@{
    ProcessId = $child.Id
    Url = "http://127.0.0.1:$Port/"
    Ready = $false
    StdoutLog = $stdoutPath
    StderrLog = $stderrPath
  } | ConvertTo-Json -Compress
  exit 1
}

Write-InstanceLog -Event 'ready' -ProcId $child.Id -Detail "HTTP 200 confirmed on port $Port"

[pscustomobject]@{
  ProcessId = $child.Id
  Url = "http://127.0.0.1:$Port/"
  DshHome = $dshHomePath
  Reused = $false
  Ready = $true
  StdoutLog = $stdoutPath
  StderrLog = $stderrPath
} | ConvertTo-Json -Compress
