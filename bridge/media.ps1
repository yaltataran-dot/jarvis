# Windows media sessions (System Media Transport Controls) for yandexMusic.mjs.
#
# What Windows knows about every player on the machine -- the same API the
# media keys and the volume flyout use. yandexMusic.mjs reads it to tell what
# is really playing, including Yandex Music in a browser tab, and uses it to
# drive the Yandex Music app when the app was opened by hand.
#
# Two ways to run:
#   media.ps1 -Action <status|play|pause|next|prev|running|kill> [-Target app|<app id>]
#       one command, one line of JSON
#   media.ps1 -Serve
#       stays up and answers JSON lines on stdin ({"id":1,"action":"status"}),
#       one JSON line each. Starting PowerShell and loading WinRT costs about
#       two seconds; paid once here instead of on every command.
#
# An action waits for the player to show the change and says so in
# `confirmed`. The Yandex Music app has a session only once something has been
# loaded in it; a freshly opened app has none.
#
# Kept ASCII-only: Windows PowerShell 5.1 reads a script without a BOM in the
# ANSI code page.
param([string]$Action = 'status', [string]$Target = 'app', [switch]$Serve)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Out-Json($o) { $o | ConvertTo-Json -Compress -Depth 5 }

# The app's processes, found by install folder rather than by name: the
# executable's name is Cyrillic, and this file stays ASCII.
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\YandexMusic\'
function Get-AppProcesses {
  Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) }
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(5000)) { throw 'Windows media API timed out' }
  $t.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$T = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSession'
$script:mgr = $null
function Get-Manager {
  if (-not $script:mgr) { $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Type]"${T}Manager") }
  $script:mgr
}

# The Yandex Music app's own id; a browser tab carries the browser's id
# whatever the tab is playing.
$AppId = 'yandex.*music|music.*yandex|YandexMusic'

function Get-State($s) {
  $p = $null
  try { $p = Await ($s.TryGetMediaPropertiesAsync()) ([Type]"${T}MediaProperties") } catch { }
  $i = $s.GetPlaybackInfo()
  @{
    app     = $s.SourceAppUserModelId
    isApp   = [bool]($s.SourceAppUserModelId -match $AppId)
    playing = ($i.PlaybackStatus -eq 'Playing')
    status  = "$($i.PlaybackStatus)"
    title   = $(if ($p) { $p.Title } else { $null })
    artist  = $(if ($p) { $p.Artist } else { $null })
  }
}

function Find-Session($target) {
  $all = @((Get-Manager).GetSessions())
  if (-not $target -or $target -eq 'app') { return $all | Where-Object { $_.SourceAppUserModelId -match $AppId } | Select-Object -First 1 }
  $all | Where-Object { $_.SourceAppUserModelId -eq $target } | Select-Object -First 1
}

function Invoke-Media($action, $target) {
  switch ($action) {
    'running' { return @{ running = [bool](Get-AppProcesses) } }
    'kill' {
      Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
      return @{ running = [bool](Get-AppProcesses) }
    }
  }

  $sessions = @((Get-Manager).GetSessions() | ForEach-Object { Get-State $_ })
  $session = Find-Session $target
  if ($action -eq 'status') {
    $out = @{ found = [bool]$session; sessions = $sessions }
    if ($session) { foreach ($k in (Get-State $session).GetEnumerator()) { $out[$k.Key] = $k.Value } }
    return $out
  }
  if (-not $session) { return @{ found = $false; sessions = $sessions } }

  $before = Get-State $session
  switch ($action) {
    'play'  { $sent = Await ($session.TryPlayAsync()) ([bool]) }
    'pause' { $sent = Await ($session.TryPauseAsync()) ([bool]) }
    'next'  { $sent = Await ($session.TrySkipNextAsync()) ([bool]) }
    'prev'  { $sent = Await ($session.TrySkipPreviousAsync()) ([bool]) }
    default { throw "unknown action $action" }
  }
  function Test-Done($s) {
    switch ($action) {
      'play'  { return $s.playing }
      'pause' { return -not $s.playing }
      default { return [bool]$s.title -and ($s.title -ne $before.title -or $s.artist -ne $before.artist) }
    }
  }
  # Wait here for the player to show the change, rather than starting a
  # second command to look.
  $state = Get-State $session
  $deadline = (Get-Date).AddMilliseconds(4000)
  while ($sent -and -not (Test-Done $state) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $state = Get-State $session
  }
  $state.found = $true
  $state.sent = [bool]$sent
  $state.confirmed = [bool](Test-Done $state)
  $state.before = $before
  return $state
}

if ($Serve) {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $id = $null
    try {
      $req = $line | ConvertFrom-Json
      $id = $req.id
      $res = Invoke-Media $req.action $req.target
    } catch {
      $res = @{ error = "$($_.Exception.Message)" }
    }
    $res.id = $id
    [Console]::Out.WriteLine((Out-Json $res))
    [Console]::Out.Flush()
  }
  exit 0
}

try { Out-Json (Invoke-Media $Action $Target) } catch { Out-Json @{ error = "$($_.Exception.Message)" }; exit 1 }
