-- A PIN that opens the delivery site only. See Rep.deliveryPinHash in
-- schema.prisma. Additive: one nullable column, no backfill, nothing reads it
-- until a person is given one.
ALTER TABLE "reps" ADD COLUMN "delivery_pin_hash" TEXT;
