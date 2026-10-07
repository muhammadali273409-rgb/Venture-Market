-- CreateEnum
CREATE TYPE "BusinessImageKind" AS ENUM ('LOGO', 'GALLERY');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "city" TEXT;

-- CreateTable
CREATE TABLE "business_images" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" "BusinessImageKind" NOT NULL DEFAULT 'GALLERY',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_images_storageKey_key" ON "business_images"("storageKey");

-- CreateIndex
CREATE INDEX "business_images_businessId_kind_position_idx" ON "business_images"("businessId", "kind", "position");

-- AddForeignKey
ALTER TABLE "business_images" ADD CONSTRAINT "business_images_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data fix: listings were created with visibility PRIVATE and nothing in the
-- product ever switched them to PUBLIC, so published listings never reached
-- the marketplace. Publishing now sets PUBLIC; backfill the ones already live.
UPDATE "business_listings"
SET "visibility" = 'PUBLIC'
WHERE "status" = 'PUBLISHED' AND "visibility" = 'PRIVATE';
