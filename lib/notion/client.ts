/**
 * Minimal Notion REST client.
 *
 * Deliberately not `@notionhq/client`: this sync needs four endpoints, and the
 * SDK's types churn with every API version. `fetch` plus a rate limiter is less
 * code than the adapter we'd write around the SDK anyway.
 *
 * Pinned to API version 2022-06-28. The 2025-09-03 version splits a database
 * into database + data source and changes the shape of every call here; there
 * is no reason to take that migration on for a read-only mirror. When bumping,
 * expect `databases.query` and `pages.create` parents to move to data_source_id.
 */

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com/v1";

/**
 * Notion's documented limit is ~3 requests/second averaged, and it answers a
 * burst with 429 + Retry-After. A full rebuild is ~1,600 writes, so pacing
 * matters more than parallelism: at 3/s the whole mirror lands in ~9 minutes,
 * and incremental runs are a handful of calls. One in-flight request at a time
 * keeps ordering deterministic, which makes failures reproducible.
 */
class RateLimiter {
  private next = 0;
  constructor(private readonly intervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export class NotionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "NotionError";
  }
}

export class NotionClient {
  private readonly limiter = new RateLimiter(1000 / 3);

  constructor(private readonly token: string) {
    if (!token) throw new Error("NOTION_TOKEN is not set");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Retry only on 429 and 5xx. A 400 means we built a bad property payload
    // and retrying just burns the rate budget on the same mistake.
    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait();
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) {
        const detail = await res.text();
        let code = "unknown";
        let message = detail;
        try {
          const parsed = JSON.parse(detail) as { code?: string; message?: string };
          code = parsed.code ?? code;
          message = parsed.message ?? message;
        } catch {
          /* non-JSON error body; keep the raw text */
        }
        throw new NotionError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${message}`);
      }

      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
  }

  createDatabase(body: unknown) {
    return this.request<{ id: string; url: string }>("POST", "/databases", body);
  }

  retrieveDatabase(id: string) {
    return this.request<{ id: string; properties: Record<string, unknown> }>("GET", `/databases/${id}`);
  }

  updateDatabase(id: string, body: unknown) {
    return this.request<{ id: string }>("PATCH", `/databases/${id}`, body);
  }

  createPage(body: unknown) {
    return this.request<{ id: string }>("POST", "/pages", body);
  }

  updatePage(id: string, body: unknown) {
    return this.request<{ id: string }>("PATCH", `/pages/${id}`, body);
  }

  /** Every page in a database, following pagination. Volumes here are in the hundreds. */
  async queryAll(databaseId: string): Promise<Array<{ id: string; properties: Record<string, any> }>> {
    const out: Array<{ id: string; properties: Record<string, any> }> = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{
        results: Array<{ id: string; properties: Record<string, any> }>;
        next_cursor: string | null;
        has_more: boolean;
      }>("POST", `/databases/${databaseId}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      out.push(...page.results);
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }
}
