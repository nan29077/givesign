-- 코드 검수 후속 조치 2건.
--
-- 1) 계속 커지는 표에 시간축 단독 인덱스를 추가한다.
--    다섯 표 모두 (외래키, 시각) 복합 인덱스는 있지만 시각 단독 인덱스가 없었다.
--    그런데 해당 관리자 목록 화면들은 필터를 걸지 않은 기본 진입 상태에서
--    시각 역순 정렬 + 페이지네이션을 한다. 행이 수백만 건이 되면 화면을 열 때마다
--    표 전체를 정렬하게 된다. (donation 표에는 이미 같은 인덱스가 있다)
--
-- 2) creator_profile 의 사용자 외래키를 CASCADE 에서 RESTRICT 로 바꾼다.
--    donor_profile 은 SET NULL 로 신중하게 설계돼 있는데 creator_profile 만 CASCADE 라,
--    사용자 행을 하드 삭제하면 정산계좌·오버레이 설정·유튜브 연동·TTS 설정이 연쇄 삭제된다.
--    현재 앱 코드는 전부 소프트 삭제(status=WITHDRAWN)라 아직 발생하지 않았지만,
--    개인정보 파기 기능이나 수기 SQL 이 들어오는 순간 조용히 사라진다.

-- 1) 시간축 단독 인덱스
CREATE INDEX IF NOT EXISTS "mo_inbound_message_received_at_idx"
  ON "mo_inbound_message" ("received_at");

CREATE INDEX IF NOT EXISTS "mt_outbound_message_created_at_idx"
  ON "mt_outbound_message" ("created_at");

CREATE INDEX IF NOT EXISTS "payment_transaction_requested_at_idx"
  ON "payment_transaction" ("requested_at");

CREATE INDEX IF NOT EXISTS "admin_audit_log_created_at_idx"
  ON "admin_audit_log" ("created_at");

CREATE INDEX IF NOT EXISTS "settlement_ledger_occurred_at_idx"
  ON "settlement_ledger" ("occurred_at");

-- 2) 사회복지기관 프로필 외래키: CASCADE -> RESTRICT
ALTER TABLE "creator_profile" DROP CONSTRAINT "creator_profile_user_id_fkey";

ALTER TABLE "creator_profile"
  ADD CONSTRAINT "creator_profile_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
