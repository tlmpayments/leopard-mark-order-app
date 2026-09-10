import { UnlockForm } from "./UnlockForm";

/**
 * The Ops Hub's unlock screen: four digits, no name.
 *
 * Lives at /unlock rather than under /ops because app/ops/layout.tsx gates the
 * whole segment with `requireOpsUser` -- most hub pages have no gate of their
 * own and rely on it -- and a login page inside a layout that redirects the
 * unauthenticated would bounce to itself forever. proxy.ts keeps /unlock out
 * of the host rewrites, so ops.tlmbg.co/unlock, inventory.tlmbg.co/unlock and
 * bol.tlmbg.co/unlock all land here and return to the hostname they came from.
 */
export const metadata = { title: "Leopard Mark — Ops" };

export default async function UnlockPage({ searchParams }: PageProps<"/unlock">) {
  const { next } = await searchParams;

  // Where the gate turned them away from, so unlocking resumes the page they
  // actually asked for. Same-origin paths only, checked here rather than in
  // the browser: a `next` that could point at another site would make this an
  // open redirect wearing a login page's face.
  const raw = typeof next === "string" ? next : "/ops";
  const target = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/ops";

  return <UnlockForm next={target} />;
}
