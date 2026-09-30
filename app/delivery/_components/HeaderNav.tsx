"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The two places an office user moves between: today's route, and the route
 * builder. A segmented control rather than two buttons, because it says where
 * you are as well as where you can go. Drivers never see it -- they have one
 * place to be.
 */
export function HeaderNav({ homeLabel }: { homeLabel: string }) {
  const path = usePathname() ?? "";
  const inAdmin = path.startsWith("/delivery/admin");
  return (
    <nav className="dv-seg dv-nav" aria-label="Delivery sections">
      <Link href="/delivery" aria-current={inAdmin ? undefined : "page"} aria-pressed={!inAdmin}>
        {homeLabel}
      </Link>
      <Link href="/delivery/admin" aria-current={inAdmin ? "page" : undefined} aria-pressed={inAdmin}>
        Admin
      </Link>
    </nav>
  );
}
