@echo off
rem ---------------------------------------------------------------------------
rem 의존성 설치 상태와 무결성을 검사하고, 문제가 있으면 복구한다.
rem 다른 배치 파일에서 call 로 호출한다. 성공 0 / 실패 1
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

call :filecheck
if "%NEEDS%"=="1" goto :install

rem 파일은 있어도 내부가 깨진 패키지가 있을 수 있으므로 무결성 검사
call node tools\verify-deps.mjs >nul 2>&1
if errorlevel 1 (
  echo.
  echo [점검] 설치된 패키지 일부가 손상되었습니다. 상세 내용:
  call node tools\verify-deps.mjs
  set WHY=패키지 손상
  goto :clean_install
)

endlocal
exit /b 0

:install
echo.
echo [설치] 의존성 설치가 필요합니다. 사유: %WHY%
echo        첫 설치는 3~7분 걸립니다. 화면이 멈춘 것처럼 보여도 정상이니
echo        창을 닫지 마시고 끝날 때까지 기다려 주세요.
echo        EBADENGINE 경고는 사용하지 않는 부가 패키지 경고이므로 무시해도 됩니다.
echo.
call npm install --no-fund --no-audit

call :filecheck
if "%NEEDS%"=="1" goto :clean_install
call node tools\verify-deps.mjs >nul 2>&1
if errorlevel 1 goto :clean_install
goto :ok

:clean_install
echo.
echo [복구] node_modules 를 지우고 잠금파일 기준으로 정확히 다시 설치합니다.
echo        이전 설치가 중간에 끊겨 파일이 빠졌을 때 필요한 단계입니다.
echo        3~7분 걸립니다. 창을 닫지 마세요.
echo.
if exist "node_modules" rmdir /s /q "node_modules"
call npm ci --no-fund --no-audit
if errorlevel 1 (
  echo.
  echo [복구] npm ci 실패. 일반 설치로 다시 시도합니다.
  echo.
  if exist "node_modules" rmdir /s /q "node_modules"
  call npm install --no-fund --no-audit
)

call :filecheck
if "%NEEDS%"=="1" goto :failed
call node tools\verify-deps.mjs
if errorlevel 1 goto :failed
goto :ok

:ok
echo.
echo [설치] 정상 확인되었습니다.
endlocal
exit /b 0

:failed
echo.
echo [오류] 의존성 설치를 완료하지 못했습니다.
echo.
echo        확인해 볼 것
echo          1. 인터넷 연결 / 사내 방화벽 / 프록시 설정
echo          2. npm cache clean --force 실행 후 재시도
echo          3. 백신이 node_modules 쓰기를 차단하는지 - 예외 등록
echo          4. 설치 중에 창을 닫거나 Ctrl+C 를 누르지 않았는지
echo.
endlocal
exit /b 1

:filecheck
set NEEDS=0
set WHY=
if not exist "node_modules" (
  set NEEDS=1
  set WHY=node_modules 폴더 없음
)
if not exist "node_modules\.package-lock.json" (
  set NEEDS=1
  set WHY=설치가 끝까지 완료되지 않음
)
if not exist "node_modules\.bin\next.cmd" (
  set NEEDS=1
  set WHY=next 실행 파일 없음
)
if not exist "node_modules\.bin\prisma.cmd" (
  set NEEDS=1
  set WHY=prisma 실행 파일 없음
)
if not exist "node_modules\.bin\tsx.cmd" (
  set NEEDS=1
  set WHY=tsx 실행 파일 없음
)
if not exist "node_modules\@electric-sql\pglite-socket" (
  set NEEDS=1
  set WHY=내장 DB 패키지 없음
)
exit /b 0
