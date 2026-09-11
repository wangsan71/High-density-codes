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

# 4g. Scanner output variants. "Black and white" / "line art" are the default scan modes on most
#     flatbeds (1-bit gray, or a palette PNG), and film scanners write 16-bit gray; all of them must
#     decode byte-identically, because refusing the cleanest input a scanner can give is not a user
#     error (DEFECTS D80). PIL makes the fixtures; 8-bit gray is the positive control (it always worked).
$varRoot = Join-Path $tmp "fmt-variants"
if (Test-Path $varRoot) { Remove-Item -Recurse -Force $varRoot }
New-Item -ItemType Directory -Force -Path $varRoot | Out-Null
& python -c "from PIL import Image; import numpy as np; im=Image.open(r'$encSrc\page-000.png').convert('RGB'); vs={'gray8':lambda:im.convert('L'),'bw1':lambda:im.convert('L').convert('1',dither=Image.NONE),'pal8':lambda:im.convert('P',palette=Image.ADAPTIVE,colors=16),'gray16':lambda:Image.fromarray((np.asarray(im.convert('L')).astype('uint16')*257),mode='I;16')}; [vs[k]().save(r'$varRoot\\'+k+'.png') for k in vs]" *> (Join-Path $tmp "step4g-make.log")
if ($LASTEXITCODE -ne 0) {
  Write-Host " SKIP  scanner-variant leg: PIL could not write the fixtures"
} else {
  $variantFails = @()
  foreach ($name in 'gray8', 'bw1', 'pal8', 'gray16') {
    $vd = Join-Path $varRoot $name
    New-Item -ItemType Directory -Force -Path $vd | Out-Null
    Move-Item (Join-Path $varRoot "$name.png") (Join-Path $vd "page-000.png") -Force
    $vOut = Join-Path $tmp "fmt-$name.bin"
    & node cli/pskit.mjs receive $vd --photo --profile P-M1-300 --passphrase $encPw --out $vOut *> (Join-Path $tmp "step4g-$name.log")
    $vOk = ($LASTEXITCODE -eq 0) -and (Test-Path $vOut)
    if ($vOk) { $vOk = ((Get-FileHash -Algorithm SHA256 -Path $vOut).Hash.ToLower() -eq (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower()) }
    if (-not $vOk) {
      $variantFails += $name
      Get-Content (Join-Path $tmp "step4g-$name.log") -Tail 2 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) }
    }
  }
  if ($variantFails.Count) { $script:fails++ }
  Write-Host ("{0}  scanner variants decode byte-identically: 8-bit gray, 1-bit black-and-white, palette, 16-bit gray  (failed: {1})" -f $(if ($variantFails.Count -eq 0) { " PASS" } else { " FAIL" }), $(if ($variantFails.Count) { $variantFails -join ',' } else { 'none' }))
}

# 4h. TIFF is the other default a flatbed writes, and an air-gapped workflow cannot answer
#     "install ImageMagick first" (DEFECTS D82). PIL makes the variants a scanner would produce --
#     uncompressed, LZW, Adobe Deflate, PackBits, 8-bit gray, 1-bit bilevel, palette, 16-bit gray --
#     plus one multi-page TIFF, and every one of them must come back byte-identical.
$tifRoot = Join-Path $tmp "fmt-tiff"
if (Test-Path $tifRoot) { Remove-Item -Recurse -Force $tifRoot }
New-Item -ItemType Directory -Force -Path $tifRoot | Out-Null
& python -c "from PIL import Image; import numpy as np, os; src=Image.open(r'$encSrc\page-000.png').convert('RGB'); r=r'$tifRoot'; m={'rgb-none':(src,{}),'rgb-lzw':(src,{'compression':'tiff_lzw'}),'rgb-deflate':(src,{'compression':'tiff_adobe_deflate'}),'rgb-packbits':(src,{'compression':'packbits'}),'gray8-lzw':(src.convert('L'),{'compression':'tiff_lzw'}),'bw1-none':(src.convert('L').convert('1',dither=Image.NONE),{}),'bw1-lzw':(src.convert('L').convert('1',dither=Image.NONE),{'compression':'tiff_lzw'}),'pal8':(src.convert('P',palette=Image.ADAPTIVE,colors=16),{}),'gray16':(Image.fromarray((np.asarray(src.convert('L')).astype('uint16')*257),mode='I;16'),{})}; [ (os.makedirs(os.path.join(r,k),exist_ok=True), v[0].save(os.path.join(r,k,'page-000.tif'), **v[1])) for k,v in m.items() ]; ps=[Image.open(r'$encSrc\page-%03d.png'%i).convert('RGB') for i in range(3)]; os.makedirs(os.path.join(r,'multipage'),exist_ok=True); ps[0].save(os.path.join(r,'multipage','pages.tif'),save_all=True,append_images=ps[1:],compression='tiff_lzw')" *> (Join-Path $tmp "step4h-make.log")
if ($LASTEXITCODE -ne 0) {
  Write-Host " SKIP  tiff leg: PIL could not write the fixtures"
} else {
  $tifFails = @()
  foreach ($name in 'rgb-none', 'rgb-lzw', 'rgb-deflate', 'rgb-packbits', 'gray8-lzw', 'bw1-none', 'bw1-lzw', 'pal8', 'gray16') {
    $td = Join-Path $tifRoot $name
    $tOut = Join-Path $tmp "fmt-tiff-$name.bin"
    & node cli/pskit.mjs receive $td --photo --profile P-M1-300 --passphrase $encPw --out $tOut *> (Join-Path $tmp "step4h-$name.log")
    $tOk = ($LASTEXITCODE -eq 0) -and (Test-Path $tOut)
    if ($tOk) { $tOk = ((Get-FileHash -Algorithm SHA256 -Path $tOut).Hash.ToLower() -eq (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower()) }
    if (-not $tOk) {
      $tifFails += $name
      Get-Content (Join-Path $tmp "step4h-$name.log") -Tail 2 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) }
    }
  }
  # one multi-page TIFF must expand into three pages, not one
  $mpOut = Join-Path $tmp "fmt-tiff-multipage.bin"
  & node cli/pskit.mjs receive (Join-Path $tifRoot 'multipage') --photo --profile P-M1-300 --passphrase $encPw --out $mpOut *> (Join-Path $tmp "step4h-multipage.log")
  $mpOk = ($LASTEXITCODE -eq 0) -and (Test-Path $mpOut)
  if ($mpOk) {
    $mpOk = ((Get-FileHash -Algorithm SHA256 -Path $mpOut).Hash.ToLower() -eq (Get-FileHash -Algorithm SHA256 -Path $encPayload).Hash.ToLower())
    $mpOk = $mpOk -and ((Get-Content (Join-Path $tmp "step4h-multipage.log") -Raw) -match "3 pages in one file")
  }
  if (-not $mpOk) {
    $tifFails += 'multipage'
    Get-Content (Join-Path $tmp "step4h-multipage.log") -Tail 3 | ForEach-Object { Write-Host ("          " + ([string]$_).Trim()) }
  }
  if ($tifFails.Count) { $script:fails++ }
  Write-Host ("{0}  scanner TIFF variants decode byte-identically: none/LZW/Deflate/PackBits, 8-bit gray, 1-bit, palette, 16-bit, and a 3-page file  (failed: {1})" -f $(if ($tifFails.Count -eq 0) { " PASS" } else { " FAIL" }), $(if ($tifFails.Count) { $tifFails -join ',' } else { 'none' }))
}

# 4i. Two refusals that must name the problem instead of leaking an implementation detail (round 238,
#     HANDOVER section 9 item 3). Leg 1: `send` on a directory used to reach the user as the raw Node error
#     "EISDIR: illegal operation on a directory, read" -- which says neither what happened nor what to do.
$dirSendLog = Join-Path $tmp 'step4i-send-dir.log'
$dirSendOut = Join-Path $tmp 'step4i-send-dir-must-not-exist'
if (Test-Path $dirSendOut) { Remove-Item -Recurse -Force $dirSendOut }
& node cli/pskit.mjs send $src --profile P-M1-300 --out $dirSendOut *> $dirSendLog
$dirSendCode = $LASTEXITCODE
$dirSendText = Get-Content $dirSendLog -Raw
$dirSendWrote = Test-Path $dirSendOut
$dirSendOk = ($dirSendCode -ne 0) -and (-not $dirSendWrote) -and ($dirSendText -match 'is a directory') -and ($dirSendText -match 'one transfer carries one file') -and ($dirSendText -notmatch 'EISDIR')
if (-not $dirSendOk) { $script:fails++ }
Write-Host ("{0}  send on a directory names the problem and the way out, not EISDIR  (exit {1}, output written: {2})" -f $(if ($dirSendOk) { ' PASS' } else { ' FAIL' }), $dirSendCode, $dirSendWrote)
if (-not $dirSendOk) { Get-Content $dirSendLog -Tail 3 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }

#     Leg 2: a batch that fails the same way must end in ONE counted line naming the dominant class (a
#     folder of 40 photographs used to print three lines each). Blank pages are the deterministic way to
#     produce that batch, and the positive control is the successful receive of section 3, which must print
#     no such line at all.
$blankDir = Join-Path $tmp 'blank-batch'
$blankOut = Join-Path $tmp 'step4i-blank-must-not-exist.bin'
if (Test-Path $blankDir) { Remove-Item -Recurse -Force $blankDir }
New-Item -ItemType Directory -Force -Path $blankDir | Out-Null
& python -c "from PIL import Image; [Image.new('RGB',(2480,3508),(255,255,255)).save(r'$blankDir\page-%03d.png' % i) for i in range(3)]" *> (Join-Path $tmp 'step4i-blank.log')
$blankCount = @(Get-ChildItem $blankDir -Filter '*.png' -ErrorAction SilentlyContinue).Count
if ($blankCount -ne 3) {
  Write-Host ' SKIP  batch-summary leg: PIL could not write the blank pages to test with'
} else {
  if (Test-Path $blankOut) { Remove-Item -Force $blankOut }
  $blankLog = Join-Path $tmp 'step4i-blank-recv.log'
  & node cli/pskit.mjs receive $blankDir --photo --profile P-M1-300 --out $blankOut *> $blankLog
  $blankCode = $LASTEXITCODE
  $blankText = Get-Content $blankLog -Raw
  $sumOk = ($blankCode -ne 0) -and (-not (Test-Path $blankOut)) -and ($blankText -match 'note: 3 image/page\(s\) failed:') -and ($blankText -match 'markers/blank-image') -and ($blankText -match 'dominant class:')
  $goodText = Get-Content (Join-Path $tmp 'step3.log') -Raw
  $sumOk = $sumOk -and ($goodText -notmatch 'image/page\(s\) failed:')
  if (-not $sumOk) { $script:fails++ }
  Write-Host ("{0}  a failing batch is summed up in one counted line, and a good batch says nothing  (exit {1}, output written: {2})" -f $(if ($sumOk) { ' PASS' } else { ' FAIL' }), $blankCode, (Test-Path $blankOut))
  if (-not $sumOk) { Get-Content $blankLog -Tail 4 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }
}

# 4j. A folder of page images with no manifest.json: the geometry has to come from the pages themselves.
#     The CLI used to answer that with "pass the profile -- or use the browser receiver"; it can now run the
#     same candidate search the browser runs (round 239), which is the difference between "remember which
#     profile you printed" and "hand it the photographs". Positive control: the same folder without
#     --profile must still refuse, and must NAME --profile auto as the way out.
$autoDir = Join-Path $tmp 'auto-recv'
$autoOut = Join-Path $tmp 'auto-got.bin'
if (Test-Path $autoDir) { Remove-Item -Recurse -Force $autoDir }
if (Test-Path $autoOut) { Remove-Item -Force $autoOut }
New-Item -ItemType Directory -Force -Path $autoDir | Out-Null
Copy-Item (Join-Path $src 'page-*.png') $autoDir -Force
$autoNoLog = Join-Path $tmp 'step4j-none.log'
& node cli/pskit.mjs receive $autoDir --photo --out $autoOut *> $autoNoLog
$autoNoCode = $LASTEXITCODE
$autoNoText = Get-Content $autoNoLog -Raw
$autoNoOk = ($autoNoCode -ne 0) -and (-not (Test-Path $autoOut)) -and ($autoNoText -match 'profile auto')
if (-not $autoNoOk) { $script:fails++ }
Write-Host ("{0}  no manifest and no --profile: refuses, writes nothing, and names --profile auto  (exit {1})" -f $(if ($autoNoOk) { ' PASS' } else { ' FAIL' }), $autoNoCode)
if (-not $autoNoOk) { Get-Content $autoNoLog -Tail 3 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }
$autoLog = Join-Path $tmp 'step4j-auto.log'
& node cli/pskit.mjs receive $autoDir --photo --profile auto --out $autoOut *> $autoLog
$autoCode = $LASTEXITCODE
$autoOk = ($autoCode -eq 0) -and (Test-Path $autoOut)
$autoGeom = ''
if ($autoOk) {
  $autoText = Get-Content $autoLog -Raw
  if ($autoText -match 'auto geometry ([^\s]+) @(\d+) dpi') { $autoGeom = $Matches[1] + '@' + $Matches[2] }
  $autoOk = ($autoGeom -ne '') -and ((Get-FileHash -Algorithm SHA256 -Path $autoOut).Hash.ToLower() -eq $wantHash)
}
if (-not $autoOk) { $script:fails++ }
Write-Host ("{0}  --profile auto reads the geometry off the pages and the bytes come back identical  (exit {1}, {2})" -f $(if ($autoOk) { ' PASS' } else { ' FAIL' }), $autoCode, $(if ($autoGeom) { $autoGeom } else { 'no geometry line' }))
if (-not $autoOk) { Get-Content $autoLog -Tail 4 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }

# 4k. The image path -- the flow this project was asked for first: a picture goes in, printed pages come out,
#     they come back through the same channel, and the picture is viewable again. The smoke covered plain
#     files, split/join and crypto, but never `--image-mode lossy` + unpsk, so the headline path had no
#     end-to-end leg at all (round 241, found by auditing the commands docs/USE.md tells the user to type).
$imgSrc = Join-Path $tmp 'img-src.png'
& python -c "from PIL import Image; import random, math; random.seed(7); im=Image.new('RGB',(480,320)); px=im.load(); [px.__setitem__((x,y),(int(40+180*x/480+30*math.sin(y/9))%256,int(60+140*y/320+30*math.sin(x/13))%256,int(120+random.randint(-20,20)))) for y in range(320) for x in range(480)]; im.save(r'$imgSrc')" *> (Join-Path $tmp 'step4k-fixture.log')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $imgSrc)) {
  Write-Host ' SKIP  image-path leg: PIL could not write the fixture'
} else {
  $imgSend = Join-Path $tmp 'img-send'
  $imgScan = Join-Path $tmp 'img-scan'
  foreach ($d in $imgSend, $imgScan) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  $imgBack = Join-Path $tmp 'img-back.psk'
  $imgPng = Join-Path $tmp 'img-back.png'
  foreach ($f in $imgBack, $imgPng) { if (Test-Path $f) { Remove-Item -Force $f } }
  & node cli/pskit.mjs send $imgSrc --image-mode lossy --pages 3 --profile P-MX-300-5 --format png --out $imgSend *> (Join-Path $tmp 'step4k-send.log')
  $is1 = ($LASTEXITCODE -eq 0) -and (@(Get-ChildItem $imgSend -Filter 'page-*.png' -ErrorAction SilentlyContinue).Count -ge 3)
  & python sim/channel.py --in $imgSend --out $imgScan --seed 7 --preset scan300 --modifier nocrop *> (Join-Path $tmp 'step4k-scan.log')
  $is2 = ($LASTEXITCODE -eq 0)
  & node cli/pskit.mjs receive $imgScan --photo --profile P-MX-300-5 --out $imgBack *> (Join-Path $tmp 'step4k-recv.log')
  $recvText = Get-Content (Join-Path $tmp 'step4k-recv.log') -Raw
  $is3 = ($LASTEXITCODE -eq 0) -and (Test-Path $imgBack) -and ($recvText -match 'MATCHES manifest')
  & node tools/unpsk.mjs $imgBack $imgPng *> (Join-Path $tmp 'step4k-unpsk.log')
  $is4 = ($LASTEXITCODE -eq 0) -and (Test-Path $imgPng)
  $psnr = ''
  $is5 = $false
  if ($is4) {
    $psnr = [string](& python -c "from PIL import Image, ImageChops; import math; a=Image.open(r'$imgSrc').convert('RGB'); b=Image.open(r'$imgPng').convert('RGB'); d=ImageChops.difference(a,b); h=d.histogram(); n=a.size[0]*a.size[1]; mse=sum((i%256)**2*c for i,c in enumerate(h))/(n*3); print(('%.2f' % (10*math.log10(255*255/mse))) if a.size==b.size else 'size-mismatch')")
    $psnr = $psnr.Trim()
    $is5 = ($psnr -match '^[0-9]+\.[0-9]+$') -and ([double]$psnr -ge 25)
  }
  $imgOk = $is1 -and $is2 -and $is3 -and $is4 -and $is5
  if (-not $imgOk) { $script:fails++ }
  Write-Host ("{0}  image path: picture -> pages -> channel -> payload matches the manifest -> viewable again  (PSNR {1} dB, same size; send {2} scan {3} receive {4} unpsk {5})" -f $(if ($imgOk) { ' PASS' } else { ' FAIL' }), $(if ($psnr) { $psnr } else { 'n/a' }), $is1, $is2, $is3, $is4)
  if (-not $imgOk) { Get-Content (Join-Path $tmp 'step4k-recv.log') -Tail 3 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }
}

# 4l. The density ladder -- the sheet that turns 'how fine can this printer scan' into numbers, and the one
#     command in the acceptance README (step 2c) that produces them. Nothing covered it: not one test and no
#     leg, so a regression here would only surface after the user had printed three sheets (round 246).
#     The leg runs exactly the README's pipeline in process: --make, a simulated 300 dpi scan, --read.
$dd = Join-Path $tmp 'density-ladder'
$ddIn = Join-Path $dd 'scan-in'
$ddScan = Join-Path $dd 'scan'
if (Test-Path $dd) { Remove-Item -Recurse -Force $dd }
New-Item -ItemType Directory -Force -Path $ddIn | Out-Null
& node tools/density-ladder.mjs --make --out (Join-Path $dd 'a4') --sheet A4 --dpi 300 --pitches "0.847,0.508,0.423,0.339" *> (Join-Path $tmp 'step4l-make.log')
$dl1 = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $dd 'a4\density-ladder.json'))
Copy-Item (Join-Path $dd 'a4\density-ladder.png') (Join-Path $ddIn 'page-000.png') -Force
& python sim/channel.py --in $ddIn --out $ddScan --seed 7 --preset scan300 --modifier nocrop *> (Join-Path $tmp 'step4l-scan.log')
$dl2 = ($LASTEXITCODE -eq 0) -and (@(Get-ChildItem $ddScan -Filter '*.png' -ErrorAction SilentlyContinue).Count -eq 1)
$dlLog = Join-Path $tmp 'step4l-read.log'
& node tools/density-ladder.mjs --read $ddScan --spec (Join-Path $dd 'a4\density-ladder.json') *> $dlLog
$dl3 = ($LASTEXITCODE -eq 0)
$dlText = Get-Content $dlLog -Raw
$dlRows = @($dlText -split "`n" | Where-Object { $_ -match '^\s+\d+\s+0\.' })
$dl4 = ($dlRows.Count -eq 4) -and ($dlText -match 'band\s+pitch mm\s+px\s+modules\s+BER')
$dlCoarse = $false
$dlFine = $false
if ($dlRows.Count -eq 4) {
  # The coarsest band (10 px per module) must come back usable, and the finest (4 px per module) must show
  # the cliff this project measured: a BER above zero. Asserting both directions keeps the leg from passing
  # on a run that simply printed four zeros.
  $dlCoarse = ($dlRows[0] -match 'yes')
  $fineFields = @($dlRows[3] -split '\s+' | Where-Object { $_ -ne '' })
  if ($fineFields.Count -ge 6) { $dlFine = ([double]$fineFields[5]) -gt 0 }
}
# Positive control: the READ must fail, and say why, on a directory with no images at all.
$ddEmpty = Join-Path $dd 'empty'
New-Item -ItemType Directory -Force -Path $ddEmpty | Out-Null
& node tools/density-ladder.mjs --read $ddEmpty --spec (Join-Path $dd 'a4\density-ladder.json') *> (Join-Path $tmp 'step4l-empty.log')
$dl5 = ($LASTEXITCODE -ne 0)
$dlOk = $dl1 -and $dl2 -and $dl3 -and $dl4 -and $dlCoarse -and $dlFine -and $dl5
if (-not $dlOk) { $script:fails++ }
Write-Host ("{0}  density ladder: --make -> simulated scan -> --read reports numbers, coarse band usable, fine band on the cliff  (make {1} scan {2} read {3} rows {4} coarse {5} fine {6} refuses-empty {7})" -f $(if ($dlOk) { ' PASS' } else { ' FAIL' }), $dl1, $dl2, $dl3, $dl4, $dlCoarse, $dlFine, $dl5)
if (-not $dlOk) { Get-Content $dlLog -Tail 6 | ForEach-Object { Write-Host ('          ' + ([string]$_).Trim()) } }

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
  Write-Host '           Also: the image path end to end -- a picture went in, its pages came back through the'
  Write-Host '           channel, the payload matched the manifest, and unpsk made it viewable again.'
  Write-Host '           Not proven here: real ink/paper, a real phone camera, browser print scaling (D8),'
  Write-Host '           PWA install (needs https), and G4/G6/G9. See docs/USE.md for those steps.'
  Write-Host '           (G7, G8 and G10 are retired: the 3D plate line was cancelled in round 109.)'
  exit 0
} else {
  Write-Host ("USABILITY: {0} step(s) FAILED in {1}s -- logs in {2}" -f $script:fails, [int]$script:t0.Elapsed.TotalSeconds, $tmp)
  exit 1
}
