/**
 * Creates the mirror's Notion databases under a parent page. Run once.
 *
 *   NOTION_PARENT_PAGE_ID=<page id> npx tsx scripts/notion-provision.ts
 *
 * Idempotent-ish: it refuses to run if notion-databases.json already exists
 * unless --force is passed, because a second run creates a *second* set of
 * empty databases rather than reusing the first, and the only symptom is a
 * confusingly empty dashboard.
 *
 * Relations are created in two passes. Notion needs the target database to
 * exist before a relation property can reference it, and several of these
 * relations point forward (order lines → products), so pass one creates every
 * database without relations and pass two patches them in.
 */
import { config as loadEnv } from "dotenv";
import { NotionClient } from "../lib/notion/client";
import { DATABASES } from "../lib/notion/schema";
import { requireToken, writeConfig, type NotionConfig } from "../lib/notion/config";
import { existsSync } from "node:fs";
import { join } from "node:path";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const force = process.argv.includes("--force");

function parentPageId(): string {
  const raw = process.env.NOTION_PARENT_PAGE_ID;
  if (!raw) {
    throw new Error(
      "NOTION_PARENT_PAGE_ID is not set. Open the Notion page the dashboard " +
        "should live under, Share → connect your integration, then copy the " +
        "32-character id from its URL.",
    );
  }
  // Accept a full URL or a bare id, with or without dashes.
  const id = raw.trim().replace(/^.*?([0-9a-f]{32}).*$/i, "$1").replace(/-/g, "");
  if (id.length !== 32) throw new Error(`Could not read a Notion page id from "${raw}"`);
  return id;
}

async function main(): Promise<void> {
  if (existsSync(join(process.cwd(), "notion-databases.json")) && !force) {
    throw new Error("notion-databases.json already exists. Pass --force to provision a fresh set.");
  }

  const notion = new NotionClient(requireToken());
  const parent = parentPageId();
  const config: NotionConfig = {
    parentPageId: parent,
    provisionedAt: new Date().toISOString(),
    databases: {},
  };

  // Pass 1 — create every database with its non-relation properties.
  for (const db of DATABASES) {
    const properties: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(db.properties)) {
      if ("__relation" in def) continue;
      properties[name] = def;
    }
    const created = await notion.createDatabase({
      parent: { type: "page_id", page_id: parent },
      icon: { type: "emoji", emoji: db.icon },
      title: [{ type: "text", text: { content: db.title } }],
      properties,
    });
    config.databases[db.key] = { id: created.id, title: db.title, url: created.url };
    console.log(`created  ${db.title.padEnd(16)} ${created.id}${db.internalOnly ? "  [internal only]" : ""}`);
  }

  // Pass 2 — patch in relations now that every target exists.
  for (const db of DATABASES) {
    const relations: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(db.properties)) {
      if (!("__relation" in def)) continue;
      const targetKey = (def as { __relation: string }).__relation;
      const target = config.databases[targetKey];
      if (!target) throw new Error(`${db.key}.${name} points at unknown database "${targetKey}"`);
      relations[name] = { relation: { database_id: target.id, single_property: {} } };
    }
    if (!Object.keys(relations).length) continue;
    await notion.updateDatabase(config.databases[db.key].id, { properties: relations });
    console.log(`relations ${db.title.padEnd(15)} ${Object.keys(relations).join(", ")}`);
  }

  await writeConfig(config);
  console.log(`\nWrote notion-databases.json (${DATABASES.length} databases).`);
  console.log("Internal-only (never share with external guests):");
  for (const db of DATABASES.filter((d) => d.internalOnly)) console.log(`  · ${db.title}`);
  console.log("\nNext: npx tsx scripts/notion-sync.ts --full");
}

main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exit(1);
});
