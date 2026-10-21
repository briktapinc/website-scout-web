# Deploy CSS QA guard files to VPS and rebuild docker app.
$ErrorActionPreference = 'Stop'
$HostName = 'root@187.77.16.73'
$Remote = '/root/website-scout-web'
$Local = Split-Path -Parent $PSScriptRoot

$files = @(
  'src/websiteEngine.js',
  'src/designJobs.js',
  'src/designReview.js',
  'server/domain.js',
  'scripts/_test-css-qa-guard.js',
  'scripts/_test-css-deliver-reject.js'
)

foreach ($f in $files) {
  $src = Join-Path $Local ($f -replace '/', '\')
  if (-not (Test-Path $src)) { throw "Missing local file: $src" }
  $remotePath = "$Remote/$f"
  $destDir = ($remotePath -replace '/[^/]+$', '')
  Write-Host "scp $f -> ${HostName}:$remotePath"
  ssh -o StrictHostKeyChecking=accept-new $HostName "mkdir -p '$destDir'"
  scp -o StrictHostKeyChecking=accept-new $src "${HostName}:$remotePath"
}

Write-Host 'Rebuilding docker app...'
ssh $HostName "cd $Remote && docker compose build app && docker compose up -d app && docker compose exec -T app node scripts/_test-css-qa-guard.js && docker compose exec -T app node scripts/_test-css-deliver-reject.js"
Write-Host 'Deploy complete.'
