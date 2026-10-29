-- 차단 방향 분리
--   후원자 -> 사회복지기관 : donor_creator_link.donor_blocked_at
--   사회복지기관 -> 후원자 : blocked_donor (사유·처리자를 함께 남기는 기존 전용 테이블)
--
-- 기존에는 두 방향이 donor_creator_link.blocked_at 한 컬럼을 함께 썼다.
-- 그래서 사회복지기관가 차단을 해제하면 후원자가 직접 건 차단까지 같이 풀렸다.

ALTER TABLE "donor_creator_link" RENAME COLUMN "blocked_at" TO "donor_blocked_at";

-- 기존 데이터 이전.
-- blocked_donor 에 행이 있는 쌍의 blocked_at 은 스튜디오 차단이 기록한 값이므로
-- 후원자 차단으로 남겨두면 안 된다. (사회복지기관 차단 자체는 blocked_donor 가 그대로 보존한다)
UPDATE "donor_creator_link" AS l
   SET "donor_blocked_at" = NULL
  FROM "blocked_donor" AS b
 WHERE b."creator_id" = l."creator_id"
   AND b."donor_id" = l."donor_id"
   AND l."donor_blocked_at" IS NOT NULL;
