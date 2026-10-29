@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 서버 종료

echo.
echo ==========================================
echo   기브싸인 BASIC - 실행 중인 서버 종료
echo ==========================================
echo.
echo   창을 닫아도 남아 있는 서버를 정리합니다.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

node tools\stop-server.mjs

echo.
pause

endlocal
