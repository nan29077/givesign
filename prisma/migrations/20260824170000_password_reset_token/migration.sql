-- 비밀번호 재설정 1회용 토큰.
--
-- 원문 토큰은 저장하지 않는다(세션 토큰과 동일한 규칙). 유출된 DB 만으로는
-- 재설정 링크를 만들 수 없어야 한다.
--
-- 사용 규칙
--  - 유효시간 1시간, 1회용(used_at 이 채워지면 재사용 불가)
--  - 재설정에 성공하면 해당 사용자의 세션을 전부 폐기한다(user_session revoke)

CREATE TABLE "password_reset_token" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "request_ip" TEXT,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at"    TIMESTAMPTZ(3),
  "used_ip"    TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");
CREATE INDEX "password_reset_token_user_id_idx" ON "password_reset_token"("user_id");
CREATE INDEX "password_reset_token_expires_at_idx" ON "password_reset_token"("expires_at");

ALTER TABLE "password_reset_token"
  ADD CONSTRAINT "password_reset_token_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
