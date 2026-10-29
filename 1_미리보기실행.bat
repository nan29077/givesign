@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 간편 미리보기 (포트 3060)

set APP_URL=http://localhost:3060

echo.
echo ==========================================
echo   기브싸인 BASIC - 간편 미리보기
echo   %APP_URL%
echo ==========================================
echo.
echo   Docker 나 PostgreSQL 설치 없이 실행됩니다.
echo   내장 데이터베이스(PGlite)를 사용하며 데이터는 .givesign-pglite 폴더에 보관됩니다.
echo.
echo   코드를 고치면서 바로 확인하려면 도구_수정즉시반영.bat 을 쓰세요.
echo   (도구_수정즉시반영.bat 은 저장 즉시 화면에 반영되어 재빌드를 기다리지 않습니다)
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

if not exist ".env" copy /y ".env.example" ".env" >nul

call "%~dp0tools\ensure-deps.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist "src\generated\prisma" (
  echo [작업] Prisma 클라이언트 생성
  if not exist "logs" mkdir "logs"
  call npm run db:generate 2>&1
  if errorlevel 1 (
    echo.
    echo [오류] Prisma 클라이언트 생성에 실패했습니다.
    echo        원인을 확인하려면 도구_상세진단.bat 을 실행해 주세요.
    echo        (logs\diag.log 에 상세 로그가 저장됩니다)
    echo.
    pause
    exit /b 1
  )
)

netstat -ano | findstr /r /c:":3060 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [정리] 이전에 실행된 서버가 남아 있습니다. 정리한 뒤 새로 시작합니다.
)

echo.
echo [안내] 서버 준비가 끝나면 브라우저가 자동으로 열립니다.
echo        처음에는 화면 빌드에 1~3분 걸립니다. 두 번째부터는 30초 내외입니다.
echo        종료하려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo        (창을 닫으면 서버도 함께 종료됩니다)
echo.
echo   메인        %APP_URL%
echo   사회복지기관    %APP_URL%/studio   merchant1@givesign.kr / givesign1234!
echo   관리자      %APP_URL%/admin    admin@givesign.kr / givesign1234!
echo   문자 시뮬   %APP_URL%/admin/simulator
echo.

call npm run preview
set PREVIEW_EXIT=%errorlevel%

echo.
if not "%PREVIEW_EXIT%"=="0" (
  echo ==========================================
  echo   [오류] 미리보기가 정상 종료되지 않았습니다.
  echo   위 메시지를 확인해 주세요.
  echo   원인 점검: 도구_상세진단.bat  /  설치 복구: 도구_설치복구.bat
  echo ==========================================
) else (
  echo [종료] 미리보기 서버가 종료되었습니다.
)
echo.
pause

endlocal
