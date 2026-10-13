# Общие пути и проверки для лаунчеров JARVIS под Windows.
# Подключается из start-jarvis.ps1 / stop-jarvis.ps1 / autostart.ps1 через dot-source.

$ErrorActionPreference = 'Stop'

$JarvisRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# Логи и pid держим вне репозитория и вне OneDrive.
$StateDir = Join-Path $env:LOCALAPPDATA 'JARVIS'
$PidFile  = Join-Path $StateDir 'jarvis.pid'
$LogFile  = Join-Path $StateDir 'jarvis.log'
$ErrFile  = Join-Path $StateDir 'jarvis.err.log'

$BridgePort = if ($env:JARVIS_BRIDGE_PORT) { [int]$env:JARVIS_BRIDGE_PORT } else { 8787 }
$FacePort   = if ($env:PORT) { [int]$env:PORT } else { 5173 }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# HTTP-проверка в обход системного прокси: VPN-клиент может выставить прокси,
# и запрос к 127.0.0.1 тогда уйдёт не туда.
function Test-Url([string]$Url) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = 2000
    $res = $req.GetResponse()
    $res.Close()
    return $true
  } catch [System.Net.WebException] {
    # Любой HTTP-ответ (даже 404) означает, что сервер жив.
    return [bool]$_.Exception.Response
  } catch {
    return $false
  }
}

function Test-Bridge { Test-Url "http://127.0.0.1:$BridgePort/health" }

# Vite занимает следующий свободный порт, если 5173 занят, — берём реальный из лога.
function Get-FacePort {
  if (Test-Path $LogFile) {
    $text = (Get-Content $LogFile -Raw -ErrorAction SilentlyContinue) -replace "$([char]27)\[[0-9;]*m", ''
    $m = [regex]::Matches([string]$text, 'Local:\s+https?://[^:/\s]+:(\d+)')
    if ($m.Count -gt 0) { return [int]$m[$m.Count - 1].Groups[1].Value }
  }
  return $FacePort
}

function Test-Face { Test-Url "http://127.0.0.1:$(Get-FacePort)/" }

# Процесс-лаунчер (node scripts/start.mjs), если он жив и это действительно он.
function Get-LauncherProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $id = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int]
  if (-not $id) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'scripts[\\/]start\.mjs') { return $p }
  return $null
}

# node-процессы, которые держат порты JARVIS (на случай осиротевших детей).
function Get-PortOwners {
  $ports = @($BridgePort, (Get-FacePort)) | Select-Object -Unique
  $ids = Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($id in $ids) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'bridge[\\/]server\.mjs|vite') { $p }
  }
}

function Stop-Jarvis {
  $stopped = $false
  $launcher = Get-LauncherProcess
  if ($launcher) {
    # /T — вместе с мостом и Vite, /F — без вопросов.
    & taskkill.exe /PID $launcher.ProcessId /T /F 2>&1 | Out-Null
    $stopped = $true
  }
  foreach ($p in @(Get-PortOwners)) {
    & taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Null
    $stopped = $true
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  return $stopped
}

function Get-BrowserPath {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Open-Jarvis {
  # localhost, а не 127.0.0.1: разрешение на микрофон в Chrome привязано к origin,
  # и пользователь уже выдавал его для http://localhost:5173.
  $url = "http://localhost:$(Get-FacePort)/"
  $browser = Get-BrowserPath
  if ($browser) { Start-Process -FilePath $browser -ArgumentList $url }
  else { Start-Process $url }
  return $url
}
