# Runs on Windows PowerShell 5.1 and on pwsh 7 alike -- do not add a #Requires line (the pwsh
# tool in this harness executes under Windows PowerShell 5.1; a "#requires -Version 7" makes the
# script refuse to run at all rather than degrade).
<#
.SYNOPSIS
  Prove that the MTF calibration plate actually measures the nozzle it was printed with.

.DESCRIPTION
  The plate (core/calibrate/mtfplate.js) carries a feature ladder whose rungs include the four
  nozzles' own extrusion widths, so "which nozzle can this chain resolve?" is a direct read
  rather than an inference. This script closes the loop the only way that is falsifiable on
  this machine:

    for each nozzle EW 0.26 / 0.45 / 0.70 / 0.95:
      1. render the plate as a printer with that smallest feature would print it
         (`pskit calibrate --make-mtf --print-ew <EW>`, i.e. holes narrower than EW are filled)
      2. put it through sim/channel.py -- the *Python* channel, an implementation that shares
         no code with the reader -- at a real preset
      3. read it back with `pskit calibrate --mtf` and require the recommendation to name
         that nozzle
    then two controls:
      * EW 1.40 (coarser than every nozzle) must recommend NO nozzle -- a plate reader that
        always finds an answer would pass step 1-3 by accident
      * the pristine render (no channel) must resolve every rung -- a reader that resolves
        nothing would also "fail" step 1-3 for the wrong reason

  What this does NOT prove: a real printer, a real camera, or a real nozzle. The "printer" here
  is the renderer's own EW emulation and the "capture" is the simulator; both are labelled as
  such everywhere they appear. A real print is measured by the user, and docs/USE.md §5 says how.

.EXAMPLE
  & .\tools\mtf-probe.ps1
  & .\tools\mtf-probe.ps1 -Preset plate-matte -Seed 3
  # Call it with &, never by dot-sourcing: the script ends in `exit`.
#>
param(
  [int]$Seed = 11,
  [ValidateSet('scan300', 'scan600', 'plate-matte', 'plate-glossy')]
  [string]$Preset = 'scan300',
  [int]$Dpi = 300,
  [switch]$KeepImages
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$tmp = Join-Path $root '.tmp\mtf-probe'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$script:fails = 0
$sw = [Diagnostics.Stopwatch]::StartNew()

# EW -> the nozzle whose extrusion width it is. Not a guess: core/nozzles.js NOZZLES.
# The 0.26mm case is allowed to come back coarser, and here is the measured reason: the
# channel's ink bleed (scan300 ew_mm up to +0.15mm, plate presets up to +0.25mm) closes a
# 0.26mm hole at any dpi -- measured, not assumed: scan300 and scan600 both report the 0.26
# rung at ~0.5 centre coverage. Control 0 below is the positive control for exactly that rung:
# the same plate with NO channel resolves it, so the reader is not the reason. Accepting a
# coarser answer is only allowed when the 0.26 rung is reported filled, i.e. when the reader
# says why.
$cases = @(
  @{ Ew = 0.26; Want = '0.2'; AllowCoarser = $true },
  @{ Ew = 0.45; Want = '0.4'; AllowCoarser = $false },
  @{ Ew = 0.7;  Want = '0.6'; AllowCoarser = $false },
  @{ Ew = 0.95; Want = '0.8'; AllowCoarser = $false }
)

Write-Host ''
Write-Host "MTF plate probe -- preset $Preset, seed $Seed, dpi $Dpi"
Write-Host ''

function Fail([string]$msg) {
  $script:fails++
  Write-Host " FAIL  $msg"
}

# --- control 0: the pristine render must resolve every rung -----------------------------
$plain = Join-Path $tmp 'plain'
$null = node cli/pskit.mjs calibrate --make-mtf --out $plain --dpi $Dpi *> (Join-Path $tmp 'make-plain.log')
if ($LASTEXITCODE -ne 0) { Fail "could not render the pristine plate (exit $LASTEXITCODE)"; exit 1 }
$null = node cli/pskit.mjs calibrate (Join-Path $plain 'mtf-plate.png') --mtf --spec (Join-Path $plain 'mtf-plate.json') --json *> (Join-Path $tmp 'read-plain.log')
if ($LASTEXITCODE -ne 0) { Fail "could not read the pristine plate (exit $LASTEXITCODE)"; exit 1 }
$plainJson = Get-Content (Join-Path $plain 'mtf-plate.mtf.json') -Raw | ConvertFrom-Json
$plainFloor = $plainJson.measurements.features.floorMm
$plainAll = $plainJson.measurements.features.allResolved
if ($plainAll -and $plainFloor -eq 0.26) {
  Write-Host (" PASS  pristine render resolves every rung (floor $plainFloor mm, no channel)")
} else {
  Fail "pristine render did not resolve every rung (floor=$plainFloor allResolved=$plainAll) -- the reader is broken, not the channel"
}

# --- control 0b: the printable half (D67) must come out of the same spec ------------------
# The CLI refuses to write a model whose projection disagrees with the spec or whose objects are
# not watertight, so exit 0 plus the two files is the assertion; the 3MF is then put through the
# G8 subset checker independently.
$meshDir = Join-Path $tmp 'mesh'
$null = node cli/pskit.mjs calibrate --make-mtf --out $meshDir --format 3mf,stl *> (Join-Path $tmp 'make-mesh.log')
if ($LASTEXITCODE -ne 0) {
  Fail "could not write the printable plate (exit $LASTEXITCODE)"
} elseif (-not (Test-Path (Join-Path $meshDir 'mtf-plate.3mf')) -or -not (Test-Path (Join-Path $meshDir 'mtf-plate.stl'))) {
  Fail 'the printable plate is missing a file'
} else {
  $null = node cli/pskit.mjs verify --gate G8 --file (Join-Path $meshDir 'mtf-plate.3mf') *> (Join-Path $tmp 'mesh-g8.log')
  if ($LASTEXITCODE -ne 0) { Fail "the plate's 3MF failed the G8 subset check (exit $LASTEXITCODE)" }
  else { Write-Host ' PASS  printable plate: 3mf + stl written from the same spec, 3MF passes the G8 subset check' }
}

# --- control 1: a printer coarser than any nozzle must recommend nothing ----------------
$over = Join-Path $tmp 'over'
$null = node cli/pskit.mjs calibrate --make-mtf --out $over --print-ew 1.4 --dpi $Dpi *> (Join-Path $tmp 'make-over.log')
$null = python sim/channel.py --in $over --out (Join-Path $tmp 'over-cap') --seed $Seed --preset $Preset --modifier nocrop --dpi $Dpi *> (Join-Path $tmp 'chan-over.log')
$null = node cli/pskit.mjs calibrate (Join-Path $tmp 'over-cap\mtf-plate.png') --mtf --spec (Join-Path $over 'mtf-plate.json') --json *> (Join-Path $tmp 'read-over.log')
$overJson = Get-Content (Join-Path $tmp 'over-cap\mtf-plate.mtf.json') -Raw | ConvertFrom-Json
if (-not $overJson.recommendation.ok) {
  Write-Host " PASS  EW 1.40mm (coarser than every nozzle) -> no nozzle recommended"
} else {
  Fail "EW 1.40mm still recommended nozzle $($overJson.recommendation.nozzle.id) -- the reader invents an answer"
}

# --- the four nozzles ------------------------------------------------------------------
foreach ($c in $cases) {
  $tag = "ew$($c.Ew.ToString().Replace('.', 'p'))"
  $src = Join-Path $tmp "$tag-src"
  $cap = Join-Path $tmp "$tag-cap"
  $null = node cli/pskit.mjs calibrate --make-mtf --out $src --print-ew $c.Ew --dpi $Dpi *> (Join-Path $tmp "$tag-make.log")
  if ($LASTEXITCODE -ne 0) { Fail "${tag}: plate render failed (exit $LASTEXITCODE)"; continue }
  $null = python sim/channel.py --in $src --out $cap --seed $Seed --preset $Preset --modifier nocrop --dpi $Dpi *> (Join-Path $tmp "$tag-chan.log")
  if ($LASTEXITCODE -ne 0) { Fail "${tag}: channel failed (exit $LASTEXITCODE)"; continue }
  $png = Join-Path $cap 'mtf-plate.png'
  if (-not (Test-Path $png)) { Fail "${tag}: channel wrote no image"; continue }
  $null = node cli/pskit.mjs calibrate $png --mtf --spec (Join-Path $src 'mtf-plate.json') --json *> (Join-Path $tmp "$tag-read.log")
  if ($LASTEXITCODE -ne 0) { Fail "${tag}: reader failed (exit $LASTEXITCODE)"; continue }
  $json = Get-Content (Join-Path $cap 'mtf-plate.mtf.json') -Raw | ConvertFrom-Json
  $got = if ($json.recommendation.ok) { $json.recommendation.nozzle.id } else { 'none' }
  $floor = $json.measurements.features.floorMm
  $pitch = $json.measurements.pitch.minStablePitchMm
  $line = "EW $($c.Ew)mm printed -> floor $floor mm, min pitch $pitch mm, recommended nozzle $got (wanted $($c.Want))"
  $rung = $json.measurements.features.rungs | Where-Object { [math]::Abs($_.sizeMm - $c.Ew) -lt 1e-6 }
  $rungState = if ($rung) { if ($rung.resolved) { 'OPEN' } else { 'filled' } } else { 'missing' }
  if ($got -eq $c.Want) {
    Write-Host " PASS  $line"
  } elseif ($c.AllowCoarser -and $rungState -eq 'filled') {
    # Honest coarser answer: the reader must also have said why (its own rung is filled).
    Write-Host " NOTE  $line -- the $($c.Ew)mm rung is reported FILLED, so the chain genuinely cannot resolve this nozzle (control 0 shows the reader can)"
  } else {
    Fail "$line (rung $rungState)"
  }
  if ($script:lastFloor -ne $null -and $floor -lt $script:lastFloor - 1e-9) {
    Fail "floor went DOWN from $($script:lastFloor)mm to $floor mm as the printed feature grew -- not monotone"
  }
  $script:lastFloor = $floor
  if (-not $KeepImages) { Remove-Item -Recurse -Force $src, $cap -ErrorAction SilentlyContinue }
}

$sw.Stop()
Write-Host ''
Write-Host ("MTF PROBE: {0} FAIL in {1}s" -f $script:fails, [int]$sw.Elapsed.TotalSeconds)
if ($script:fails -gt 0) { exit 1 }
Write-Host 'MTF PROBE: all assertions pass'
exit 0
