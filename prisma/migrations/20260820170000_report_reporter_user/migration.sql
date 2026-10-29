-- 신고/문의 접수자 식별을 content 문자열이 아닌 전용 컬럼으로 분리
ALTER TABLE "report" ADD COLUMN "reporter_user_id" TEXT;
