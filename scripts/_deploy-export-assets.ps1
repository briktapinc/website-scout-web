# Deploy export/image + Cloudflare hash fixes; rematerialize site 1 preview; verify image GET.
$ErrorActionPreference = 'Stop'
$HostName = 'root@187.77.16.73'
$Remote = '/root/website-scout-web'
$Local = Split-Path -Parent $PSScriptRoot

$files = @(
  'package.json',
  'package-lock.json',
  'src/websiteEngine.js',
  'src/openPreview.js',
  'src/designJobs.js',
  'src/cloudflare.js',
  'src/mcp.js',
  'server/domain.js',
  'scripts/_test-export-assets.js',
  'scripts/_rematerialize-site1.js',
  'scripts/_vps-post-deploy.sh',
  'scripts/_verify-preview-image.ps1'
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

Write-Host 'Rebuilding docker app (no cache for deps)...'
ssh $HostName "cd /root/website-scout-web && docker compose build --no-cache app"
Write-Host 'Running post-deploy checks...'
ssh $HostName "chmod +x /root/website-scout-web/scripts/_vps-post-deploy.sh && /root/website-scout-web/scripts/_vps-post-deploy.sh"

Write-Host 'Verifying public image URL...'
& (Join-Path $PSScriptRoot '_verify-preview-image.ps1')

Write-Host 'Deploy + verify complete.'
