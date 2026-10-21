# Verify site-previews image URL returns 200 with image bytes.
$ErrorActionPreference = 'Stop'
$HostName = 'root@187.77.16.73'
$Base = 'https://bitpype.com/site-previews/ws-1-site-1'

# Prefer a known asset; otherwise list from the app container export volume.
$first = 'openai-1791846348932-1.png'
$listed = ssh -o StrictHostKeyChecking=accept-new $HostName "cd /root/website-scout-web && docker compose exec -T app sh -c 'ls /root/website-scout-exports/ws-1-site-1/images 2>/dev/null | head -n 5'"
if ($listed) {
  $fromLs = ($listed -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim()
  if ($fromLs) { $first = $fromLs }
} else {
  Write-Host "WARN: images/ not listed yet; trying known filename $first"
}

$Url = "$Base/images/$first"
Write-Host "GET $Url"

$tmp = Join-Path $env:TEMP ("ws-preview-img-" + [guid]::NewGuid().ToString('n'))
try {
  $resp = Invoke-WebRequest -Uri $Url -Method GET -OutFile $tmp -PassThru -UseBasicParsing
  $len = (Get-Item $tmp).Length
  Write-Host "status=$($resp.StatusCode) bytes=$len content-type=$($resp.Headers['Content-Type'])"
  if ($resp.StatusCode -ne 200) { throw "Expected HTTP 200, got $($resp.StatusCode)" }
  if ($len -lt 32) { throw "Expected image bytes, got length $len" }
  Write-Host "OK image GET 200 for $Url"
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
