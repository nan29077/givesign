-- ---------------------------------------------------------------------------
-- MT 문자 본문 커스터마이즈 표
--
-- 관리자 화면에서 저장한 안내 문구를 담는다. 행이 없으면 코드 기본 문구를 쓰므로
-- 이 표가 비어 있어도 기존 발송 동작은 그대로다(추가만 하는 마이그레이션).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "mt_message_template" (
  "id"         TEXT NOT NULL,
  "code"       TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  "updated_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "mt_message_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mt_message_template_code_key" ON "mt_message_template" ("code");
