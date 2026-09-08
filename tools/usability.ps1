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
  Write-Host '           Not proven here: real ink/paper, a real phone camera, browser print scaling (D8),'
  Write-Host '           PWA install (needs https), and G4/G6/G9/G10. See docs/USE.md for those steps.'
  exit 0
} else {
  Write-Host ("USABILITY: {0} step(s) FAILED in {1}s -- logs in {2}" -f $script:fails, [int]$script:t0.Elapsed.TotalSeconds, $tmp)
  exit 1
}
