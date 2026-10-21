# Deploy multipage nav export fix; repair + republish site 1; verify live hrefs.
$ErrorActionPreference = 'Stop'
$HostName = 'root@187.77.16.73'
$Remote = '/root/website-scout-web'
$Local = Split-Path -Parent $PSScriptRoot

$files = @(
  'src/websiteEngine.js',
  'src/defaultDesignInstructions.js',
  'scripts/_test-preview-nav.js',
  'scripts/_repair-multipage-nav.js',
  'scripts/_vps-multipage-nav.sh'
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

Write-Host 'Running remote deploy + repair + republish...'
ssh -o StrictHostKeyChecking=accept-new $HostName "chmod +x /root/website-scout-web/scripts/_vps-multipage-nav.sh && /root/website-scout-web/scripts/_vps-multipage-nav.sh"

Write-Host 'Deploy + repair complete.'
