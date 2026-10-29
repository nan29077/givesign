@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 상세 진단

if not exist "logs" mkdir "logs"
set LOG=logs\diag.log

echo. > "%LOG%"
echo ================= 기브싸인 진단 ================= >> "%LOG%"
echo [시각] %DATE% %TIME% >> "%LOG%"
echo [경로] %CD% >> "%LOG%"
echo. >> "%LOG%"

echo === Node / npm === >> "%LOG%"
node -v >> "%LOG%" 2>&1
npm -v >> "%LOG%" 2>&1
where node >> "%LOG%" 2>&1
where npm >> "%LOG%" 2>&1
echo. >> "%LOG%"

echo === 파일 확인 === >> "%LOG%"
if exist ".env" (echo .env 있음 >> "%LOG%") else (echo .env 없음 >> "%LOG%")
if exist "prisma\schema.prisma" (echo schema.prisma 있음 >> "%LOG%") else (echo schema.prisma 없음 >> "%LOG%")
if exist "prisma.config.mjs" (echo prisma.config.mjs 있음 >> "%LOG%") else (echo prisma.config.mjs 없음 >> "%LOG%")
if exist "prisma.config.ts" (echo prisma.config.ts 있음 - 제거 대상 >> "%LOG%") else (echo prisma.config.ts 없음 >> "%LOG%")
if exist "node_modules\.package-lock.json" (echo 설치 완료 표식 있음 >> "%LOG%") else (echo 설치 완료 표식 없음 >> "%LOG%")
if exist "node_modules\.bin\prisma.cmd" (echo prisma.cmd 있음 >> "%LOG%") else (echo prisma.cmd 없음 >> "%LOG%")
if exist "node_modules\.bin\next.cmd" (echo next.cmd 있음 >> "%LOG%") else (echo next.cmd 없음 >> "%LOG%")
if exist "node_modules\.bin\tsx.cmd" (echo tsx.cmd 있음 >> "%LOG%") else (echo tsx.cmd 없음 >> "%LOG%")
if exist "node_modules\.bin\pglite-server.cmd" (echo pglite-server.cmd 있음 >> "%LOG%") else (echo pglite-server.cmd 없음 >> "%LOG%")
if exist "src\generated\prisma" (echo Prisma 클라이언트 있음 >> "%LOG%") else (echo Prisma 클라이언트 없음 >> "%LOG%")
echo. >> "%LOG%"

echo === 쓰기 권한 확인 === >> "%LOG%"
echo test > "logs\_write_test.tmp" 2>>"%LOG%"
if exist "logs\_write_test.tmp" (echo 쓰기 가능 >> "%LOG%" & del /f /q "logs\_write_test.tmp") else (echo 쓰기 불가 >> "%LOG%")
if not exist "src" mkdir "src" 2>>"%LOG%"
echo test > "src\_write_test.tmp" 2>>"%LOG%"
if exist "src\_write_test.tmp" (echo src 쓰기 가능 >> "%LOG%" & del /f /q "src\_write_test.tmp") else (echo src 쓰기 불가 >> "%LOG%")
echo. >> "%LOG%"

echo === 패키지 무결성 === >> "%LOG%"
call node tools\verify-deps.mjs >> "%LOG%" 2>&1
echo exitcode=%errorlevel% >> "%LOG%"
echo. >> "%LOG%"

echo === prisma 버전 === >> "%LOG%"
call npm exec -- prisma -v >> "%LOG%" 2>&1
echo exitcode=%errorlevel% >> "%LOG%"
echo. >> "%LOG%"

echo === prisma generate (핵심) === >> "%LOG%"
call npm run db:generate >> "%LOG%" 2>&1
echo exitcode=%errorlevel% >> "%LOG%"
echo. >> "%LOG%"

echo === 결과 === >> "%LOG%"
if exist "src\generated\prisma" (echo Prisma 클라이언트 생성 성공 >> "%LOG%") else (echo Prisma 클라이언트 생성 실패 >> "%LOG%")
echo ================= 끝 ================= >> "%LOG%"

echo.
echo ==========================================
echo   진단이 끝났습니다.
echo   결과 파일: logs\diag.log
echo ==========================================
echo.
type "%LOG%"
echo.
echo 위 내용이 logs\diag.log 에 저장되었습니다.
echo.
pause
endlocal
