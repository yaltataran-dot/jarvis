# Устанавливает локальный нейросетевой голос Piper для JARVIS (бесплатно, офлайн).
#
#   install-voice.ps1                       движок + русские мужские голоса (Руслан, Дмитрий, Денис)
#   install-voice.ps1 -Voices ru_RU-ruslan-medium
#
# Файлы кладутся в %LOCALAPPDATA%\JARVIS\piper (или $env:JARVIS_PIPER_DIR), вне
# репозитория. Уже скачанное повторно не скачивается. Права администратора не нужны.
# После установки перезапустите JARVIS (ярлыки «Остановить JARVIS» и «JARVIS»).
#
# Источники: движок — github.com/rhasspy/piper (MIT), голоса —
# huggingface.co/rhasspy/piper-voices (лицензии указаны в карточке каждого голоса).

param(
  [string[]]$Voices = @('ru_RU-ruslan-medium', 'ru_RU-dmitri-medium', 'ru_RU-denis-medium')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$dir = if ($env:JARVIS_PIPER_DIR) { $env:JARVIS_PIPER_DIR } else { Join-Path $env:LOCALAPPDATA 'JARVIS\piper' }
$exe = Join-Path $dir 'piper\piper.exe'
New-Item -ItemType Directory -Force -Path $dir, (Join-Path $dir 'voices') | Out-Null

if (Test-Path $exe) {
  Write-Host "Движок Piper уже установлен: $exe" -ForegroundColor Gray
} else {
  Write-Host 'Скачиваю движок Piper (~20 МБ)...'
  $zip = Join-Path $dir 'piper_windows_amd64.zip'
  Invoke-WebRequest 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath $dir -Force
  Remove-Item $zip
}

foreach ($v in $Voices) {
  if ($v -notmatch '^([a-z]{2})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$') {
    Write-Host "Пропускаю «$v»: ожидается имя вида ru_RU-ruslan-medium" -ForegroundColor Yellow
    continue
  }
  $lang, $region, $speaker, $quality = $Matches[1], $Matches[2], $Matches[3], $Matches[4]
  $base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$lang/${lang}_$region/$speaker/$quality/$v"
  foreach ($ext in 'onnx.json', 'onnx') {
    $out = Join-Path $dir "voices\$v.$ext"
    if (Test-Path $out) { continue }
    Write-Host "Скачиваю $v.$ext..."
    # Во временный файл: оборванная загрузка не должна выглядеть установленной.
    Invoke-WebRequest "$base.$ext" -OutFile "$out.part" -UseBasicParsing
    Move-Item "$out.part" $out -Force
  }
}

# Проверка: одна короткая фраза первым голосом.
$probe = Join-Path $env:TEMP 'jarvis-piper-check.wav'
$model = Join-Path $dir "voices\$($Voices[0]).onnx"
# Windows PowerShell отдаёт текст внешним программам в ASCII — кириллица стала бы «?».
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
# Piper пишет обычный журнал в stderr; при 'Stop' PowerShell 5.1 счёл бы это ошибкой.
$ErrorActionPreference = 'Continue'
'Проверка голоса.' | & $exe --model $model --output_file $probe 2>$null
$ErrorActionPreference = 'Stop'
if ((Test-Path $probe) -and (Get-Item $probe).Length -gt 1000) {
  Remove-Item $probe
  Write-Host "Голос установлен и работает. Папка: $dir" -ForegroundColor Green
} else {
  Write-Host 'Piper не смог синтезировать проверочную фразу.' -ForegroundColor Red
  exit 1
}
