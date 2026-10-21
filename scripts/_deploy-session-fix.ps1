# Deploy session persistence fix to bitpype VPS and verify login → /me.
$ErrorActionPreference = 'Stop'
$HostName = 'root@187.77.16.73'
$Remote = '/root/website-scout-web'
$Local = Split-Path -Parent $PSScriptRoot

$files = @(
  'server.js',
  'server/sessionStore.js',
  'server/routes/auth.js',
  'server/routes/portal.js',
  'server/mailer.js',
  'src/mailjetSender.js',
  'public/js/app.js',
  'public/js/portal.js',
  'docker-compose.yml',
  '.env.example',
  'scripts/_probe-login-cookie.sh',
  'scripts/_vps-fix-nginx-www.sh',
  'scripts/_verify-session.sh',
  'scripts/_verify-dual-session.sh',
  'scripts/_seed-dual-portal-cred.js',
  'scripts/_vps-deploy-session.sh'
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

Write-Host 'Running remote deploy...'
ssh $HostName "chmod +x /root/website-scout-web/scripts/_vps-deploy-session.sh && bash /root/website-scout-web/scripts/_vps-deploy-session.sh"
Write-Host 'Deploy + verify complete.'
