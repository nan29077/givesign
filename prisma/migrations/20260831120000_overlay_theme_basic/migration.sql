-- 오버레이 기본 테마 값 이름 변경 (TORNADO -> BASIC)
-- 브랜드명이 들어간 값이라 브랜드 전환과 함께 중립적인 이름으로 바꾼다.
ALTER TABLE "overlay_setting" ALTER COLUMN "theme" SET DEFAULT 'BASIC';
UPDATE "overlay_setting" SET "theme" = 'BASIC' WHERE "theme" = 'TORNADO';
