-- Proof of delivery: the photos the driver takes at the door.

-- CreateTable
CREATE TABLE "delivery_photos" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "route_stop_id" TEXT,
    "pathname" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "caption" TEXT,
    "uploaded_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_photos_pathname_key" ON "delivery_photos"("pathname");

-- CreateIndex
CREATE INDEX "delivery_photos_order_id_created_at_idx" ON "delivery_photos"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "delivery_photos_route_stop_id_idx" ON "delivery_photos"("route_stop_id");

-- AddForeignKey
ALTER TABLE "delivery_photos" ADD CONSTRAINT "delivery_photos_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: rebuilding a route must never delete delivery evidence.
ALTER TABLE "delivery_photos" ADD CONSTRAINT "delivery_photos_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "route_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
