# 기브싸인 미리보기 복구 실행기
#
# 핵심: .givesign-next(빌드 폴더)가 잠겨서 지워지지 않으면, 그 위에 새 빌드가 덧씌워지며
# "client reference manifest" 오류로 서버가 죽는다. 그래서 지우지 못하면 빌드하지 않고 멈춘다.
#
# 파일 인코딩은 반드시 UTF-8 with BOM 이어야 한글이 깨지지 않는다(Windows PowerShell 5.1).

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
Set-Location ..

$root = (Get-Location).Path
New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
$log = Join-Path $root 'logs\preview.log'
Remove-Item -Force -ErrorAction SilentlyContinue $log

function Say([string]$m) { $m | Tee-Object -FilePath $log -Append }

Say "================================================"
Say " 기브싸인 미리보기 복구 실행"
Say " 시작 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say " 폴더 $root"
Say "================================================"
Say ""
Say "--- [1] 실행 환경 ---"
Say "PowerShell $($PSVersionTable.PSVersion)"
Say "Node $(& node -v)"
Say "npm  $(& npm -v)"

Say ""
Say "--- [2] 실행 중인 node 프로세스 ---"
$nodes = Get-Process node -ErrorAction SilentlyContinue
if ($nodes) {
  $nodes | ForEach-Object { Say ("  PID {0}  시작 {1}" -f $_.Id, $_.StartTime) }
  Say ""
  Say "  이 프로세스들이 빌드 폴더를 붙잡고 있어 삭제가 실패합니다. 모두 종료합니다."
  Say "  (다른 node 작업이 돌고 있었다면 함께 종료됩니다)"
  $nodes | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
} else {
  Say "  없음"
}
Remove-Item -Force -ErrorAction SilentlyContinue '.givesign-server.lock'

Say ""
Say "--- [3] 빌드 폴더(.givesign-next) 삭제 ---"
$deleted = $false
for ($i = 1; $i -le 6; $i++) {
  if (-not (Test-Path '.givesign-next')) { $deleted = $true; break }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '.givesign-next'
  if (-not (Test-Path '.givesign-next')) { $deleted = $true; break }
  Say "  시도 $i 실패 - 1.5초 뒤 다시 시도합니다"
  Start-Sleep -Milliseconds 1500
}

if (-not $deleted) {
  Say ""
  Say "================================================"
  Say " [중단] .givesign-next 폴더를 지우지 못했습니다."
  Say ""
  Say " 지금 빌드하면 깨진 빌드 위에 덧씌워져 서버가 또 죽습니다."
  Say " 그래서 여기서 멈춥니다."
  Say ""
  Say " 아래를 순서대로 해주세요."
  Say "   1) VS Code / Cursor / 편집기를 완전히 종료"
  Say "   2) 탐색기에서 기브싸인 폴더 창을 모두 닫기"
  Say "   3) 이 배치 파일을 다시 실행"
  Say ""
  Say " 그래도 안 되면 PC를 재부팅한 뒤 다시 실행해 주세요."
  Say "================================================"
  Read-Host "엔터를 누르면 창이 닫힙니다"
  exit 1
}
Say "  .givesign-next 삭제 완료 - 처음부터 새로 빌드합니다"

Say ""
Say "--- [4] 포트 확인 (3060 앱 / 5463 내장DB) ---"
$ports = netstat -ano | Select-String -Pattern ':3060\s', ':5463\s'
if ($ports) { $ports | ForEach-Object { Say ("  " + $_.ToString().Trim()) } } else { Say "  비어 있음 (정상)" }

Say ""
Say "--- [5] 미리보기 실행 ---"
Say "  빌드에 1~3분 걸립니다. 화면이 멈춘 것처럼 보여도 기다려 주세요."
Say "  'Ready in ...' 이 보이면 브라우저가 자동으로 열립니다."
Say "  끄려면 Ctrl+C 또는 창 닫기."
Say ""

$env:PREVIEW_MODE = ''
& npm run preview 2>&1 | Tee-Object -FilePath $log -Append

Say ""
Say "================================================"
Say " 종료 코드: $LASTEXITCODE"
Say " 기록: logs\preview.log"
Say "================================================"
Read-Host "엔터를 누르면 창이 닫힙니다"
