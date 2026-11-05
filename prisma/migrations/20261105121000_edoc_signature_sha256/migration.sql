-- 2026-11-05 점검 D: 전자문서 서명 이미지 내용 해시(완료본 해시가 이미지 주소만이 아니라 내용에 묶이게)
ALTER TABLE "edoc_signer" ADD COLUMN "signature_sha256" TEXT;
