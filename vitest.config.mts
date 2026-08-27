import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Phase 2 (Sheet <-> Postgres sync) test suite. Node environment (these are
// server-side Prisma/route-handler tests, not component tests), same `@/*`
// path alias as tsconfig.json so test files can import app code the same
// way the app itself does.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Sequential, not parallel -- every test file shares one live Postgres
    // instance and mutates the same tables; running files in parallel
    // workers would race each other's inserts/cleanups.
    fileParallelism: false,
    env: {
      // Local test Postgres started via
      // `npx prisma dev --name phase2-final-test --detach`, migrated with
      // `prisma migrate deploy`. lib/db.ts (and app/api/sheet-sync/webhook's
      // import of it) reads DATABASE_URL from process.env at import time.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://postgres:postgres@localhost:51222/template1?sslmode=disable",
      SYNC_SHARED_SECRET: "test-shared-secret",
    },
  },
});
