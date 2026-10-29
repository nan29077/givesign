@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 테스트

echo.
echo ==========================================
echo   핵심 흐름 통합 테스트 (27개)
echo ==========================================
echo.
echo   [주의] 테스트는 개발 DB 를 비웁니다.
echo          끝난 뒤 시드 데이터를 다시 생성합니다.
echo.

call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

call npm test
set TESTRESULT=%errorlevel%

echo.
echo [작업] 시드 데이터 재생성
call npm run db:seed

echo.
if "%TESTRESULT%"=="0" (
  echo [완료] 모든 테스트를 통과했습니다.
) else (
  echo [실패] 실패한 테스트가 있습니다. 위 로그를 확인해 주세요.
)
echo.
pause
endlocal
