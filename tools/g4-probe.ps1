# G4 evidence probe: paper vs plate under the phone-stress channel preset.
# ASCII-only (PS 5.1 reads a BOM-less .ps1 as ANSI -- non-ASCII here breaks parsing).
<#
.SYNOPSIS
  Runs a small phone-stress corpus through sim/channel.py and reports, per leg, how many
  transfers came back byte-exact and which failure classes appeared.

.DESCRIPTION
  G4's criterion (docs/PLAN.md) is "500 seeds x 8 conditions, >=99%", which needs a real phone
  and is listed as zero-evidence in docs/STATUS.md. This probe is NOT that gate: it is the
  in-process part that can be measured here, and it is reported as partial evidence only.

  Two legs, because the product has two answers to "the phone is far away":
    paper  P-M1-300   a whole A4 page in the frame. Its 0.85mm cell lands at ~2.5-4 px in a
                      1280x960 capture, i.e. below what the glyph alphabet needs.
    plate  PL-G@0.4   the universal floor profile: 3.6mm cells, so the same framing gives
                      ~15 px per cell.
  Both are run with and without the channel's crop modifier, because "cropping" is one of the
  eight conditions G4 names.

  Every leg is judged by tools/g2-corpus.mjs, which recomputes the payload digest itself -- the
  same arithmetic the G2 gate uses, so a "pass" here means the bytes really came back.

.EXAMPLE
  & .\tools\g4-probe.ps1
  & .\tools\g4-probe.ps1 -Seeds 8 -Preset phone-hard
  # Call it with &, never by dot-sourcing (it ends in exit).
#>
param(
  [int]$Seeds = 12,
  [int]$StartSeed = 1,
  [int]$Bytes = 204800,
  [string]$Preset = 'phone-hard',
  [string]$Out = '.tmp\g4-probe'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$base = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
New-Item -ItemType Directory -Force -Path $base | Out-Null

# One payload per leg: the plate profiles carry far less per page (PL-G@0.4: ~110 B net), so a
# 200 KiB payload would be refused ("needs N pages > 255") -- measured, and the first version of
# this script did exactly that. 6 B fits one data page at every nozzle (see tools/acceptance-kit.ps1).
$paperPayload = Join-Path $base 'payload-paper.bin'
$buf = New-Object 'byte[]' $Bytes
for ($i = 0; $i -lt $Bytes; $i++) { $buf[$i] = [byte](($i * 167 + ($i -shr 3)) -band 255) }
[IO.File]::WriteAllBytes($paperPayload, $buf)
$platePayload = Join-Path $base 'payload-plate.bin'
[IO.File]::WriteAllBytes($platePayload, [byte[]](0x50, 0x53, 0x4b, 0x54, 0x01, 0x00))

$legs = @(
  @{ name = 'paper P-M1-300'; payload = $paperPayload; args = @('--profile', 'P-M1-300') },
  @{ name = 'plate PL-G@0.4'; payload = $platePayload; args = @('--profile', 'PL-G', '--nozzle', '0.4', '--plate', '200') }
)
$conditions = @(
  @{ name = 'framing ok (nocrop)'; modifier = @('--modifier', 'nocrop') },
  @{ name = 'crop active'; modifier = @() }
)

Write-Host ''
Write-Host "G4 probe -- preset $Preset, seeds $StartSeed..$($StartSeed + $Seeds - 1), $Bytes B payload"
Write-Host "NOT the G4 gate (that needs a real phone, 500 seeds x 8 conditions). Partial evidence only."
Write-Host ''

$rows = @()
foreach ($leg in $legs) {
  $src = Join-Path $base ('src-' + ($leg.name -replace '[^A-Za-z0-9]', '_'))
  & node cli/pskit.mjs send $leg.payload @($leg.args) --format png --out $src *> (Join-Path $base 'send.log')
  if ($LASTEXITCODE -ne 0) { Write-Host " FAIL  send for $($leg.name) (exit $LASTEXITCODE)"; continue }
  foreach ($cond in $conditions) {
    $pass = 0
    $fails = 0
    $classes = @{}
    $blown = 0
    $clipMax = 0.0
    $inFrame = 0
    $inFrameTotal = 0
    $t0 = Get-Date
    for ($s = $StartSeed; $s -lt $StartSeed + $Seeds; $s++) {
      $cap = Join-Path $base ("cap-{0}-{1}-{2}" -f ($leg.name -replace '[^A-Za-z0-9]', '_'), ($cond.name -replace '[^A-Za-z0-9]', '_'), $s)
      $chanOut = & python sim/channel.py --in $src --out $cap --seed $s --preset $Preset @($cond.modifier) --report 2>&1 | Out-String
      if ($LASTEXITCODE -ne 0) { Write-Host " FAIL  channel seed $s ($($leg.name) / $($cond.name))"; $fails++; continue }
      # The channel's own report is the ground truth for "was the marker in the frame and was the
      # capture even in range". Without it, a blown-out capture and a mis-framed one produce the
      # same decoder message, and the user gets the wrong retake advice (measured, round 79).
      foreach ($line in ($chanOut -split "`n")) {
        if ($line -match '"clipped_frac": ([0-9.eE+-]+)') { $clip = [double]$Matches[1]; $clipMax = [math]::Max($clipMax, $clip); if ($clip -ge 0.2) { $blown++ } }
        if ($line -match '"marker_visible": \[([^\]]+)\]') {
          $vis = ($Matches[1] -split ',') | ForEach-Object { [double]$_ }
          $inFrame += ($vis | Where-Object { $_ -ge 0.999 }).Count
          $inFrameTotal += 4
        }
      }
      $out = & node tools/g2-corpus.mjs $cap 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0) { $pass++ } else {
        $fails++
        foreach ($line in ($out -split "`n")) {
          if ($line -match '^\s+(\d+) x (\S+)') {
            # No '??' here: this script must run on Windows PowerShell 5.1, which does not have it.
            $prev = if ($classes.ContainsKey($Matches[2])) { [int]$classes[$Matches[2]] } else { 0 }
            $classes[$Matches[2]] = [int]$Matches[1] + $prev
          }
        }
      }
    }
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    $pct = if ($Seeds -gt 0) { [math]::Round(100.0 * $pass / $Seeds, 1) } else { 0 }
    $classText = if ($classes.Count) { ($classes.GetEnumerator() | ForEach-Object { "$($_.Key) x$($_.Value)" }) -join ', ' } else { '-' }
    Write-Host (" {0,-6} {1,-22} {2,-18} {3,3}/{4} = {5}%  ({6}s)  failures: {7}" -f $(if ($fails -eq 0) { 'PASS' } else { 'FAIL' }), $leg.name, $cond.name, $pass, $Seeds, $pct, $secs, $classText)
    Write-Host ("        channel report: {0} page(s) blown out (clipped >= 0.2, max {1:N3}); markers in frame {2}/{3}" -f $blown, $clipMax, $inFrame, $inFrameTotal)
    $rows += [pscustomobject]@{ leg = $leg.name; condition = $cond.name; pass = $pass; seeds = $Seeds; pct = $pct; classes = $classText }
  }
}

Write-Host ''
Write-Host "G4 PROBE: partial evidence only -- $($rows.Count) leg/condition combination(s) measured."
Write-Host '           The gate itself still needs a real phone (docs/USE.md section 5).'
exit 0
