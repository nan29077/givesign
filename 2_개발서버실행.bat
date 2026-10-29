@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 개발 서버 (포트 3060)

set APP_PORT=3060
set APP_URL=http://localhost:%APP_PORT%

echo.
echo ==========================================
echo   기브싸인 BASIC - 개발 서버
echo   %APP_URL%
echo ==========================================
echo.
echo   이 방식은 별도 PostgreSQL 이 필요합니다.
echo   설치 없이 바로 보시려면 창을 닫고 1_미리보기실행.bat 을 실행하세요.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 를 찾을 수 없습니다. https://nodejs.org 에서 설치해 주세요.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [확인] Node.js %%v

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

echo [확인] 데이터베이스 연결
call npm run check:db
if errorlevel 1 (
  echo.
  echo [중단] 데이터베이스가 준비되지 않아 서버를 시작하지 않습니다.
  echo        이 상태로 실행하면 화면이 계속 로딩만 됩니다.
  echo.
  echo        도구_DB시작.bat 을 실행한 뒤 다시 시도하시거나,
  echo        설치 없이 보시려면 1_미리보기실행.bat 을 실행하세요.
  echo.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":%APP_PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [정리] 이전에 실행된 서버가 남아 있습니다. 정리한 뒤 새로 시작합니다.
)

echo.
echo [안내] 서버 준비가 끝나면 브라우저가 자동으로 열립니다.
echo        첫 실행은 화면 컴파일 때문에 20~60초 정도 걸립니다.
echo        서버를 끄려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
echo        (창을 닫으면 서버도 함께 종료됩니다)
echo.
echo   메인        %APP_URL%
echo   사회복지기관      %APP_URL%/studio   merchant1@givesign.kr / givesign1234!
echo   관리자      %APP_URL%/admin    admin@givesign.kr / givesign1234!
echo.

start "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='%APP_URL%/api/health'; for($i=0;$i -lt 150;$i++){ try{ $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5; if($r.StatusCode -eq 200){ Start-Process '%APP_URL%'; exit } }catch{}; Start-Sleep -Seconds 2 }"

call node tools\serve.mjs dev

endlocal
