@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 설치 복구

echo.
echo ==========================================
echo   기브싸인 BASIC - 설치 복구
echo ==========================================
echo.
echo   node_modules 를 지우고 잠금파일 기준으로 정확히 다시 설치합니다.
echo   설치가 중간에 끊겨 파일이 빠졌을 때 사용합니다.
echo   3~7분 걸립니다.
echo.
set /p CONFIRM="계속하려면 Y 를 입력하세요: "
if /i not "%CONFIRM%"=="Y" (
  echo 취소했습니다.
  pause
  exit /b 0
)

if exist "node_modules" rmdir /s /q "node_modules"
if exist "src\generated" rmdir /s /q "src\generated"

call npm ci --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo [복구] npm ci 실패. 일반 설치로 다시 시도합니다.
  echo.
  if exist "node_modules" rmdir /s /q "node_modules"
  call npm install --no-fund --no-audit
)

echo.
echo [확인] 패키지 무결성 검사
call node tools\verify-deps.mjs
if errorlevel 1 (
  echo.
  echo [오류] 아직 손상된 패키지가 있습니다. 위 목록을 확인해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo [작업] Prisma 클라이언트 생성
call npm run db:generate
if errorlevel 1 (
  echo.
  echo [오류] Prisma 클라이언트 생성에 실패했습니다. 도구_상세진단.bat 을 실행해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo   복구가 완료되었습니다.
echo   1_미리보기실행.bat 을 실행하세요.
echo ==========================================
echo.
pause
endlocal
