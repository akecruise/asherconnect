param(
  [int]$CdpPort = 9223,
  [string]$ProfileName = 'AsherLineRenewChrome'
)
$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:LOCALAPPDATA $ProfileName
$cdpUrl = "http://127.0.0.1:$CdpPort/json/version"
try { $null = Invoke-WebRequest -Uri $cdpUrl -UseBasicParsing -TimeoutSec 2 } catch {
  if (-not (Test-Path $chrome)) { throw 'Chrome is not installed at the expected path' }
  Start-Process -FilePath $chrome -ArgumentList @(
    '--no-first-run',
    "--remote-debugging-port=$CdpPort",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$profile",
    'https://chat.line.biz/'
  )
  $ready = $false
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 1
    try { $null = Invoke-WebRequest -Uri $cdpUrl -UseBasicParsing -TimeoutSec 2; $ready = $true; break } catch {}
  }
  if (-not $ready) { throw "LINE Business Chrome did not open CDP port $CdpPort" }
}
$cookiePath = Join-Path $profile 'line-cookies.json'
$chatBotId = 'U0f8a4998da40e9e0fa908abd13be3793'
$chatUrl = "https://chat.line.biz/$chatBotId"
$null = & npx.cmd --yes agent-browser --session line-renew-win --cdp $CdpPort open $chatUrl
if ($LASTEXITCODE -ne 0) { throw 'Could not open LINE Business chat' }
$payload = & npx.cmd --yes agent-browser --session line-renew-win --cdp $CdpPort cookies get --json
if ($LASTEXITCODE -ne 0) { throw "Could not read the LINE Business browser session on CDP port $CdpPort" }
$document = ($payload -join "`n") | ConvertFrom-Json
$cookies = @($document.data.cookies)
if ($cookies.Count -eq 0) { $cookies = @($document.cookies) }
if ($cookies.Count -eq 0) { $cookies = @($document) }
$lineCookies = @($cookies | Where-Object { $_.domain -like '*line.biz' })
if ($lineCookies.Count -eq 0) { throw 'LINE Business is not signed in' }
$sessionCookie = @($lineCookies | Where-Object { $_.name -eq '__Host-chat-ses' }) | Select-Object -First 1
if (-not $sessionCookie) { throw 'LINE Business session cookie is missing; sign in again' }
$expiry = [DateTimeOffset]::FromUnixTimeSeconds([long][math]::Floor([double]$sessionCookie.expires))
if ($expiry -le [DateTimeOffset]::UtcNow.AddMinutes(15)) {
  throw 'LINE Business session expires within 15 minutes; sign in again'
}
$payload | Set-Content -Path $cookiePath -Encoding utf8
Write-Output "LINE session exported ($($lineCookies.Count) cookies; expires $($expiry.UtcDateTime.ToString('u')) UTC)"
