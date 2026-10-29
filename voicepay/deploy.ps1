# One-click deploy of the VoicePay server (Supabase Edge Function).
# Usage:  right-click this file -> "Run with PowerShell"   (or: .\deploy.ps1)
# It asks for your Supabase access token (supabase.com/dashboard/account/tokens), deploys, and forgets it.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:SUPABASE_ACCESS_TOKEN) {
  $secure = Read-Host 'Paste your Supabase access token (sbp_...)' -AsSecureString
  $env:SUPABASE_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
Push-Location server; npm run build:supabase; Pop-Location
npx --yes supabase functions deploy voicepay --project-ref dfofnptummxpnsptmmvh --no-verify-jwt --use-api
$env:SUPABASE_ACCESS_TOKEN = $null
Write-Host "`nDone. Now delete the token at https://supabase.com/dashboard/account/tokens" -ForegroundColor Green
