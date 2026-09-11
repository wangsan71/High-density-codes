# Builds the "hardware acceptance kit": the artifacts a user must print/shoot plus the exact
# commands to run afterwards. Runs on Windows PowerShell 5.1 and pwsh 7 alike -- do NOT add a
# #Requires line (the harness's pwsh tool is 5.1; "#requires -Version 7" makes the whole script
# refuse to run). ASCII-only on purpose: PS 5.1 reads a .ps1 without a BOM as ANSI, so non-ASCII
# text here turns into mojibake and stops parsing (measured). The user-facing README is a
# separate UTF-8 template (tools/acceptance-readme.txt) read with an explicit encoding.
<#
.SYNOPSIS
  One command that produces everything a user needs for the hardware acceptance, plus README.txt.

.DESCRIPTION
  docs/USE.md section 5 lists the checks only the user can run (a real printer, scanner, phone and
  browser). The steps are spread over several commands with different flags, and one wrong flag
  reads as "the product is broken". This script writes the artifacts to print AND the commands to
  type, and verifies here everything that can be verified here:

    * paper leg      P-M1-300 PNG + pack.pdf for a 200 KiB payload
    * module legs    P-MX-300-6/5/4 PNG + pack.pdf for a small payload
    * density rungs  three ladder sheets (A4@300, A5@600, A6@1200) for the real density numbers
    * any .3mf present goes through the G8 subset checker; a failure makes this script exit 1

  The 3D plate line (code plates, MTF board) was cancelled by the product owner in round 109, so this kit
  no longer writes them; docs/ACCEPTANCE.md marks the gates that only measured that line as RETIRED.
  tools/mtf-probe.ps1 still builds and reads an MTF board for anyone who wants that calibration.

  It does NOT pretend to have tested hardware: it writes artifacts and the commands. The hardware
  step is the user's, and README.txt says what to send back.

.EXAMPLE
  & .\tools\acceptance-kit.ps1
  & .\tools\acceptance-kit.ps1 -Out D:\pskt-kit
  # Call it with &, never by dot-sourcing: the script ends in exit.
#>
param(
  [string]$Out = '.tmp\acceptance-kit',
  [int]$PaperBytes = 204800,
  [int]$ModuleBytes = 20000
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$kit = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
if (Test-Path $kit) { Remove-Item -Recurse -Force $kit }
foreach ($d in 'paper', 'module-6', 'module-5', 'module-4') {
  New-Item -ItemType Directory -Force -Path (Join-Path $kit $d) | Out-Null
}

$script:fails = 0
function Fail([string]$msg) { $script:fails++; Write-Host " FAIL  $msg" }
function Ok([string]$msg) { Write-Host " PASS  $msg" }

# ---- payloads -------------------------------------------------------------------------
$paperPayload = Join-Path $kit 'payload-paper.bin'
$buf = New-Object 'byte[]' $PaperBytes
for ($i = 0; $i -lt $PaperBytes; $i++) { $buf[$i] = [byte](($i * 167 + ($i -shr 3)) -band 255) }
[IO.File]::WriteAllBytes($paperPayload, $buf)
$modulePayload = Join-Path $kit 'payload-module.bin'
$moduleBuf = New-Object 'byte[]' $ModuleBytes
for ($i = 0; $i -lt $ModuleBytes; $i++) { $moduleBuf[$i] = [byte](($i * 197 + ($i -shr 5)) -band 255) }
[IO.File]::WriteAllBytes($modulePayload, $moduleBuf)
$paperHash = (Get-FileHash -Algorithm SHA256 -Path $paperPayload).Hash.ToLower()
$moduleHash = (Get-FileHash -Algorithm SHA256 -Path $modulePayload).Hash.ToLower()

Write-Host ''
Write-Host "PSKT acceptance kit -> $kit"
Write-Host ''

# ---- paper leg ------------------------------------------------------------------------
& node cli/pskit.mjs send $paperPayload --profile P-M1-300 --format png,pdf --out (Join-Path $kit 'paper') *> (Join-Path $kit 'paper-send.log')
if ($LASTEXITCODE -ne 0) {
  Fail "paper send (exit $LASTEXITCODE, see paper-send.log)"
} else {
  $pages = @(Get-ChildItem (Join-Path $kit 'paper') -Filter 'page-*.png').Count
  Ok "paper leg: $pages page PNG(s) + pack.pdf for a $PaperBytes B payload"
}

# ---- dense binary-module paper legs ------------------------------------------------
$moduleLines = @()
foreach ($profile in 'P-MX-300-6', 'P-MX-300-5', 'P-MX-300-4') {
  $suffix = $profile.Substring($profile.Length - 1)
  $dir = Join-Path $kit "module-$suffix"
  & node cli/pskit.mjs send $modulePayload --profile $profile --format png,pdf --out $dir *> (Join-Path $kit "module-$suffix-send.log")
  if ($LASTEXITCODE -ne 0) {
    Fail "$profile (exit $LASTEXITCODE, see module-$suffix-send.log)"
  } else {
    $modulePages = @(Get-ChildItem $dir -Filter 'page-*.png' -ErrorAction SilentlyContinue).Count
    $moduleLines += "     $profile  ->  module-$suffix\pack.pdf  ($modulePages page PNGs)"
    Ok "$profile -> $modulePages page PNG(s) + pack.pdf"
  }
}

# ---- density ladder sheets (PLAN v5 P0) -------------------------------------------------
# The 3D plate line is retired (docs/PLAN-V5.md section 3): no code plates, no MTF board. What the user
# prints instead is the paper density ladder -- three sheets, each rendered at a dpi where EVERY module
# is at least 4 px, which is what makes the ruler exact (measured: below 4 px the ruler had its own
# 5e-4 error floor on a pristine render).
$ladderSheets = @(
  @{ name = 'density-a4-300';  sheet = 'A4';      dpi = '300';  pitches = '0.847,0.508,0.423,0.339' },
  @{ name = 'density-a5-600';  sheet = 'A5';      dpi = '600';  pitches = '0.423,0.254,0.169' },
  @{ name = 'density-a6-1200'; sheet = '105x148'; dpi = '1200'; pitches = '0.127,0.102,0.085' }
)
$ladderLines = @()
foreach ($s in $ladderSheets) {
  $dir = Join-Path $kit $s.name
  & node tools/density-ladder.mjs --make --out $dir --sheet $s.sheet --dpi $s.dpi --pitches $s.pitches *> (Join-Path $kit ($s.name + '-make.log'))
  if ($LASTEXITCODE -ne 0) {
    Fail "$($s.name) (exit $LASTEXITCODE, see $($s.name)-make.log)"
  } else {
    $ladderLines += "     " + $s.name + "  ->  " + $s.name + "\density-ladder.pdf   (100%, scan at " + $s.dpi + " dpi)"
    Ok ($s.name + ": " + $s.sheet + " @ " + $s.dpi + " dpi -> density-ladder.pdf")
  }
}

# ---- every 3MF through the G8 subset checker -------------------------------------------
$mfCount = 0
foreach ($f in Get-ChildItem $kit -Recurse -Filter '*.3mf') {
  & node cli/pskit.mjs verify --gate G8 --file $f.FullName *> (Join-Path $kit 'g8-check.log')
  if ($LASTEXITCODE -ne 0) { Fail "G8 subset: $($f.Name)" } else { $mfCount++ }
}
if ($mfCount -gt 0) { Ok "G8 subset check on $mfCount 3MF file(s)" }

# ---- README for the human half ---------------------------------------------------------
$template = Get-Content (Join-Path $PSScriptRoot 'acceptance-readme.txt') -Raw -Encoding utf8
$moduleReadmeLines = ($moduleLines -join "`n")
$ladderReadmeLines = ($ladderLines -join "`n")
$readme = $template.Replace('{{PAPER_BYTES}}', "$PaperBytes")
$readme = $readme.Replace('{{PAPER_SHA}}', $paperHash)
$readme = $readme.Replace('{{MODULE_BYTES}}', "$ModuleBytes")
$readme = $readme.Replace('{{MODULE_SHA}}', $moduleHash)
$readme = $readme.Replace('{{MODULE_LINES}}', $moduleReadmeLines)
$readme = $readme.Replace('{{LADDER_LINES}}', $ladderReadmeLines)
[IO.File]::WriteAllText((Join-Path $kit 'README.txt'), $readme, (New-Object Text.UTF8Encoding($false)))

Write-Host ''
if ($script:fails -gt 0) {
  Write-Host "ACCEPTANCE KIT: $($script:fails) FAIL -- the kit is incomplete, do not hand it to a user"
  exit 1
}
Write-Host "ACCEPTANCE KIT: built at $kit (README.txt holds the user's steps)"
exit 0
