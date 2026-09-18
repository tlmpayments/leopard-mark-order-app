import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";

export type ArchiveInput = {
  docNumber: string; docType: string; html: string; payload: Prisma.InputJsonValue;
  accountId?: string | null; orderId?: string | null; summary: string;
};
export function documentHash(html: string): string { return createHash("sha256").update(html).digest("hex"); }

// Same content reuses its archive entry. Changed content gets a new immutable
// entry under the ORIGINAL document number. No overwrite path is exposed.
export async function archiveDocument(input: ArchiveInput, tx: Prisma.TransactionClient = db) {
  const html = await embedDocumentAssets(input.html);
  const sha256 = documentHash(html + "\0" + JSON.stringify(input.payload));
  return tx.archivedDocument.upsert({
    where: { docNumber_sha256: { docNumber: input.docNumber, sha256 } },
    update: {},
    create: {
      docNumber: input.docNumber, docType: input.docType, sha256,
      renderedHtml: html, payloadJson: input.payload, summary: input.summary,
      accountId: input.accountId ?? null, orderId: input.orderId ?? null,
    },
  });
}

// Include the exact brand artwork so downloaded and future versions stay complete.
async function embedDocumentAssets(html: string): Promise<string> {
  for (const name of ["logo-alt.svg", "logo-lmc.svg"]) {
    const src = `/rep-app/assets/icons/brand/${name}`;
    if (!html.includes(src)) continue;
    const bytes = await readFile(join(process.cwd(), "public", src));
    html = html.replaceAll(src, `data:image/svg+xml;base64,${bytes.toString("base64")}`);
  }
  return html;
}
