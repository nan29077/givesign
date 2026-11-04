-- 문서 서식: 올린 원본 파일 위에서 직접 고치기 (원본 PDF + 편집 기록 + 결과 PDF)
ALTER TABLE "document_template"
  ADD COLUMN "base_pdf_url" TEXT,
  ADD COLUMN "base_pdf_hash" TEXT,
  ADD COLUMN "base_converted_from" TEXT,
  ADD COLUMN "pdf_page_count" INTEGER,
  ADD COLUMN "pdf_layout" JSONB,
  ADD COLUMN "rendered_pdf_url" TEXT,
  ADD COLUMN "rendered_pdf_hash" TEXT,
  ADD COLUMN "pdf_edited_at" TIMESTAMPTZ(3);
