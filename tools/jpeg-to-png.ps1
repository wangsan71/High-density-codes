# ASCII only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
<#
.SYNOPSIS
  Converts JPEG photos to PNG for the CLI receiver.

.DESCRIPTION
  pskit's Node CLI reads PNG and TIFF natively. The browser receiver can decode
  JPEG through the browser's own image pipeline; this helper does the same for
  CLI users on Windows via the built-in System.Drawing API.

.EXAMPLE
  & .\tools\jpeg-to-png.ps1 -Source D:\pskt-photos -Out D:\pskt-photos-png
#>
param(
  [string]$Source = '.',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $src -PathType Container)) {
  Write-Output "source directory does not exist: $src"
  exit 2
}
$dst = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path $src 'png' }
[IO.Directory]::CreateDirectory($dst) | Out-Null

$files = @(Get-ChildItem -LiteralPath $src -File | Where-Object { $_.Extension -match '^\.(jpg|jpeg)$' })
if ($files.Count -eq 0) {
  Write-Output "no jpg/jpeg files in $src"
  exit 2
}

foreach ($f in $files) {
  $img = [System.Drawing.Image]::FromFile($f.FullName)
  try {
    $outPath = Join-Path $dst ($f.BaseName + '.png')
    $img.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("{0} -> {1}" -f $f.Name, $outPath)
  } finally {
    $img.Dispose()
  }
}

Write-Output ("converted {0} JPEG file(s) to {1}" -f $files.Count, $dst)
exit 0
