-- MO 수신 중복 차단 키를 (사업자, 사업자 메시지 ID) 복합 유니크로 바꾼다.
--
-- 왜 바꾸나
-- ---------
-- provider_message_id 단독 유니크는 "사업자가 달라도 메시지 ID 는 절대 겹치지 않는다" 를 전제한다.
-- 실제로는 사업자마다 채번 체계가 제각각이다. MTONET 은 "MT-20260820-0001" 형태지만,
-- EMMA(인포뱅크)의 mo_key 는 짧은 일련번호가 될 수 있고, 사업자를 바꾸거나 병행 운영하면
-- 값이 충돌한다. 충돌하면 **다른 사람이 보낸 새 문자가 DUPLICATE 로 조용히 버려진다.**
-- (결제 요청이 접수되지 않고 후원자에게는 아무 문자도 가지 않는다)
--
-- 반대 방향(같은 사업자의 같은 메시지가 두 번 들어오는 것)은 그대로 막힌다.
-- 멱등성 4중 방어의 1차 방어선이므로 유니크 제약 자체는 유지한다.

DROP INDEX IF EXISTS "mo_inbound_message_provider_message_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "mo_inbound_message_provider_code_provider_message_id_key"
  ON "mo_inbound_message"("provider_code", "provider_message_id");
