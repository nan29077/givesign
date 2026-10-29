-- 후원 접수 채널 (MO 문자 / WEB 후원샵 웹 후원)
ALTER TABLE "donation" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'MO';
