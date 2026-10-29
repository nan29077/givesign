@echo off
chcp 65001 >nul
title 기브싸인 - 깃 푸시
cd /d "%~dp0"

echo.
echo ================= 기브싸인 깃 푸시 =================
echo.

rem 남아 있는 잠금 파일 정리 (이것 때문에 커밋/푸시가 막히는 경우가 있다)
if exist ".git\index.lock" del /f /q ".git\index.lock" >nul 2>nul
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock" >nul 2>nul

echo [현재 상태]
git status -sb
echo.
echo [푸시 대기 중인 커밋]
git log --oneline origin/main..main
echo.

git rev-list --count origin/main..main > "%TEMP%\_givesign_ahead.txt" 2>nul
set /p AHEAD=<"%TEMP%\_givesign_ahead.txt"
del /f /q "%TEMP%\_givesign_ahead.txt" >nul 2>nul

if "%AHEAD%"=="0" (
  echo 푸시할 커밋이 없습니다. 이미 최신입니다.
  echo.
  pause
  exit /b 0
)

echo %AHEAD%개의 커밋을 origin/main 으로 보냅니다.
choice /c YN /n /m "계속할까요? [Y=예 / N=아니오] "
if errorlevel 2 (
  echo 취소했습니다.
  echo.
  pause
  exit /b 0
)

echo.
git push origin main
echo.

if errorlevel 1 (
  echo [실패] 푸시하지 못했습니다.
  echo   - 로그인 창이 떴다면 GitHub 계정으로 로그인한 뒤 다시 실행하세요.
  echo   - "rejected" 오류라면 아래를 먼저 실행하세요.
  echo       git pull --rebase origin main
) else (
  echo [완료] 푸시했습니다.
  echo.
  git status -sb
)

echo.
pause
