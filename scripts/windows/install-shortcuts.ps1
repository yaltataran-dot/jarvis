# Создаёт (или обновляет) ярлыки на рабочем столе:
#   JARVIS.lnk            — запуск в фоне + открыть интерфейс
#   Остановить JARVIS.lnk — остановить фоновые процессы
# Повторный запуск безопасен: ярлыки перезаписываются, дубликатов не появляется.
# Права администратора не нужны.

. (Join-Path $PSScriptRoot 'common.ps1')

# Иконка «реактора»: PNG 256x256, завёрнутый в .ico (Windows Vista+ это понимает).
function New-JarvisIcon([string]$Path) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 256, 256
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 18, 28))), 4, 4, 248, 248)
  $cyan = [System.Drawing.Color]::FromArgb(255, 64, 220, 255)
  $g.DrawEllipse((New-Object System.Drawing.Pen $cyan, 14), 26, 26, 204, 204)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 64, 220, 255)), 6), 62, 62, 132, 132)
  $tri = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 128, 84),
    (New-Object System.Drawing.PointF 168, 152),
    (New-Object System.Drawing.PointF 88, 152)
  )
  $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 248, 255))), $tri)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $png = $ms.ToArray()

  $fs = [System.IO.File]::Create($Path)
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)    # заголовок ICO, 1 картинка
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)  # 256x256
  $w.Write([uint16]1); $w.Write([uint16]32)                         # planes, bpp
  $w.Write([uint32]$png.Length); $w.Write([uint32]22)               # размер, смещение
  $w.Write($png)
  $w.Close()
}

function New-Shortcut([string]$Path, [string]$Script, [string]$Description, [int]$WindowStyle, [string]$Icon) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
  $lnk.WorkingDirectory = $JarvisRoot
  $lnk.Description = $Description
  $lnk.WindowStyle = $WindowStyle
  $lnk.IconLocation = $Icon
  $lnk.Save()
}

$icon = Join-Path $StateDir 'jarvis.ico'
New-JarvisIcon $icon

$desktop = [Environment]::GetFolderPath('Desktop')
$start = Join-Path $desktop 'JARVIS.lnk'
$stop  = Join-Path $desktop 'Остановить JARVIS.lnk'

New-Shortcut $start (Join-Path $PSScriptRoot 'start-jarvis.ps1') `
  'Запустить JARVIS (мост + интерфейс) и открыть его в браузере' 1 "$icon,0"
New-Shortcut $stop (Join-Path $PSScriptRoot 'stop-jarvis.ps1') `
  'Остановить фоновый JARVIS' 7 "$env:SystemRoot\System32\imageres.dll,100"

Write-Host "Ярлыки созданы:`n  $start`n  $stop" -ForegroundColor Green
