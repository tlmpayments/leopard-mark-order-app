-- Dispatch: routes, stops, and the driver role.

-- AlterEnum
-- Postgres 12+ permits ALTER TYPE ... ADD VALUE inside a transaction block so
-- long as the new value is not USED in that same transaction. Nothing below
-- writes a 'driver' row, so this is safe in Prisma's transactional migration.
ALTER TYPE "UserRole" ADD VALUE 'driver';

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('draft', 'dispatched', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('pending', 'delivered', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "reps" ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "delivery_routes" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "region" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "status" "RouteStatus" NOT NULL DEFAULT 'draft',
    "name" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "dispatched_by_user_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "StopStatus" NOT NULL DEFAULT 'pending',
    "arrived_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_routes_date_region_idx" ON "delivery_routes"("date", "region");

-- CreateIndex
CREATE INDEX "delivery_routes_driver_id_date_idx" ON "delivery_routes"("driver_id", "date");

-- CreateIndex
CREATE INDEX "delivery_routes_status_date_idx" ON "delivery_routes"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_order_id_key" ON "route_stops"("order_id");

-- CreateIndex
CREATE INDEX "route_stops_route_id_status_idx" ON "route_stops"("route_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_route_id_sequence_key" ON "route_stops"("route_id", "sequence");

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_routes" ADD CONSTRAINT "delivery_routes_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "reps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "delivery_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
