-- ---------------------------------------------------------------------------
-- 공휴일 표 (영업일 기준 정산일 계산용)
--
-- 정산일 = 후원일 다음날부터 영업일 5일째.
-- 영업일에서 토·일과 이 표의 날짜를 뺀다.
-- 임시공휴일은 매년 갑자기 지정되므로 배포 없이 관리자 화면에서 고칠 수 있어야 한다.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'holiday_kind') THEN
    CREATE TYPE "holiday_kind" AS ENUM ('STATUTORY', 'SUBSTITUTE', 'TEMPORARY', 'BANK_ONLY');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "public_holiday" (
  "id"         TEXT NOT NULL,
  "date"       TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "kind"       "holiday_kind" NOT NULL DEFAULT 'STATUTORY',
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "memo"       TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "public_holiday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "public_holiday_date_key" ON "public_holiday" ("date");
CREATE INDEX IF NOT EXISTS "public_holiday_date_active_idx" ON "public_holiday" ("date", "active");

-- ---------------------------------------------------------------------------
-- 2026년 공휴일 (관공서의 공휴일에 관한 규정 + 근로자의 날)
--   * 근로자의 날(5/1)은 관공서 공휴일은 아니지만 은행이 쉬므로 이체가 불가능하다.
--     정산 지급은 은행 영업일에만 가능하므로 영업일 계산에서 함께 제외한다.
--   * 제헌절(7/17)은 2008년부터 공휴일이 아니다. 넣지 않는다.
--   * 실제 운영 전에 관리자 화면에서 반드시 한 번 대조할 것.
-- ---------------------------------------------------------------------------
INSERT INTO "public_holiday" ("id", "date", "name", "kind", "updated_at") VALUES
  ('hol2026010100000000000000', '2026-01-01', '신정',                'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026021600000000000000', '2026-02-16', '설날 연휴',            'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026021700000000000000', '2026-02-17', '설날',                'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026021800000000000000', '2026-02-18', '설날 연휴',            'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026030100000000000000', '2026-03-01', '삼일절',              'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026030200000000000000', '2026-03-02', '삼일절 대체공휴일',     'SUBSTITUTE', CURRENT_TIMESTAMP),
  ('hol2026050100000000000000', '2026-05-01', '근로자의 날 (은행 휴무)', 'BANK_ONLY', CURRENT_TIMESTAMP),
  ('hol2026050500000000000000', '2026-05-05', '어린이날',            'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026052400000000000000', '2026-05-24', '부처님오신날',         'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026052500000000000000', '2026-05-25', '부처님오신날 대체공휴일', 'SUBSTITUTE', CURRENT_TIMESTAMP),
  ('hol2026060300000000000000', '2026-06-03', '제9회 전국동시지방선거', 'TEMPORARY',  CURRENT_TIMESTAMP),
  ('hol2026060600000000000000', '2026-06-06', '현충일',              'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026081500000000000000', '2026-08-15', '광복절',              'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026081700000000000000', '2026-08-17', '광복절 대체공휴일',     'SUBSTITUTE', CURRENT_TIMESTAMP),
  ('hol2026092400000000000000', '2026-09-24', '추석 연휴',            'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026092500000000000000', '2026-09-25', '추석',                'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026092600000000000000', '2026-09-26', '추석 연휴',            'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026092800000000000000', '2026-09-28', '추석 대체공휴일',       'SUBSTITUTE', CURRENT_TIMESTAMP),
  ('hol2026100300000000000000', '2026-10-03', '개천절',              'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026100500000000000000', '2026-10-05', '개천절 대체공휴일',     'SUBSTITUTE', CURRENT_TIMESTAMP),
  ('hol2026100900000000000000', '2026-10-09', '한글날',              'STATUTORY',  CURRENT_TIMESTAMP),
  ('hol2026122500000000000000', '2026-12-25', '성탄절',              'STATUTORY',  CURRENT_TIMESTAMP)
ON CONFLICT ("date") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2027년: 날짜가 확정된 양력 공휴일만 미리 넣는다.
-- 설날·추석(음력)과 그에 따른 대체공휴일은 확정 발표 후 관리자 화면에서 추가한다.
-- (관리자 화면이 "음력 공휴일 미등록" 경고를 띄운다)
-- ---------------------------------------------------------------------------
INSERT INTO "public_holiday" ("id", "date", "name", "kind", "updated_at") VALUES
  ('hol2027010100000000000000', '2027-01-01', '신정',                'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027030100000000000000', '2027-03-01', '삼일절',              'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027050100000000000000', '2027-05-01', '근로자의 날 (은행 휴무)', 'BANK_ONLY', CURRENT_TIMESTAMP),
  ('hol2027050500000000000000', '2027-05-05', '어린이날',            'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027060600000000000000', '2027-06-06', '현충일',              'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027081500000000000000', '2027-08-15', '광복절',              'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027100300000000000000', '2027-10-03', '개천절',              'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027100900000000000000', '2027-10-09', '한글날',              'STATUTORY', CURRENT_TIMESTAMP),
  ('hol2027122500000000000000', '2027-12-25', '성탄절',              'STATUTORY', CURRENT_TIMESTAMP)
ON CONFLICT ("date") DO NOTHING;
