@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 데이터베이스 초기화

echo.
echo ==========================================
echo   데이터베이스 초기화 + 시드
echo ==========================================
echo.
echo   [주의] 기존 데이터가 모두 삭제됩니다.
echo.
set /p CONFIRM="계속하려면 Y 를 입력하세요: "
if /i not "%CONFIRM%"=="Y" (
  echo 취소했습니다.
  pause
  exit /b 0
)

call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

call npm run check:db
if errorlevel 1 (
  echo.
  echo [중단] 데이터베이스에 연결하지 못했습니다. 도구_DB시작.bat 을 먼저 실행해 주세요.
  pause
  exit /b 1
)

call npx prisma migrate reset --force
if errorlevel 1 goto :fail
call npm run db:seed
if errorlevel 1 goto :fail

echo.
echo [완료] 초기화되었습니다.
echo.
pause
exit /b 0

:fail
echo.
echo [오류] 초기화에 실패했습니다.
pause
exit /b 1
