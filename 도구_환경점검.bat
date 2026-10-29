@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 환경 점검

echo.
echo ==========================================
echo   기브싸인 BASIC - 환경 점검
echo ==========================================
echo.

echo [1] Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo     설치되지 않음  -^> https://nodejs.org 에서 LTS 설치 필요
) else (
  for /f "tokens=*" %%v in ('node -v') do echo     %%v
  node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20||(v[0]===20&&v[1]<19)) process.exit(1)"
  if errorlevel 1 (echo     20.19 미만 -^> 업데이트 필요) else (echo     버전 요구사항 충족)
)

echo.
echo [2] npm
where npm >nul 2>nul
if errorlevel 1 (echo     설치되지 않음) else (for /f "tokens=*" %%v in ('npm -v') do echo     %%v)

echo.
echo [3] Docker
where docker >nul 2>nul
if errorlevel 1 (
  echo     설치되지 않음 ^(직접 설치한 PostgreSQL 을 쓰신다면 무시^)
) else (
  docker ps --filter "name=givesign-postgres" --format "     컨테이너: {{.Names}} {{.Status}}" 2>nul
  docker ps --filter "name=givesign-redis" --format "     컨테이너: {{.Names}} {{.Status}}" 2>nul
)

echo.
echo [4] 프로젝트 파일
if exist ".env" (echo     .env 있음) else (echo     .env 없음 -^> .env.example 복사 필요)
if exist "node_modules" (echo     node_modules 있음) else (echo     node_modules 없음 -^> 1_미리보기실행.bat 실행 시 자동 설치)
if exist "node_modules\.package-lock.json" (echo     설치 완료 표식 있음) else (echo     설치 미완료 -^> 1_미리보기실행.bat 이 자동으로 다시 설치)
if exist "node_modules\.bin\next.cmd" (echo     next 실행 파일 있음) else (echo     next 실행 파일 없음 -^> 설치 미완료)
if exist "node_modules\.bin\prisma.cmd" (echo     prisma 실행 파일 있음) else (echo     prisma 실행 파일 없음 -^> 설치 미완료)
if exist "node_modules\@electric-sql\pglite-socket" (echo     내장 DB 패키지 있음) else (echo     내장 DB 패키지 없음 -^> 설치 미완료)
if exist ".givesign-pglite" (echo     내장 DB 데이터 있음) else (echo     내장 DB 데이터 없음 ^(첫 1_미리보기실행.bat 실행 시 생성^)^)
if exist "src\generated\prisma" (echo     Prisma 클라이언트 있음) else (echo     Prisma 클라이언트 없음 -^> npx prisma generate 필요)

echo.
echo [5] 포트 3060
netstat -ano | findstr /r /c:":3060 .*LISTENING" >nul 2>nul
if errorlevel 1 (echo     사용 가능) else (echo     이미 사용 중 -^> 기존 서버 창을 확인하세요)

echo.
echo [6] 데이터베이스 연결
if exist "node_modules" (
  call npm run check:db
) else (
  echo     node_modules 가 없어 확인을 건너뜁니다.
)

echo.
echo ==========================================
echo   점검이 끝났습니다.
echo ==========================================
echo.
pause
endlocal
