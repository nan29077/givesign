# 로고 투명 배경 처리 — 2026-10-30

내장 image_gen 편집 도구로 승인된 3번 시안의 흰 배경을 제거했습니다.

- 로고: public/assets/givesign/brand/logo-hope-transparent-v7.png
- 심벌: public/assets/givesign/brand/mark-hope-transparent-v7.png
- 파비콘: public/givesign-icon-v7.png, public/favicon.ico
- 모바일 아이콘: public/apple-touch-icon-v7.png

프롬프트: Remove ONLY the white/off-white background and white texture, including negative spaces inside Korean letters and between leaves. Output genuine alpha transparency. Preserve original symbol shape, orange heart and smile arc, dark green leaves, Korean lettering 기브싸인 including orange dot, English GiveSign lettering, original arrangement, colors and proportions. No redesign, font substitution, new text, shadows or white outlines.

로고·심벌은 알파 채널을 유지합니다. 파비콘과 모바일 아이콘의 알파 최솟값은 0, 최댓값은 255로 확인했습니다.
