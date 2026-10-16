# Encrypts or decrypts the Google Calendar token with Windows DPAPI.
#
# The token file can be read back only by this Windows account on this
# machine: copied elsewhere, or read by another user, it is noise. The text
# comes in on stdin, never as an argument, so it never appears in a process
# list. Prints base64 (protect) or the text (unprotect), nothing else.
#
# Usage: <text> | dpapi.ps1 -Mode protect|unprotect
param([Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Mode)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Security

# Ties the ciphertext to this purpose as well as to the account.
$entropy = [Text.Encoding]::UTF8.GetBytes('JARVIS google-calendar token')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$in = [Console]::In.ReadToEnd().Trim()

if ($Mode -eq 'protect') {
  $bytes = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $entropy, $scope)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
} else {
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $entropy, $scope)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
}
