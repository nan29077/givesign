-- 월간 안내 실행 선점(수동 실행·배치 겹침 방지)
ALTER TABLE "notice_run" ADD COLUMN "locked_at" TIMESTAMPTZ(3);
ALTER TABLE "notice_run" ADD COLUMN "locked_by" TEXT;

-- 관리자 배너·공지 보관(되돌릴 수 있는 삭제)
ALTER TABLE "banner" ADD COLUMN "archived_at" TIMESTAMPTZ(3);
ALTER TABLE "content_post" ADD COLUMN "archived_at" TIMESTAMPTZ(3);

-- SNS 채널: OAuth 연동이 구현된 적이 없으므로 실연동(mock=false)으로 '연결됨' 표시된 행은 모두 꾸며진 것이다.
-- 로그인 연동 대기로 돌리고 자리표시자 토큰을 지운다(게시는 CONNECTED 만 허용하므로 자연히 막힌다).
UPDATE "social_channel"
   SET "status" = 'PENDING_OAUTH', "access_token_enc" = NULL, "refresh_token_enc" = NULL
 WHERE "mock" = false AND "status" = 'CONNECTED';
