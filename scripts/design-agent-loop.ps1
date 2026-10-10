# Durable Website Scout design-queue ticker.
# Emits AGENT_LOOP_TICK_design_queue every IntervalSeconds so a Cursor agent can wake and act.
# State: %APPDATA%\website-scout\design-agent-loop-state.json

param(
  [int]$IntervalSeconds = 120,
  [string]$StatePath = $(Join-Path $env:APPDATA 'website-scout\design-agent-loop-state.json'),
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
$sentinel = 'AGENT_LOOP_TICK_design_queue'
$prompt = @'
Check Website Scout design queue (APP DATA websitescout.db + design-agent-trigger.json). Use designJobs API or MCP design.pending/design.next/design.deliver. Skip jobs already delivered or in_progress. Skip job ids listed in design-agent-loop-state.json skip_job_ids only. Distinguish redesign (full rethink) vs improvements (incremental polish). Never invent business facts — only verified_facts from brief. If a claimable job has verified facts, claim it, implement, deliver. Job #6 is an empty no-lead job — do not permanently skip; leave until user links a lead or cancels. Update design-agent-loop-state.json last_check.
'@

function Write-State([hashtable]$Patch) {
  $dir = Split-Path -Parent $StatePath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $stateObj = [ordered]@{}
  if (Test-Path $StatePath) {
    try {
      $raw = Get-Content -Raw $StatePath | ConvertFrom-Json
      foreach ($p in $raw.PSObject.Properties) { $stateObj[$p.Name] = $p.Value }
    } catch { }
  }
  foreach ($k in $Patch.Keys) { $stateObj[$k] = $Patch[$k] }
  $json = $stateObj | ConvertTo-Json -Depth 10
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($StatePath, $json, $utf8NoBom)
}

$pidHere = $PID
Write-State @{
  name             = 'design_queue'
  started_at       = [DateTime]::UtcNow.ToString('o')
  interval_seconds = $IntervalSeconds
  shell_pid        = $pidHere
  sentinel         = $sentinel
  loop_alive       = $true
  loop_script      = $PSCommandPath
  prompt           = $prompt.Trim()
  skip_job_ids     = @()
  skip_reasons     = @{}
}

Write-Output ("{0} READY pid={1} interval={2}s state={3}" -f $sentinel, $pidHere, $IntervalSeconds, $StatePath)

function Emit-Tick {
  $payload = @{
    at       = (Get-Date).ToUniversalTime().ToString('o')
    pid      = $PID
    prompt   = $prompt.Trim()
    interval = $IntervalSeconds
  } | ConvertTo-Json -Compress
  Write-Output ("{0} {1}" -f $sentinel, $payload)
}

if ($Once) {
  Emit-Tick
  exit 0
}

while ($true) {
  Start-Sleep -Seconds $IntervalSeconds
  try {
    Write-State @{
      shell_pid  = $PID
      loop_alive = $true
      last_tick_emit = (Get-Date).ToUniversalTime().ToString('o')
    }
  } catch { }
  Emit-Tick
}
