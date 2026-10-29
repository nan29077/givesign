-- 금칙어는 더 이상 결제를 막지 않는다 (문자PG 전환)
--
-- 문자 본문은 외부에 노출되지 않고 사회복지기관·최고관리자만 문자 관리 화면에서 본다.
-- 그래서 차단(BLOCK) 대신 마스킹(MASK)만 사용한다. 기존 차단 규칙을 마스킹으로 옮긴다.
-- content_action 타입의 BLOCK 값은 과거 데이터(donation.status = CONTENT_BLOCKED) 조회를 위해 남겨 둔다.

UPDATE "banned_word" SET "action" = 'MASK' WHERE "action" = 'BLOCK';
