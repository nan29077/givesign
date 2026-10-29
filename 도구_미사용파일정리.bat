@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 기브싸인 - 미사용 파일 정리

echo.
echo ==========================================
echo   미사용 파일 정리
echo ==========================================
echo.
echo   코드에서 참조하지 않는 이미지와, 대상 파일이 사라져
echo   더는 동작하지 않는 자산 생성 스크립트를 지웁니다.
echo   약 87개 파일, 46MB 입니다.
echo.
echo   [지우는 것]
echo     public\_legacy-munjapay\        옛 브랜드 아트 16개 (18MB)
echo     public\avatars\givesign\      구버전 아바타 50개 (20MB)
echo     public\stickers\givesign\     스티커 8개 (4MB)
echo     public\screenshots\             옛 후원페이지 스크린샷 2개
echo     public\assets\ 미사용 4개       margin-home-v2, margin-sub-v3, section-*.svg
echo     public\ 의 Next 템플릿 기본 svg 5개
echo     scripts\                        옛 브랜드 자산 생성 스크립트 4개
echo     tools\generate-brand-assets.py  토네이도 자산 생성기
echo.
echo   [남기는 것] 배치 파일 전부, 마이그레이션, e2e, docs,
echo               사용 중인 이미지(avatars\givesign-v2 포함)
echo.
echo   git 이력에 남아 있어 되돌릴 수 있습니다.
echo.
choice /c YN /n /m "정말 지울까요? [Y=예 / N=아니오] "
if errorlevel 2 (
  echo 취소했습니다.
  echo.
  pause
  exit /b 0
)

echo.
echo [1/4] 옛 브랜드 아트와 구버전 이미지 폴더
if exist "public\_legacy-munjapay" rmdir /s /q "public\_legacy-munjapay"
if exist "public\avatars\givesign" rmdir /s /q "public\avatars\givesign"
if exist "public\stickers\givesign" rmdir /s /q "public\stickers\givesign"
if exist "public\stickers" rmdir /q "public\stickers" 2>nul
if exist "public\screenshots" rmdir /s /q "public\screenshots"

echo [2/4] 미사용 assets
if exist "public\assets\givesign-margin-home-v2.png" del /f /q "public\assets\givesign-margin-home-v2.png"
if exist "public\assets\givesign-margin-sub-v3.png" del /f /q "public\assets\givesign-margin-sub-v3.png"
if exist "public\assets\section-broadcast.svg" del /f /q "public\assets\section-broadcast.svg"
if exist "public\assets\section-protect.svg" del /f /q "public\assets\section-protect.svg"

echo [3/4] Next 템플릿 기본 svg
for %%F in (file.svg globe.svg next.svg vercel.svg window.svg) do (
  if exist "public\%%F" del /f /q "public\%%F"
)

echo [4/4] 동작하지 않는 자산 생성 스크립트
if exist "scripts" rmdir /s /q "scripts"
if exist "tools\generate-brand-assets.py" del /f /q "tools\generate-brand-assets.py"

echo.
echo [완료] 정리했습니다.
echo.
echo [남은 변경 사항]
git status --short | more
echo.
echo   확인 후 4_깃푸시.bat 으로 커밋/푸시하시거나,
echo   Claude 에게 커밋을 요청하세요.
echo.
echo   이 정리 파일(도구_미사용파일정리.bat)은 한 번 쓰고 지우셔도 됩니다.
echo.
pause

endlocal
