@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 최초 설치

echo.
echo ==========================================
echo   기브싸인 BASIC - 최초 설치
echo   서비스 포트: 3060
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo        https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [확인] Node.js %%v

node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20||(v[0]===20&&v[1]<19)) process.exit(1)"
if errorlevel 1 (
  echo [오류] Node.js 20.19 이상이 필요합니다. 최신 LTS 로 업데이트해 주세요.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [작업] .env 파일이 없어 .env.example 을 복사합니다.
  copy /y ".env.example" ".env" >nul
)

echo.
echo [1/4] 의존성 설치 (npm install)
echo       패키지가 700개 이상이라 첫 설치는 3~7분 걸립니다.
echo       화면이 멈춘 것처럼 보여도 정상이니 창을 닫지 마세요.
echo       EBADENGINE 경고는 사용하지 않는 부가 패키지 경고이므로 무시해도 됩니다.
echo.
call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 goto :fail

echo.
echo [2/4] Prisma 클라이언트 생성
call npx prisma generate
if errorlevel 1 goto :fail

echo.
echo [3/4] 데이터베이스 연결 확인 및 마이그레이션
call npm run check:db
if errorlevel 1 (
  echo.
  echo [중단] 데이터베이스에 연결하지 못해 설치를 멈춥니다.
  echo        도구_DB시작.bat 을 먼저 실행한 뒤 도구_최초설치.bat 을 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)
call npx prisma migrate deploy
if errorlevel 1 goto :fail

echo.
echo [4/4] 시드 데이터 생성
call npm run db:seed
if errorlevel 1 goto :fail

echo.
echo ==========================================
echo   설치가 완료되었습니다.
echo   2_개발서버실행.bat 을 실행하면 앱이 열립니다.
echo ==========================================
echo.
echo   주소       http://localhost:3060
echo   관리자     admin@givesign.kr / givesign1234!
echo   사회복지기관     merchant1@givesign.kr / givesign1234!
echo.
pause
exit /b 0

:fail
echo.
echo [오류] 설치 중 문제가 발생했습니다. 위 메시지를 확인해 주세요.
echo        원인을 자동 점검하려면 도구_환경점검.bat 을 실행하세요.
echo.
pause
exit /b 1
