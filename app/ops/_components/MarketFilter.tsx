import Link from "next/link";
import type { Market } from "@/lib/ops/scope";
export function MarketFilter({ path, market, params = {} }: { path: string; market: Market; params?: Record<string, string> }) {
  return <nav className="market-filter" aria-label="Filter by region">
    {([["all", "All regions"], ["LA", "Los Angeles"], ["BA", "SF Bay"], ["unknown", "Other / unassigned"]] as const).map(([key, label]) =>
      <Link key={key} aria-current={market === key ? "page" : undefined} className={market === key ? "on" : ""} href={path + "?" + new URLSearchParams({ ...params, market: key })}>{label}</Link>
    )}
  </nav>;
}
