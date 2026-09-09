# Runs on Windows PowerShell 5.1 and on pwsh 7 alike -- do not add a #Requires line: the pwsh
# tool in this harness executes under Windows PowerShell 5.1 (probed, round 42), and a
# "#requires -Version 7" makes the script refuse to run at all rather than degrade.
<#
.SYNOPSIS
  One command that proves PSKT actually runs and can be used: file -> printable pages ->
  simulated print+scan -> the user-facing receive command -> the same bytes back.

.DESCRIPTION
  Every step here is a command a real user would type, not an in-process shortcut:

    1. pskit send          the sender's own CLI, writing page PNGs and a true-size pack.pdf
    2. sim/channel.py      the deterministic print+capture channel (Python), which is the
                           only honest stand-in for a printer and a scanner on this machine
    3. pskit receive       the receiver's own CLI, --photo, i.e. markers -> perspective ->
                           read, with no manifest hints from step 1 beyond what the pages carry
    4. SHA-256 compare     payload in vs payload out. This is the whole claim of the project:
                           the bytes come back identical, or the run is a failure.
     4b. multi-part         a file too big for ONE transfer (255 pages is the protocol's ceiling:
                            a page header stores totalPages in one byte). Walks the commands the
                            sender names since round 71 -- pskit split, then send / channel /
                            receive per part, then pskit join -- and requires the reassembly to be
                            byte-identical. Ends with a negative control: corrupt one received part
                            and join must REFUSE it (exit 1, nothing written), because a join that
                            cannot fail would make the pass above mean nothing.
     4c. encrypted          a --passphrase transfer, received three ways: WITHOUT the key it must
                            refuse and name the passphrase (not blame missing pages -- every page
                            arrived, and core has computed needPassphrase for ages while all three
                            receivers dropped it, D66); with a WRONG key it must refuse too (the
                            digest gate, i.e. criterion 3's zero misaccepts); with the right key the
                            same page images must come back byte-identical -- which is also the
                            positive control proving the two refusals were about the key.
    5. 3D side             pskit send --format 3mf,stl on a plate profile, then the Core 1.4
                           subset checker on the files it wrote (gate G8 --file)
    6. client data paths   tools/smoke-sender.mjs (the web sender's real buildArtifacts path,
                           decoded blind) and tools/smoke-capture.mjs (burst-capture decisions
                           over real page bitmaps)
    7. the phone's half    serve web/dist with tools/serve.mjs (Node only -- Python is no longer
                           needed for the phone path; started hidden on an explicit port, stopped
                           by pid in a finally block) and run tools/check-serve.mjs then
                           tools/check-lan.mjs against it: first the server's own behaviour (the
                           page it serves is byte-identical to disk, four shapes of directory
                           traversal refused, a missing file is a 404 and not a fallback to the
                           index, HEAD works, the manifest's MIME is right, responses are
                           no-store), then every service-worker precache entry fetched over http
                           and hashed with core/hash.js against the build manifest, no external
                           URL in any served page, and the thin pages' module graph resolving

  What this does NOT prove, and never claims to: real ink on real paper, a real phone camera,
  a real browser's print scaling (DEFECTS D8), PWA installation (needs https, not a LAN http
  origin), or the gates that need hardware -- G4 (phone 500x8), G6 (soak), G9 (browser),
  G10 (nozzle matrix). Those are listed in docs/STATUS.md with the steps a user can run.

.EXAMPLE
  & .\tools\usability.ps1                       # everything: paper, 3D, client paths, LAN serve
  & .\tools\usability.ps1 -Preset phone40       # the camera preset instead of the scanner
  & .\tools\usability.ps1 -Skip3D               # paper only, faster
  & .\tools\usability.ps1 -SkipMultipart        # single-transfer paper path only (skips split/join)
  & .\tools\usability.ps1 -SkipCrypto           # skip the encrypted-transfer leg
  & .\tools\usability.ps1 -SkipServe            # no local http server (-ServePort N moves it)
  # Call it with &, never by dot-sourcing: the script ends in `exit`, and dot-sourcing would take
  # the calling shell down with it (AGENTS.md trap table). The earlier examples here were wrong.
#>
param(
  [int]$Seed = 7,
  [ValidateSet('identity', 'scan300', 'scan600', 'phone40', 'phone-hard', 'plate-matte', 'plate-glossy')]
  [string]$Preset = 'scan300',
  [int]$Bytes = 204800,
  [int]$PlateBytes = 384,
  [int]$ServePort = 8123,
  [switch]$Skip3D,
  [switch]$SkipChannel,
  [switch]$SkipMultipart,
  [switch]$SkipCrypto,
  [switch]$SkipServe
)

# 'Continue', not 'Stop': node and python both write progress to stderr, and with 'Stop' a
# NativeCommandError kills this script before it can look at the exit code. Every step here is
# judged by its exit code, which is the only signal that cannot be faked by chatty output.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$tmp = Join-Path $root '.tmp\usability'
$payload = Join-Path $tmp 'payload.bin'
$src = Join-Path $tmp 'pages-src'
$scan = Join-Path $tmp 'pages-scan'
$got = Join-Path $tmp 'received.bin'
$plate = Join-Path $tmp 'plate'
$platePayload = Join-Path $tmp 'plate-payload.bin'
# Multi-part leg (4b). Parts are 20 KB rather than the 1.4 MB default on purpose: the default's
# boundary arithmetic is unit-tested in tests/unit/splitjoin.test.mjs, and three 1.4 MB parts would
# mean ~670 pages of channel simulation inside a smoke that should stay a few minutes long.
$mpPayload = Join-Path $tmp 'mp-payload.bin'
$mpParts = Join-Path $tmp 'mp-parts'
$mpBack = Join-Path $tmp 'mp-back'
$mpGot = Join-Path $tmp 'mp-recovered.bin'
$mpBad = Join-Path $tmp 'mp-must-not-exist.bin'
$mpBytes = 51200
$mpPartBytes = 20000
# Encrypted leg (4c). Small payload on purpose: 6000 B is 1 data page + 2 parity, so the leg costs one
# channel pass, and what it proves is the diagnosis and the digest gate, not capacity.
$encPayload = Join-Path $tmp 'enc-payload.bin'
$encSrc = Join-Path $tmp 'enc-src'
$encScan = Join-Path $tmp 'enc-scan'
$encNoPw = Join-Path $tmp 'enc-nopw.bin'
$encWrong = Join-Path $tmp 'enc-wrong.bin'
$encGot = Join-Path $tmp 'enc-recovered.bin'
$encBytes = 6000
$encPw = 'pskt-r73-pass'
$script:fails = 0
$script:t0 = [Diagnostics.Stopwatch]::StartNew()

# Run a command, keep its output in a log, and judge it by its exit code -- never by grepping
# for a word, which is how a run that printed nothing at all once looked like a pass.
function Step {
  param([string]$Label, [scriptblock]$Run, [string]$Log)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $Run *> $Log
  $code = $LASTEXITCODE
  $sw.Stop()
  $ok = ($code -eq 0)
  if (-not $ok) { $script:fails++ }
  Write-Host ("{0}  {1}  ({2}s, exit {3})" -f ($(if ($ok) { ' PASS' } else { ' FAIL' })), $Label, [int]$sw.Elapsed.TotalSeconds, $code)
  if (-not $ok) {
    Get-Content $Log -Tail 6 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) }
  }
  return $ok
}

Write-Host ""
Write-Host "PSKT usability smoke -- preset $Preset, seed $Seed, payload $Bytes B"
Write-Host ""

# 0. A deterministic payload, so two runs of this script are comparable.
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
foreach ($d in $src, $scan, $plate) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
# Generated here rather than by `node -e "..."`: Windows PowerShell 5.1 mangles embedded double
# quotes when handing an argument to a native executable (AGENTS.md trap table), so node received
# a script with the quotes stripped and failed. Same formula as tools/smoke-sender.mjs, so the
# payload is reproducible from either side.
function New-Payload {
  param([string]$Path, [int]$N)
  $buf = New-Object 'byte[]' $N
  for ($i = 0; $i -lt $N; $i++) { $buf[$i] = [byte](($i * 167 + ($i -shr 3)) -band 255) }
  [IO.File]::WriteAllBytes($Path, $buf)
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -ne $N) { throw "could not write $Path" }
}
New-Payload -Path $payload -N $Bytes
$wantHash = (Get-FileHash -Algorithm SHA256 -Path $payload).Hash.ToLower()
Write-Host ("        payload sha256 {0}" -f $wantHash.Substring(0, 16))

# 1. send: what a user does to make something printable.
$null = Step 'pskit send (paper P-M1-300, png + true-size pdf)' {
  node cli/pskit.mjs send $payload --profile P-M1-300 --format png,pdf --out $src
} (Join-Path $tmp 'step1.log')
$pngs = @(Get-ChildItem -Path $src -Filter 'page-*.png' -ErrorAction SilentlyContinue)
$pdf = Get-ChildItem -Path $src -Filter '*.pdf' -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("          wrote {0} page PNG(s){1}" -f $pngs.Count, $(if ($pdf) { ", " + $pdf.Name + " (" + [int]($pdf.Length / 1KB) + " KB)" } else { ", NO PDF" }))
if ($pngs.Count -eq 0) { Write-Host ' FAIL  nothing to print -- stopping here'; exit 1 }
# The output must end with the two commands that come next, spelled with this transfer's own profile
# (round 86): the first-use path used to stop at "wrote N files", leaving the user to re-read the
# manual for the fact that the receive side needs --profile when there is no manifest.json.
$step1Text = Get-Content (Join-Path $tmp 'step1.log') -Raw
$nextOk = ($step1Text -match 'next') -and ($step1Text -match 'pskit\.mjs receive') -and ($step1Text -match '--profile P-M1-300')
if (-not $nextOk) { $script:fails++ }
Write-Host ("{0}  send prints the next command, with this transfer's profile  " -f $(if ($nextOk) { " PASS" } else { " FAIL" }))


# 1b. The first command a user actually types: `send FILE` with no --profile. It must produce the
#     documented paper pages, and if someone does force a plate profile on a paper-sized payload the
#     refusal must name a way out (DEFECTS D75, round 84).
$bare = Join-Path $tmp "bare-default"
$bareLog = Join-Path $tmp "step1b-bare.log"
if (Test-Path $bare) { Remove-Item -Recurse -Force $bare }
$null = Step "pskit send with no --profile (the first command a user types)" {
  node cli/pskit.mjs send $payload --format png --out $bare
} $bareLog
$barePng = @(Get-ChildItem -Path $bare -Filter "page-*.png" -ErrorAction SilentlyContinue).Count
$bareText = Get-Content $bareLog -Raw
$bareOk = ($barePng -gt 0) -and ($bareText -match "P-M1-300")
if (-not $bareOk) { $script:fails++ }
Write-Host ("{0}  a bare send defaults to the paper profile  ({1} page PNG(s))" -f $(if ($bareOk) { " PASS" } else { " FAIL" }), $barePng)
$hintLog = Join-Path $tmp "step1b-hint.log"
& node cli/pskit.mjs send $payload --profile PL-D2 --format png --out (Join-Path $tmp "bare-plate") *> $hintLog
$hintCode = $LASTEXITCODE
$hintText = Get-Content $hintLog -Raw
# The hint must also say how big a part may be: for a plate profile that is ~21 kB, not the 1.4 MB
# split default, so a hint without a number sends the user into a second refusal (round 89).
$hintOk = ($hintCode -ne 0) -and ($hintText -match "P-M1-300") -and ($hintText -match "split") -and ($hintText -match "--max-bytes \d+")
if (-not $hintOk) { $script:fails++ }
Write-Host ("{0}  forcing a plate profile on a big payload refuses and names the way out  (exit {1})" -f $(if ($hintOk) { " PASS" } else { " FAIL" }), $hintCode)
if (-not $hintOk) { Get-Content $hintLog -Tail 3 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) } }

# 2. channel: the printer and the scanner this machine does not have.
if ($SkipChannel) {
  Write-Host ' SKIP  sim/channel.py (-SkipChannel): decoding the pristine pages instead, which proves less'
  Copy-Item -Path $src -Destination $scan -Recurse -Force
} else {
  $null = Step "sim/channel.py --preset $Preset --seed $Seed --modifier nocrop" {
    python sim/channel.py --in $src --out $scan --seed $Seed --preset $Preset --modifier nocrop
  } (Join-Path $tmp 'step2.log')
  if (-not (Test-Path $scan)) { Write-Host ' FAIL  the channel wrote nothing -- stopping here'; exit 1 }
}

# 3. receive: what a user does with the scans. --photo, because that is the path a camera or
#    a skewed flatbed scan needs, and it is the harder of the two.
$null = Step 'pskit receive --photo (markers -> perspective -> read)' {
  node cli/pskit.mjs receive $scan --photo --out $got
} (Join-Path $tmp 'step3.log')

# 4. The only verdict that matters.
if (Test-Path $got) {
  $gotHash = (Get-FileHash -Algorithm SHA256 -Path $got).Hash.ToLower()
  $same = ($gotHash -eq $wantHash)
  $gotLen = (Get-Item $got).Length
  if (-not $same) { $script:fails++ }
  Write-Host ("{0}  bytes came back identical  ({1} B, sha256 {2} vs {3})" -f ($(if ($same) { ' PASS' } else { ' FAIL' })), $gotLen, $gotHash.Substring(0, 16), $wantHash.Substring(0, 16))
} else {
  $script:fails++
  Write-Host ' FAIL  receive wrote no file at all'
}

# 4b. A file too big for one transfer, walked the way the sender tells a user to walk it. One transfer
#     is at most 255 pages (core/frame.js:19 stores totalPages in one byte) and the inter-page parity
#     pages take slots out of that, so P-M1-300 at its default 20% parity carries 1,592,968 B -- a
#     limit no client can talk its way past, CLI included, because both call the same encoder. Since
#     round 71 the sender says this with numbers and names `pskit split` / `pskit join`; this leg is
#     the evidence that those commands actually close the loop instead of being advice.
if ($SkipMultipart) {
  Write-Host ' SKIP  multi-part split/join leg (-SkipMultipart)'
} else {
  foreach ($d in $mpParts, $mpBack) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
  foreach ($f in $mpGot, $mpBad) { if (Test-Path $f) { Remove-Item $f -Force } }
  New-Payload -Path $mpPayload -N $mpBytes
  $null = Step "pskit split ($mpBytes B into parts of <= $mpPartBytes B: one transfer is at most 255 pages)" {
    node cli/pskit.mjs split $mpPayload --max-bytes $mpPartBytes --out $mpParts
  } (Join-Path $tmp 'step4b-split.log')
  $partFiles = @(Get-ChildItem -Path $mpParts -Filter 'part-*.bin' -ErrorAction SilentlyContinue | Sort-Object Name)
  if ($partFiles.Count -eq 0) {
    $script:fails++
    Write-Host ' FAIL  split wrote no parts, so there is nothing to send'
  } else {
    Write-Host ("          {0} part(s): {1}" -f $partFiles.Count, (($partFiles | ForEach-Object { $_.Name + ' ' + $_.Length + 'B' }) -join ', '))
    New-Item -ItemType Directory -Force -Path $mpBack | Out-Null
    Copy-Item -Path (Join-Path $mpParts 'parts.json') -Destination (Join-Path $mpBack 'parts.json') -Force
    $i = 0
    foreach ($p in $partFiles) {
      $i++
      $pSeed = $Seed + 100 + $i
      $pSrc = Join-Path $tmp "mp-src-$i"
      $pScan = Join-Path $tmp "mp-scan-$i"
      foreach ($d in $pSrc, $pScan) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
      $null = Step "part $i/$($partFiles.Count) ($($p.Name)): pskit send" {
        node cli/pskit.mjs send $p.FullName --profile P-M1-300 --format png --out $pSrc
      } (Join-Path $tmp "step4b-send-$i.log")
      if ($SkipChannel) {
        Copy-Item -Path $pSrc -Destination $pScan -Recurse -Force
      } else {
        $null = Step "part $i/$($partFiles.Count) ($($p.Name)): sim/channel.py --seed $pSeed" {
          python sim/channel.py --in $pSrc --out $pScan --seed $pSeed --preset $Preset --modifier nocrop
        } (Join-Path $tmp "step4b-chan-$i.log")
      }
      # Received into the manifest's own directory under the manifest's own name: that is what
      # docs/USE.md tells a user to do and what `join` checks its digests against.
      $null = Step "part $i/$($partFiles.Count) ($($p.Name)): pskit receive --photo" {
        node cli/pskit.mjs receive $pScan --photo --out (Join-Path $mpBack $p.Name)
      } (Join-Path $tmp "step4b-recv-$i.log")
    }
    $null = Step 'pskit join (every part digest, then the whole-file digest, then write)' {
      node cli/pskit.mjs join $mpBack --out $mpGot
    } (Join-Path $tmp 'step4b-join.log')
    if (Test-Path $mpGot) {
      $mpGotHash = (Get-FileHash -Algorithm SHA256 -Path $mpGot).Hash.ToLower()
      $mpWantHash = (Get-FileHash -Algorithm SHA256 -Path $mpPayload).Hash.ToLower()
      $mpSame = ($mpGotHash -eq $mpWantHash)
      if (-not $mpSame) { $script:fails++ }
      Write-Host ("{0}  split -> 3 transfers -> join came back identical  ({1} B, sha256 {2} vs {3})" -f ($(if ($mpSame) { ' PASS' } else { ' FAIL' })), (Get-Item $mpGot).Length, $mpGotHash.Substring(0, 16), $mpWantHash.Substring(0, 16))
    } else {
      $script:fails++
      Write-Host ' FAIL  join wrote no file at all'
    }
    # Negative control, judged inline rather than through Step: a scriptblock handed to Step must not
    # call `exit`, because Step invokes it in this scope and would take the whole script with it
    # (AGENTS.md trap table). Judged by the exit code and by the absence of output, never by wording.
    if ($partFiles.Count -gt 1) {
      $victim = Join-Path $mpBack $partFiles[1].Name
      $vb = [IO.File]::ReadAllBytes($victim)
      $vb[[int]($vb.Length / 2)] = $vb[[int]($vb.Length / 2)] -bxor 255
      [IO.File]::WriteAllBytes($victim, $vb)
      node cli/pskit.mjs join $mpBack --out $mpBad *> (Join-Path $tmp 'step4b-neg.log')
      $negCode = $LASTEXITCODE
      $negWrote = Test-Path $mpBad
      $refused = ($negCode -ne 0 -and -not $negWrote)
      if (-not $refused) { $script:fails++ }
      Write-Host ("{0}  negative control: join refuses a one-byte-corrupted part  (exit {1}, output written: {2})" -f ($(if ($refused) { ' PASS' } else { ' FAIL' })), $negCode, $negWrote)
    }
  }
}

# 4c. An encrypted transfer, and the diagnosis when the key is missing. core/protocol.js has set
#     needPassphrase for a long time and tests/unit/protocol.test.mjs pins it ("receiver must ask for
#     the passphrase, not fail silently"), but that branch left `error` unset, so all three receivers
#     printed their generic fallback: the CLI said "still short", the web page said "仍缺料", the phone
#     said "未知原因" -- while their own progress line read N/N pages. And the phone's burst section had
#     no passphrase field at all, so a transfer the sender page can create could not be opened on a
#     phone (DEFECTS D66). Judged by exit code and by what landed on disk; the WORDING is judged too,
#     because the wording is this fix -- and the with-key run at the end is the positive control that
#     proves both refusals were about the key, not about the pages or the channel.
if ($SkipCrypto) {
  Write-Host ' SKIP  encrypted-transfer leg (-SkipCrypto)'
} else {
  foreach ($d in $encSrc, $encScan) { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
  foreach ($f in $encNoPw, $encWrong, $encGot) { if (Test-Path $f) { Remove-Item $f -Force } }
  New-Payload -Path $encPayload -N $encBytes
  $null = Step "pskit send --passphrase ($encBytes B encrypted: 1 data page + 2 parity)" {
    node cli/pskit.mjs send $encPayload --profile P-M1-300 --format png --passphrase $encPw --out $encSrc
  } (Join-Path $tmp 'step4c-send.log')
  if ($SkipChannel) {
    Copy-Item -Path $encSrc -Destination $encScan -Recurse -Force
  } else {
    $encSeed = $Seed + 200
    $null = Step "sim/channel.py --seed $encSeed (the encrypted pages)" {
      python sim/channel.py --in $encSrc --out $encScan --seed $encSeed --preset $Preset --modifier nocrop
    } (Join-Path $tmp 'step4c-chan.log')
  }
  $nopwLog = Join-Path $tmp 'step4c-nopw.log'
  node cli/pskit.mjs receive $encScan --photo --out $encNoPw *> $nopwLog
  $nopwCode = $LASTEXITCODE
  $nopwWrote = Test-Path $encNoPw
  $nopwMsg = [string](Get-Content $nopwLog -Raw)
  $namesKey = ($nopwMsg -match 'NEEDS PASSPHRASE') -and ($nopwMsg -match '--passphrase')
  $blamesPages = ($nopwMsg -match 'still short')
  $nopwOk = ($nopwCode -ne 0) -and (-not $nopwWrote) -and $namesKey -and (-not $blamesPages)
  if (-not $nopwOk) { $script:fails++ }
  Write-Host ("{0}  no key -> refuses, writes nothing, and names the passphrase instead of blaming pages  (exit {1}, wrote: {2}, names --passphrase: {3}, says 'still short': {4})" -f ($(if ($nopwOk) { ' PASS' } else { ' FAIL' })), $nopwCode, $nopwWrote, $namesKey, $blamesPages)
  if (-not $nopwOk) { Get-Content $nopwLog -Tail 6 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }
  node cli/pskit.mjs receive $encScan --photo --passphrase not-the-key --out $encWrong *> (Join-Path $tmp 'step4c-wrong.log')
  $wrongCode = $LASTEXITCODE
  $wrongWrote = Test-Path $encWrong
  $wrongOk = ($wrongCode -ne 0) -and (-not $wrongWrote)
  if (-not $wrongOk) { $script:fails++ }
  Write-Host ("{0}  a WRONG key is refused too, never silently accepted  (exit {1}, wrote: {2})" -f ($(if ($wrongOk) { ' PASS' } else { ' FAIL' })), $wrongCode, $wrongWrote)
  $null = Step 'pskit receive --passphrase (the same page images, now with the key)' {
    node cli/pskit.mjs receive $encScan --photo --passphrase $encPw --out $encGot
  } (Join-Path $tmp 'step4c-ok.log')
  if (Test-Path $encGot) {
    $encGotHash = (Get-FileHash -Algorithm SHA256 -Path $encGot).Hash.ToLower()
    $encWantHash = (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower()
    $encSame = ($encGotHash -eq $encWantHash)
    if (-not $encSame) { $script:fails++ }
    Write-Host ("{0}  encrypted transfer came back identical once the key was given  ({1} B, sha256 {2} vs {3})" -f ($(if ($encSame) { ' PASS' } else { ' FAIL' })), (Get-Item $encGot).Length, $encGotHash.Substring(0, 16), $encWantHash.Substring(0, 16))
  } else {
    $script:fails++
    Write-Host ' FAIL  receive with the right passphrase wrote no file at all'
  }
}

# 4d. A directory whose images are in a format this build cannot read. A phone camera writes JPEG and a
#     flatbed defaults to TIFF, so the receiver must SAY that instead of "no pages found" -- which sends
#     the user looking for a problem that is not there (DEFECTS D74, round 83). Judged by exit code, by
#     nothing-was-written, and by the message naming the format and a workaround; the positive control
#     is the same page as PNG, which must decode from the same directory.
$jpgDir = Join-Path $tmp "fmt-jpg"
$jpgOut = Join-Path $tmp "fmt-jpg-must-not-exist.bin"
if (Test-Path $jpgDir) { Remove-Item -Recurse -Force $jpgDir }
New-Item -ItemType Directory -Force -Path $jpgDir | Out-Null
& python -c "from PIL import Image; Image.open(r'$encSrc\page-000.png').convert('RGB').save(r'$jpgDir\page-000.jpg', quality=92)" *> (Join-Path $tmp "step4d-jpeg.log")
if ($LASTEXITCODE -ne 0) {
  Write-Host " SKIP  format leg: PIL could not write a JPEG to test with"
} else {
  $fmtLog = Join-Path $tmp "step4d-receive.log"
  & node cli/pskit.mjs receive $jpgDir --photo --profile P-M1-300 --out $jpgOut *> $fmtLog
  $fmtCode = $LASTEXITCODE
  $fmtText = Get-Content $fmtLog -Raw
  $fmtWrote = Test-Path $jpgOut
  $fmtOk = ($fmtCode -ne 0) -and (-not $fmtWrote) -and ($fmtText -match "\.jpg") -and ($fmtText -match "PNG") -and ($fmtText -match "convert")
  if (-not $fmtOk) { $script:fails++ }
  Write-Host ("{0}  a JPEG-only directory is refused with the format named, not a blank no-pages error  (exit {1}, wrote: {2})" -f $(if ($fmtOk) { " PASS" } else { " FAIL" }), $fmtCode, $fmtWrote)
  if (-not $fmtOk) { Get-Content $fmtLog -Tail 3 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) } }
  # Positive control: the same page in a format we DO read must still decode from a directory that
  # also holds the unreadable file.
  Copy-Item (Join-Path $encSrc "page-000.png") (Join-Path $jpgDir "page-000.png") -Force
  $mixedOut = Join-Path $tmp "fmt-mixed.bin"
  & node cli/pskit.mjs receive $jpgDir --photo --profile P-M1-300 --passphrase $encPw --out $mixedOut *> (Join-Path $tmp "step4d-mixed.log")
  $mixedOk = ($LASTEXITCODE -eq 0) -and (Test-Path $mixedOut)
  if ($mixedOk) {
    $mixedHash = (Get-FileHash -Algorithm SHA256 -Path $mixedOut).Hash.ToLower()
    $mixedOk = $mixedHash -eq (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower()
  }
  if (-not $mixedOk) { $script:fails++ }
  Write-Host ("{0}  the same page as PNG still decodes from that directory  (exit {1})" -f $(if ($mixedOk) { " PASS" } else { " FAIL" }), $LASTEXITCODE)
}

# 4e. Only the PARITY pages on disk: the inter-page RS must rebuild the data page, deliver the same
#     bytes, and SAY which page it rebuilt (round 88). Before this line the run looked like it had
#     silently skipped a page the user printed.
$parityDir = Join-Path $tmp "parity-only"
$parityOut = Join-Path $tmp "parity-only.bin"
if (Test-Path $parityDir) { Remove-Item -Recurse -Force $parityDir }
New-Item -ItemType Directory -Force -Path $parityDir | Out-Null
Get-ChildItem -Path $src -Filter "page-*.png" | Where-Object { $_.Name -ne "page-000.png" } | Copy-Item -Destination $parityDir
$parityLog = Join-Path $tmp "step4e-parity.log"
& node cli/pskit.mjs receive $parityDir --photo --profile P-M1-300 --out $parityOut *> $parityLog
$parityCode = $LASTEXITCODE
$parityText = Get-Content $parityLog -Raw
$parityOk = ($parityCode -eq 0) -and (Test-Path $parityOut) -and ($parityText -match "rebuilt from the parity pages") -and ($parityText -match "page-000")
if ($parityOk) { $parityOk = ((Get-FileHash -Algorithm SHA256 -Path $parityOut).Hash.ToLower() -eq $wantHash) }
if (-not $parityOk) { $script:fails++ }
Write-Host ("{0}  only the parity pages: the data page is rebuilt and named  (exit {1})" -f $(if ($parityOk) { " PASS" } else { " FAIL" }), $parityCode)
if (-not $parityOk) { Get-Content $parityLog -Tail 4 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) } }

# 4f. A "scan to PDF" directory -- the default output of many scanners. This build *writes* PDFs (that
#     is the print path) and cannot rasterize one, so the receiver must say that and name an export,
#     not "no pages found" (DEFECTS D79, round 93). Judged by exit code, by nothing-written, by the
#     message naming PDF and PNG, and by the absence of the doubled "receive: receive:" prefix; the
#     positive control is the same pages as PNG in the same directory, which must still decode.
$pdfDir = Join-Path $tmp "fmt-pdf"
$pdfOut = Join-Path $tmp "fmt-pdf-must-not-exist.bin"
if (Test-Path $pdfDir) { Remove-Item -Recurse -Force $pdfDir }
New-Item -ItemType Directory -Force -Path $pdfDir | Out-Null
& node cli/pskit.mjs send $encPayload --profile P-M1-300 --format pdf --passphrase $encPw --out $pdfDir *> (Join-Path $tmp "step4f-make.log")
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $pdfDir "pack.pdf"))) {
  Write-Host " SKIP  pdf leg: could not write a PDF to test with"
} else {
  $pdfLog = Join-Path $tmp "step4f-receive.log"
  & node cli/pskit.mjs receive $pdfDir --photo --profile P-M1-300 --passphrase $encPw --out $pdfOut *> $pdfLog
  $pdfCode = $LASTEXITCODE
  $pdfText = Get-Content $pdfLog -Raw
  $pdfWrote = Test-Path $pdfOut
  $pdfOk = ($pdfCode -ne 0) -and (-not $pdfWrote) -and ($pdfText -match "PDF") -and ($pdfText -match "PNG") -and ($pdfText -match "export")
  $pdfOk = $pdfOk -and (-not ($pdfText -match "receive:\s*receive:"))
  if (-not $pdfOk) { $script:fails++ }
  Write-Host ("{0}  a PDF-only directory is refused with PDF named and an export path  (exit {1}, wrote: {2})" -f $(if ($pdfOk) { " PASS" } else { " FAIL" }), $pdfCode, $pdfWrote)
  if (-not $pdfOk) { Get-Content $pdfLog -Tail 3 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) } }
  # Positive control: the same transfer as PNG pages must still decode from that directory.
  Get-ChildItem -Path $encSrc -Filter "page-*.png" | Copy-Item -Destination $pdfDir
  $pdfMixedOut = Join-Path $tmp "fmt-pdf-mixed.bin"
  & node cli/pskit.mjs receive $pdfDir --photo --profile P-M1-300 --passphrase $encPw --out $pdfMixedOut *> (Join-Path $tmp "step4f-mixed.log")
  $pdfMixedOk = ($LASTEXITCODE -eq 0) -and (Test-Path $pdfMixedOut)
  if ($pdfMixedOk) { $pdfMixedOk = ((Get-FileHash -Algorithm SHA256 -Path $pdfMixedOut).Hash.ToLower() -eq (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower()) }
  if (-not $pdfMixedOk) { $script:fails++ }
  Write-Host ("{0}  the same pages as PNG still decode from the PDF directory  (exit {1})" -f $(if ($pdfMixedOk) { " PASS" } else { " FAIL" }), $LASTEXITCODE)
}

# 5. The 3D side, on files this run actually wrote.
if (-not $Skip3D) {
  # A plate page carries far less than a paper page -- PL-D2@0.4 holds on the order of 180 payload
  # bytes per page, and the inter-page RS caps one transfer at 255 pages -- so this step gets its
  # own small payload. Feeding it the paper-sized one is not a product bug: the CLI refuses with an
  # actionable message ("needs 1120 pages > 255 (inter-page RS limit): shrink payload or use a
  # denser profile"), which is exactly the fail-closed behaviour the contract asks for. The first
  # version of this script asked for the impossible and reported it as a product failure.
  New-Payload -Path $platePayload -N $PlateBytes
  $null = Step "pskit send (plate PL-D2@0.4, $PlateBytes B payload, 3mf + stl)" {
    node cli/pskit.mjs send $platePayload --profile PL-D2 --nozzle 0.4 --format 3mf,stl --out $plate
  } (Join-Path $tmp 'step5a.log')
  $threemf = @(Get-ChildItem -Path $plate -Filter '*.3mf' -ErrorAction SilentlyContinue)
  $stl = @(Get-ChildItem -Path $plate -Filter '*.stl' -ErrorAction SilentlyContinue)
  Write-Host ("          wrote {0} .3mf and {1} .stl" -f $threemf.Count, $stl.Count)
  if ($threemf.Count -gt 0) {
    $list = ($threemf | ForEach-Object { $_.FullName }) -join ','
    $null = Step "gate G8 --file on those .3mf (Core 1.4 subset)" {
      node cli/pskit.mjs verify --gate G8 --file $list
    } (Join-Path $tmp 'step5b.log')
  } else {
    $script:fails++
    Write-Host ' FAIL  the plate profile wrote no .3mf'
  }
}

# 6. The client's own data paths, executed rather than read.
$null = Step 'tools/smoke-sender.mjs (web sender path, decoded blind)' {
  node tools/smoke-sender.mjs
} (Join-Path $tmp 'step6a.log')
$null = Step 'tools/smoke-capture.mjs (burst-capture decisions)' {
  node tools/smoke-capture.mjs
} (Join-Path $tmp 'step6b.log')

# 7. The phone's half: what a client on this LAN would actually be served -- served by the same
#    Node-only server the manual tells the user to run (tools/serve.mjs), so this smoke covers the
#    phone path without Python being installed. Start-Process is verified in this sandbox (round
#    44: started hidden, checked, stopped by pid, zero leftovers).
#    The port is passed explicitly on purpose: that makes serve.mjs refuse to bind rather than walk
#    to the next free port, and a smoke must test the port it then checks -- a silent move would
#    leave the two checks below hitting nothing at all.
#    try/finally is not decoration -- a smoke that leaks a listening server is worse than one that
#    fails, and the leftover check is by pid, not by counting node processes, because counting
#    would blame this script for the node processes this harness itself runs.
#    This does briefly expose web/dist on every interface, which is exactly what a phone needs;
#    pass -SkipServe if that is unwanted.
if (-not $SkipServe) {
  if (-not (Test-Path 'web\dist\index.html')) {
    $script:fails++
    Write-Host ' FAIL  web/dist does not exist: run `node tools/build-web.mjs` first (docs/USE.md section 0)'
  } else {
    $proc = $null
    $serveOut = Join-Path $tmp 'step7-serve.out.log'
    $serveErr = Join-Path $tmp 'step7-serve.err.log'
    try {
      $proc = Start-Process node -ArgumentList 'tools/serve.mjs', '--port', "$ServePort" -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru -RedirectStandardOutput $serveOut -RedirectStandardError $serveErr -ErrorAction Stop
      Start-Sleep -Seconds 3
      # The banner is evidence in itself: these are the URLs a phone on this LAN would open.
      # Read as UTF-8 -- node writes UTF-8 while Windows PowerShell 5.1 defaults to ANSI, and the
      # mismatch turns the interface name into mojibake (round 50: my reading error, not a bug).
      Get-Content $serveOut -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { Write-Host ('          ' + ([string]$_).TrimEnd()) }
      $null = Step "tools/check-serve.mjs against http://127.0.0.1:$ServePort (server behaviour: byte identity, traversal refused, 404, HEAD, MIME)" {
        node tools/check-serve.mjs --port $ServePort
      } (Join-Path $tmp 'step7a.log')
      $null = Step "tools/check-lan.mjs against http://127.0.0.1:$ServePort (the phone's view of web/dist)" {
        node tools/check-lan.mjs --port $ServePort
      } (Join-Path $tmp 'step7.log')
    } catch {
      $script:fails++
      Write-Host (' FAIL  could not serve web/dist for the LAN check: ' + ([string]$_.Exception.Message))
      # Say what the server itself reported: a bind failure has two causes on Windows and only one
      # of them is visible in a LISTENING filter (round 50, port 8131 held by an outbound socket).
      Get-Content $serveErr -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object { Write-Host ('          serve.mjs said: ' + ([string]$_).TrimEnd()) }
    } finally {
      if ($proc) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
          $script:fails++
          Write-Host (" FAIL  the smoke leaked its own server process (pid {0})" -f $proc.Id)
        } else {
          Write-Host ("          server pid {0} stopped, nothing left listening on {1}" -f $proc.Id, $ServePort)
        }
      }
    }
  }
} else {
  Write-Host ' SKIP  LAN serving check (-SkipServe)'
}

$script:t0.Stop()
Write-Host ''
if ($script:fails -eq 0) {
  Write-Host ("USABILITY: everything above passed in {0}s -- a file went in, printable pages came out," -f [int]$script:t0.Elapsed.TotalSeconds)
  Write-Host '           a simulated print+scan came back, and the bytes were identical.'
  if (-not $SkipMultipart) {
    Write-Host '           Also: a file too big for one 255-page transfer went split -> per-part send/scan/'
    Write-Host '           receive -> join, byte-identical, and join refused a one-byte-corrupted part.'
  }
  if (-not $SkipCrypto) {
    Write-Host '           Also: an encrypted transfer refused without a key (naming the passphrase, not'
    Write-Host '           missing pages), refused with a wrong key, and came back identical with the right one.'
  }
  Write-Host '           Not proven here: real ink/paper, a real phone camera, browser print scaling (D8),'
  Write-Host '           PWA install (needs https), and G4/G6/G9/G10. See docs/USE.md for those steps.'
  exit 0
} else {
  Write-Host ("USABILITY: {0} step(s) FAILED in {1}s -- logs in {2}" -f $script:fails, [int]$script:t0.Elapsed.TotalSeconds, $tmp)
  exit 1
}
