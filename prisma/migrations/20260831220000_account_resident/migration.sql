-- 자동 정산 전환: 사회복지기관이 정산을 요청하는 단계가 사라졌으므로
-- 원천징수 신고용 주민등록번호를 정산 계좌에 미리 등록해 둔다.
-- (회차 생성 시 settlement_request 로 복사되고, 신고 완료 시 회차 쪽에서 파기된다)
ALTER TABLE "settlement_account" ADD COLUMN "resident_enc" TEXT;
ALTER TABLE "settlement_account" ADD COLUMN "resident_masked" TEXT;
