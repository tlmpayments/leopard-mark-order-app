-- CreateEnum
CREATE TYPE "AccountApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN "approval_status" "AccountApprovalStatus" NOT NULL DEFAULT 'pending';

-- Every account that already exists at this point was either imported from
-- the Sheet (Phase 1) or added by a rep -- never a self-service portal
-- signup -- so all of them are pre-approved. Only a NEW row inserted after
-- this migration (i.e. a real portal signup) gets the column default of
-- 'pending' instead.
UPDATE "accounts" SET "approval_status" = 'approved';
