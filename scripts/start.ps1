param([switch]$Production, [switch]$Install)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if ($pnpmCommand) { $packageRunner = $pnpmCommand.Source }
elseif ($npmCommand) { $packageRunner = $npmCommand.Source }
else {
  $bundledRunner = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
  if (Test-Path -LiteralPath $bundledRunner) { $packageRunner = $bundledRunner }
  else { throw '请先安装 Node.js 24+（含 npm）或 pnpm。' }
}
if ($Install -or !(Test-Path -LiteralPath 'node_modules')) {
  & $packageRunner install
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
if ($Production) {
  & $packageRunner run build
  if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
  & $packageRunner run start
} else { & $packageRunner run dev }
