# Автозапуск JARVIS при входе в Windows — по умолчанию ВЫКЛЮЧЕН.
#
#   autostart.ps1 -Enable    включить (ярлык в папке «Автозагрузка» текущего пользователя)
#   autostart.ps1 -Disable   выключить
#   autostart.ps1            показать текущее состояние
#   -Enable -CalendarWrites  автозапуск с разрешённой записью в Google Календарь
#
# При входе JARVIS стартует скрыто и без браузера; интерфейс открывается ярлыком
# JARVIS на рабочем столе (он увидит, что всё уже запущено, и просто откроет вкладку).
# Права администратора не нужны. Выключить можно также в Диспетчере задач →
# «Автозагрузка приложений».

param([switch]$Enable, [switch]$Disable, [switch]$CalendarWrites)

. (Join-Path $PSScriptRoot 'common.ps1')

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'JARVIS.lnk'

if ($Enable) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'start-jarvis.ps1')`" -NoBrowser$(if ($CalendarWrites) { ' -CalendarWrites' })"
  $lnk.WorkingDirectory = $JarvisRoot
  $lnk.Description = 'Автозапуск JARVIS в фоне'
  $lnk.WindowStyle = 7
  $icon = Join-Path $StateDir 'jarvis.ico'
  if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  Write-Host "Автозапуск включён: $lnkPath" -ForegroundColor Green
} elseif ($Disable) {
  if (Test-Path $lnkPath) {
    Remove-Item $lnkPath
    Write-Host 'Автозапуск выключен.' -ForegroundColor Green
  } else {
    Write-Host 'Автозапуск и так выключен.' -ForegroundColor Gray
  }
} else {
  $state = if (Test-Path $lnkPath) { 'включён' } else { 'выключен' }
  Write-Host "Автозапуск JARVIS: $state"
}
