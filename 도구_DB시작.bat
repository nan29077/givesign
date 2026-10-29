@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 데이터베이스 시작

echo.
echo ==========================================
echo   PostgreSQL + Redis 컨테이너 시작
echo ==========================================
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo [오류] Docker 를 찾을 수 없습니다.
  echo        Docker Desktop 을 설치하거나, 직접 설치한 PostgreSQL 을 사용하려면
  echo        .env 의 DATABASE_URL 을 해당 서버 주소로 수정하세요.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo [오류] Docker Desktop 이 실행 중이 아닙니다.
  echo        Docker Desktop 을 먼저 켠 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

rem 폴더명이 한글이면 Compose 가 프로젝트 이름을 자동 생성하지 못하므로 -p 로 지정한다.
docker compose -p givesign up -d
if errorlevel 1 (
  echo.
  echo [오류] 컨테이너를 시작하지 못했습니다.
  echo        Docker Desktop 이 실행 중인지, 5432/6379 포트가 비어 있는지 확인해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo [대기] 데이터베이스가 준비될 때까지 확인합니다.
for /l %%i in (1,1,30) do (
  docker exec givesign-postgres pg_isready -U givesign -d givesign >nul 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 2 >nul
)
echo [경고] 준비 확인에 실패했습니다. docker ps 로 상태를 확인해 주세요.
goto :done

:ready
echo [완료] PostgreSQL(5432), Redis(6379) 준비 완료

:done
echo.
echo   컨테이너를 내리려면: docker compose -p givesign down
echo   다음 단계: 도구_최초설치.bat 실행
echo.
pause
endlocal
