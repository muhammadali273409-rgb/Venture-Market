-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VerificationType" ADD VALUE 'ANALYTICS';
ALTER TYPE "VerificationType" ADD VALUE 'CUSTOMERS';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "message" TEXT;

-- AlterTable
ALTER TABLE "deals" ADD COLUMN     "buyerReceiptConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "sellerTransferConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deal_participants" ADD COLUMN     "ndaSignedAt" TIMESTAMP(3);

