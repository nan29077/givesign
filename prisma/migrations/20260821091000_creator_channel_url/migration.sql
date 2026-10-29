-- ---------------------------------------------------------------------------
-- 6) 사회복지기관 대표 채널 주소 분리.
--    신청 시 소개글 뒤에 "채널: <URL>" 을 이어 붙여 저장하고 있었는데,
--    소개 300자 + 채널주소 304자 = 최대 604자가 되어 스튜디오 후원샵 설정의
--    300자 제한에 걸려 **저장 자체가 영구히 실패**하는 상태였다.
--    별도 컬럼으로 분리하고 기존 행도 되돌린다.
-- ---------------------------------------------------------------------------
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "channel_url" TEXT;

-- 기존 description 끝에 붙어 있던 "채널: ..." 줄을 channel_url 로 옮기고 소개글에서 제거한다.
UPDATE "creator_profile"
   SET "channel_url" = NULLIF(TRIM(SUBSTRING("description" FROM '채널: *([^\n]+)')), ''),
       "description" = NULLIF(TRIM(REGEXP_REPLACE("description", '\n?채널: *[^\n]+', '', 'g')), '')
 WHERE "description" LIKE '%채널: %' AND "channel_url" IS NULL;

-- 그래도 300자를 넘는 잔여 소개글은 잘라 저장 잠김을 완전히 해소한다.
UPDATE "creator_profile"
   SET "description" = LEFT("description", 300)
 WHERE "description" IS NOT NULL AND LENGTH("description") > 300;
