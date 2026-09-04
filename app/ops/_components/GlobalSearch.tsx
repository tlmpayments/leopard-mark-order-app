"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SearchIcon } from "./icons";

/**
 * Global search over accounts, orders, invoice #, BOL # and lot # (§8).
 *
 * Submits to a server-rendered results page rather than doing live lookahead:
 * one operator typing an invoice number wants the row, not a ranked dropdown,
 * and a server round-trip per keystroke against five entity types is a cost
 * with no matching benefit here.
 */
export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");

  return (
    <form
      className="search"
      data-ops-search
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        if (term) router.push(`/ops/search?q=${encodeURIComponent(term)}`);
      }}
    >
      <SearchIcon />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search accounts, orders, INV #, BOL #, lot #…"
        aria-label="Search accounts, orders, invoice numbers, BOL numbers and lot numbers"
      />
      <kbd>/</kbd>
    </form>
  );
}
