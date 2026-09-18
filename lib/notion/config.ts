/**
 * Where the mirror's Notion database ids live.
 *
 * `notion-databases.json` is written once by `npm run notion:provision` and
 * committed, so deploys and local runs agree on which databases to write to.
 * Database ids are not secrets — they are useless without NOTION_TOKEN, and the
 * integration only has access to the databases it was explicitly shared with.
 *
 * Losing this file does not lose data: re-running provision against the same
 * parent page creates fresh databases, and a full sync repopulates them. That
 * is the whole point of a rebuildable mirror.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NotionConfig = {
  parentPageId: string;
  provisionedAt: string;
  databases: Record<string, { id: string; title: string; url?: string }>;
};

const FILE = () => join(process.cwd(), "notion-databases.json");

export async function readConfig(): Promise<NotionConfig> {
  try {
    return JSON.parse(await readFile(FILE(), "utf8")) as NotionConfig;
  } catch {
    throw new Error(
      "notion-databases.json not found. Run `npm run notion:provision` first — " +
        "it creates the Notion databases and records their ids.",
    );
  }
}

export async function writeConfig(config: NotionConfig): Promise<void> {
  await writeFile(FILE(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function requireToken(): string {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_TOKEN is not set. Create an internal integration at " +
        "notion.so/my-integrations, then share the parent page with it.",
    );
  }
  return token;
}
