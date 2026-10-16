# Запуск JARVIS одним щелчком (ярлык на рабочем столе / автозапуск).
#
# Поднимает `node scripts/start.mjs` (мост + интерфейс) как скрытый фоновый
# процесс, ждёт, пока обе половины ответят, и открывает интерфейс в Chrome/Edge.
# Окно этого скрипта можно закрыть — JARVIS продолжит работать в фоне.
# Если JARVIS уже запущен, второй копии не будет: просто откроется браузер.
# Если запущена только половина (зависший мост или Vite), она перезапускается.
#
#   -NoBrowser  не открывать браузер (для автозапуска при входе в Windows)
#   -Writes     разрешить JARVIS реальные действия (как `npm start -- --writes`)
#   -CalendarWrites  разрешить только запись в Google Календарь
#               (как `npm start -- --calendar-writes`); каждое действие всё равно
#               выполняется лишь после своего слова — «записывай», «удаляй»…

param(
  [switch]$NoBrowser,
  [switch]$Writes,
  [switch]$CalendarWrites
)

. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'JARVIS — запуск'

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Finish([int]$Code, [int]$Seconds = 3) {
  if ($Code -ne 0 -and -not $NoBrowser) {
    Say ''
    Say 'Нажмите Enter, чтобы закрыть окно.' 'Yellow'
    [void](Read-Host)
  } elseif (-not $NoBrowser) {
    Start-Sleep -Seconds $Seconds
  }
  exit $Code
}

function Wait-Ready([int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Test-Bridge) -and (Test-Face)) { return $true }
    if (-not (Get-LauncherProcess)) { return $false }
    Write-Host '.' -NoNewline -ForegroundColor DarkCyan
    Start-Sleep -Milliseconds 700
  }
  return $false
}

Say ''
Say '  J.A.R.V.I.S.' 'Cyan'
Say "  папка: $JarvisRoot" 'DarkGray'
Say ''

# 1. Уже работает целиком — не плодим дубликаты.
if ((Test-Bridge) -and (Test-Face)) {
  Say 'JARVIS уже запущен.' 'Green'
  if (-not $NoBrowser) { Say "Открываю $(Open-Jarvis)" }
  Finish 0 2
}

# 2. Лаунчер жив, но ещё не готов — возможно, он просто стартует.
if (Get-LauncherProcess) {
  Say 'JARVIS уже стартует, жду готовности' -Color Gray
  if (Wait-Ready 45) {
    Say ''
    Say 'JARVIS готов.' 'Green'
    if (-not $NoBrowser) { Say "Открываю $(Open-Jarvis)" }
    Finish 0 2
  }
  Say ''
}

# 3. Что-то осталось наполовину (например, после сбоя) — убираем перед запуском.
if ((Get-LauncherProcess) -or @(Get-PortOwners).Count -gt 0) {
  Say 'Найден незавершённый запуск JARVIS — останавливаю его.' 'Yellow'
  [void](Stop-Jarvis)
  Start-Sleep -Seconds 1
}

# 4. Окружение.
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'Не найден Node.js. Установите его с https://nodejs.org и попробуйте снова.' 'Red'
  Finish 1
}
if (-not (Test-Path (Join-Path $JarvisRoot 'node_modules\vite'))) {
  Say 'Зависимости не установлены — выполняю npm install (один раз)...' 'Yellow'
  Push-Location $JarvisRoot
  try { & npm.cmd install } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Say 'npm install завершился с ошибкой.' 'Red'; Finish 1 }
}

# 5. Старт в фоне. Прошлый лог сохраняем рядом — пригодится при разборе сбоя.
foreach ($f in @($LogFile, $ErrFile)) {
  if (Test-Path $f) { Move-Item $f "$f.old" -Force }
}
$nodeArgs = @('scripts/start.mjs')
if ($Writes) { $nodeArgs += '--writes' }
if ($CalendarWrites) { $nodeArgs += '--calendar-writes' }

$proc = Start-Process -FilePath $node.Source -ArgumentList $nodeArgs `
  -WorkingDirectory $JarvisRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii

Say 'Запускаю мозг (мост) и интерфейс' -Color Gray
if (Wait-Ready 90) {
  Say ''
  Say 'JARVIS готов и работает в фоне.' 'Green'
  if (-not $NoBrowser) { Say "Открываю $(Open-Jarvis)" }
  Say 'Это окно можно закрыть. Остановить JARVIS — ярлык «Остановить JARVIS».' 'DarkGray'
  Finish 0 4
}

Say ''
Say 'JARVIS не запустился. Последние строки журнала:' 'Red'
foreach ($f in @($LogFile, $ErrFile)) {
  if (Test-Path $f) { Get-Content $f -Tail 15 | ForEach-Object { Say "  $_" 'DarkGray' } }
}
Say "Полные журналы: $StateDir" 'Yellow'
[void](Stop-Jarvis)
Finish 1
