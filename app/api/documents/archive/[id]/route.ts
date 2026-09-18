import { db } from "@/lib/db";
import { requireOpsUser, DOCS_ROLES } from "@/lib/ops/session";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireOpsUser(DOCS_ROLES);
  const doc = await db.archivedDocument.findUnique({ where: { id: (await params).id } });
  if (!doc) return new Response("Document not found", { status: 404 });
  if(new URL(request.url).searchParams.has("source")) {
    const payload=doc.payloadJson as {kind?:string;sourceFile?:{name:string;base64:string}};
    if(payload.kind!=="warehouse_report"||!payload.sourceFile)return new Response("No source file",{status:404});
    return new Response(Buffer.from(payload.sourceFile.base64,"base64"),{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Cache-Control":"private, no-store","Content-Disposition":'attachment; filename="'+payload.sourceFile.name.replace(/[^a-zA-Z0-9_.-]/g,"_")+'"'}});
  }
  const download = new URL(request.url).searchParams.has("download");
  return new Response(doc.renderedHtml, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(download ? { "Content-Disposition": 'attachment; filename="' + doc.docNumber.replace(/[^a-zA-Z0-9_.-]/g, "_") + '.html"' } : {}),
  } });
}
