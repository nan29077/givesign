param(
  [string[]]$Sources = @(
    (Join-Path $PSScriptRoot '..\public\avatars-givesign-a-v1.png'),
    (Join-Path $PSScriptRoot '..\public\avatars-givesign-b-v1.png')
  ),
  [string]$Destination = (Join-Path $PSScriptRoot '..\public\avatars\givesign')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$destinationPath = [System.IO.Path]::GetFullPath($Destination)
[System.IO.Directory]::CreateDirectory($destinationPath) | Out-Null

$outputSize = 512
$outputInset = 10
$avatarNumber = 1

foreach ($source in $Sources) {
  $sourcePath = [System.IO.Path]::GetFullPath($source)
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Avatar sheet was not found: $sourcePath"
  }

  $sheet = [System.Drawing.Bitmap]::new($sourcePath)
  try {
    $cellWidth = $sheet.Width / 5.0
    $cellHeight = $sheet.Height / 5.0
    # 시트의 캐릭터 몸체는 행 경계를 넘지만 얼굴은 각 셀 중앙에 있다.
    # 셀보다 작은 중앙 정사각형을 사용해 이웃 캐릭터를 원천적으로 제외한다.
    for ($row = 0; $row -lt 5; $row++) {
      for ($column = 0; $column -lt 5; $column++) {
        $portraitScale = if ($row -eq 0) { 0.82 } else { 0.72 }
        $portraitSize = [int][Math]::Round([Math]::Min($cellWidth, $cellHeight) * $portraitScale)
        $centerX = (($column + 0.5) * $cellWidth)
        # 두 번째 행부터는 앞 행 캐릭터의 하단이 셀 위쪽으로 넘어와 있으므로
        # 얼굴 중심을 약간 아래로 옮겨 이전 캐릭터 조각을 완전히 제외한다.
        $centerY = (($row + 0.5) * $cellHeight) + $(if ($row -eq 0) { 0 } else { 22 })
        $sourceLeft = [int][Math]::Round($centerX - ($portraitSize / 2.0))
        $sourceTop = [int][Math]::Round($centerY - ($portraitSize / 2.0))
        $sourceRect = [System.Drawing.Rectangle]::new(
          $sourceLeft,
          $sourceTop,
          $portraitSize,
          $portraitSize
        )

        $avatar = [System.Drawing.Bitmap]::new(
          $outputSize,
          $outputSize,
          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
        )

        try {
          $graphics = [System.Drawing.Graphics]::FromImage($avatar)
          try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

            $clip = [System.Drawing.Drawing2D.GraphicsPath]::new()
            try {
              $clip.AddEllipse(
                $outputInset,
                $outputInset,
                $outputSize - ($outputInset * 2),
                $outputSize - ($outputInset * 2)
              )
              $graphics.SetClip($clip)
              $destinationRect = [System.Drawing.Rectangle]::new(
                $outputInset,
                $outputInset,
                $outputSize - ($outputInset * 2),
                $outputSize - ($outputInset * 2)
              )
              $graphics.DrawImage($sheet, $destinationRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
            } finally {
              $clip.Dispose()
            }
          } finally {
            $graphics.Dispose()
          }

          $fileName = 'avatar-{0:D2}.png' -f $avatarNumber
          $outputPath = Join-Path $destinationPath $fileName
          $avatar.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
          $avatarNumber += 1
        } finally {
          $avatar.Dispose()
        }
      }
    }
  } finally {
    $sheet.Dispose()
  }
}

$generatedCount = $avatarNumber - 1
if ($generatedCount -ne 50) {
  throw "Expected 50 avatars but generated $generatedCount."
}

Write-Output "Generated $generatedCount individual circular avatars in $destinationPath"
