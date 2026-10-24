-- Deal flow UI support.
--
-- 1. The seller can answer a due diligence item in writing, not only by
--    linking a document.
-- 2. An agreement version can point at an uploaded deal document (PDF)
--    instead of an external URL.

ALTER TABLE "due_diligence_items" ADD COLUMN "response" TEXT;

ALTER TABLE "agreement_versions" ADD COLUMN "documentId" TEXT;
