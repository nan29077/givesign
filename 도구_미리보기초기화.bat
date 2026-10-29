@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 미리보기 초기화

echo.
echo ==========================================
echo   미리보기 데이터베이스 초기화
echo ==========================================
echo.
echo   내장 데이터베이스(.givesign-pglite)와 화면 빌드 결과(.givesign-next)를 지웁니다.
echo   다음 실행 때 시드 계정과 샘플 데이터가 새로 만들어집니다.
echo.
echo   [주의] 미리보기에서 만든 데이터는 모두 사라집니다.
echo          도커/PostgreSQL 로 띄운 개발용 DB 는 건드리지 않습니다.
echo.
set /p CONFIRM="계속하려면 Y 를 입력하세요: "
if /i not "%CONFIRM%"=="Y" (
  echo 취소했습니다.
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo [1/3] 실행 중인 서버를 정리합니다.
node tools\stop-server.mjs

echo [2/3] 내장 데이터베이스(.givesign-pglite)를 지웁니다.
if exist ".givesign-pglite" (
  rmdir /s /q ".givesign-pglite"
  if exist ".givesign-pglite" (
    echo [오류] .givesign-pglite 폴더를 지우지 못했습니다.
    echo        미리보기 창이 아직 열려 있는지 확인한 뒤 다시 실행해 주세요.
    echo.
    pause
    exit /b 1
  )
  echo       삭제했습니다.
) else (
  echo       이미 없습니다.
)

echo [3/3] 화면 빌드 결과(.givesign-next)를 지웁니다.
if exist ".givesign-next" (
  rmdir /s /q ".givesign-next"
  echo       삭제했습니다.
) else (
  echo       이미 없습니다.
)
if exist "tsconfig.tsbuildinfo" del /f /q "tsconfig.tsbuildinfo" >nul 2>nul

echo.
echo [완료] 이제 1_미리보기실행.bat 을 실행하세요.
echo        처음 실행이라 화면 빌드에 1~3분 걸립니다.
echo.
pause

endlocal
