# Остановка фонового JARVIS: лаунчер вместе с мостом и Vite.
# Трогает только node-процессы JARVIS (по pid-файлу и по портам моста/интерфейса).

. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'JARVIS — стоп'

if (Stop-Jarvis) {
  Write-Host 'JARVIS остановлен.' -ForegroundColor Green
} else {
  Write-Host 'JARVIS не был запущен.' -ForegroundColor Gray
}
Start-Sleep -Seconds 2
