param(
  [string]$Source = (Join-Path $PSScriptRoot '..\public\givesign-icon-v3.png'),
  [string]$Destination = (Join-Path $PSScriptRoot '..\src\app\favicon.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = [System.IO.Path]::GetFullPath($Source)
$destinationPath = [System.IO.Path]::GetFullPath($Destination)

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Favicon source was not found: $sourcePath"
}

$sizes = @(16, 32, 48, 64)
$pngImages = [System.Collections.Generic.List[byte[]]]::new()
$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)

try {
  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngImages.Add($stream.ToArray())
      } finally {
        $stream.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

$output = [System.IO.MemoryStream]::new()
$writer = [System.IO.BinaryWriter]::new($output)

try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$sizes.Count)

  $imageOffset = 6 + (16 * $sizes.Count)
  for ($index = 0; $index -lt $sizes.Count; $index++) {
    $size = $sizes[$index]
    $image = $pngImages[$index]
    $writer.Write([byte]$size)
    $writer.Write([byte]$size)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Length)
    $writer.Write([uint32]$imageOffset)
    $imageOffset += $image.Length
  }

  foreach ($image in $pngImages) {
    $writer.Write($image)
  }

  $writer.Flush()
  [System.IO.File]::WriteAllBytes($destinationPath, $output.ToArray())
} finally {
  $writer.Dispose()
  $output.Dispose()
}

Write-Output "Generated favicon: $destinationPath"
