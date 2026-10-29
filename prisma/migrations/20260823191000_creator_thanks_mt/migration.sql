-- 사회복지기관가 직접 작성하는 후원 감사 MT 문자 본문.
-- NULL 이거나 빈 값이면 기본 템플릿을 사용한다.
ALTER TABLE "creator_profile" ADD COLUMN "thanks_mt_message" TEXT;
