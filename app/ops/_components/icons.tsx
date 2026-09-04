/**
 * Nav icons as inline SVG paths, carried over from the mockup.
 *
 * Inline rather than an icon package: there are nine of them, they never
 * change, and §8 says no emoji as UI — a dependency for nine paths would be
 * more weight than the paths.
 */
export const NAV_ICON_PATHS: Record<string, string> = {
  home: "M3 12 12 4l9 8M5 10v10h14V10",
  orders: "M4 5h16M4 12h16M4 19h10",
  accounts: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  deliveries:
    "M3 7h11v9H3zM14 10h4l3 3v3h-7zM6 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm12 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  inventory: "M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9",
  documents: "M7 3h7l5 5v13H7zM14 3v5h5",
  billing: "M3 6h18v12H3zM3 10h18M7 15h4",
  automations: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7-3 2 1-1 3-2 0-1 2 0 2-3 1-1-2h-2l-1 2-3-1 0-2-1-2-2 0-1-3 2-1v-2l-2-1 1-3 2 0 1-2 0-2 3-1 1 2h2l1-2 3 1 0 2 1 2 2 0 1 3-2 1z",
};

export function NavIcon({ name }: { name: string }) {
  return (
    <svg
      className="ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={NAV_ICON_PATHS[name] ?? NAV_ICON_PATHS.home} />
    </svg>
  );
}

export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
