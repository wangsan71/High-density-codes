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

    * paper leg   P-M1-300 PNG + pack.pdf for a 200 KiB payload
    * plate legs  PL-G at 0.2/0.4/0.6/0.8 (G10's universal-floor half) plus PL-D2 at 0.4,
                  payload 6 B so that ONE data page is enough at every nozzle
    * MTF plate   mtf-plate.3mf/.stl/.png + mtf-plate.json
    * every .3mf goes through the G8 subset checker; any failure makes this script exit 1

  It does NOT pretend to have tested hardware: it writes artifacts and the commands. The hardware
  step is the user's, and README.txt says what to send back.

.EXAMPLE
  & .\tools\acceptance-kit.ps1
  & .\tools\acceptance-kit.ps1 -Out D:\pskt-kit -PlateMm 200
  # Call it with &, never by dot-sourcing: the script ends in exit.
#>
param(
  [string]$Out = '.tmp\acceptance-kit',
  [int]$PlateMm = 200,
  [int]$PaperBytes = 204800,
  [int]$ModuleBytes = 20000
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$kit = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
if (Test-Path $kit) { Remove-Item -Recurse -Force $kit }
foreach ($d in 'paper', 'plates', 'mtf', 'module-6', 'module-5', 'module-4') {
  New-Item -ItemType Directory -Force -Path (Join-Path $kit $d) | Out-Null
}

$script:fails = 0
function Fail([string]$msg) { $script:fails++; Write-Host " FAIL  $msg" }
function Ok([string]$msg) { Write-Host " PASS  $msg" }

# ---- payloads -------------------------------------------------------------------------
# 6 B for the plate legs: PL-G@0.8 has 12 B of net data per page, and a 6 B payload compresses to
# 11 B, so ONE data page is enough at every nozzle (measured: .tmp/data-page-only4.mjs).
$platePayload = Join-Path $kit 'payload-plate.bin'
[IO.File]::WriteAllBytes($platePayload, [byte[]](0x50, 0x53, 0x4b, 0x54, 0x01, 0x00))
$paperPayload = Join-Path $kit 'payload-paper.bin'
$buf = New-Object 'byte[]' $PaperBytes
for ($i = 0; $i -lt $PaperBytes; $i++) { $buf[$i] = [byte](($i * 167 + ($i -shr 3)) -band 255) }
[IO.File]::WriteAllBytes($paperPayload, $buf)
$modulePayload = Join-Path $kit 'payload-module.bin'
$moduleBuf = New-Object 'byte[]' $ModuleBytes
for ($i = 0; $i -lt $ModuleBytes; $i++) { $moduleBuf[$i] = [byte](($i * 197 + ($i -shr 5)) -band 255) }
[IO.File]::WriteAllBytes($modulePayload, $moduleBuf)
$plateHash = (Get-FileHash -Algorithm SHA256 -Path $platePayload).Hash.ToLower()
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
$plateLines = (($plateDirs | ForEach-Object { "     " + $_.profile + " @ " + $_.nozzle + "mm  ->  " + $_.dir + "\page-000.3mf / .stl" }) -join "`n")
$moduleReadmeLines = ($moduleLines -join "`n")
$ladderReadmeLines = ($ladderLines -join "`n")
$readme = $template.Replace('{{PAPER_BYTES}}', "$PaperBytes")
$readme = $readme.Replace('{{PAPER_SHA}}', $paperHash)
$readme = $readme.Replace('{{MODULE_BYTES}}', "$ModuleBytes")
$readme = $readme.Replace('{{MODULE_SHA}}', $moduleHash)
$readme = $readme.Replace('{{MODULE_LINES}}', $moduleReadmeLines)
$readme = $readme.Replace('{{PLATE_SHA}}', $plateHash)
$readme = $readme.Replace('{{PLATE_MM}}', "$PlateMm")
$readme = $readme.Replace('{{PLATE_LINES}}', $plateLines)
$readme = $readme.Replace('{{LADDER_LINES}}', $ladderReadmeLines)
[IO.File]::WriteAllText((Join-Path $kit 'README.txt'), $readme, (New-Object Text.UTF8Encoding($false)))

Write-Host ''
if ($script:fails -gt 0) {
  Write-Host "ACCEPTANCE KIT: $($script:fails) FAIL -- the kit is incomplete, do not hand it to a user"
  exit 1
}
Write-Host "ACCEPTANCE KIT: built at $kit (README.txt holds the user's steps)"
exit 0
