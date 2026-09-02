"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keyboard navigation (§8): `/` focuses search, `g o` orders, `g a` accounts,
 * `g i` inventory, `esc` closes drawers.
 *
 * The `g`-prefix chords are a deliberate copy of the convention ops staff
 * already know from GitHub/Linear — an ops console gets used for hours a day,
 * and the difference between reaching orders in one keystroke and three clicks
 * compounds. The only client component in the shell.
 */
export function Shortcuts() {
  const router = useRouter();

  useEffect(() => {
    let awaitingG = false;
    let gTimer: ReturnType<typeof setTimeout> | undefined;

    const isTyping = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Escape") {
        // Close whatever is open, in the order a user would expect: the
        // innermost thing first.
        if (isTyping()) (document.activeElement as HTMLElement).blur();
        const open = document.querySelector<HTMLDetailsElement>("details[data-drawer][open]");
        if (open) open.open = false;
        return;
      }

      if (isTyping()) return;

      if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-ops-search] input")?.focus();
        return;
      }

      if (awaitingG) {
        awaitingG = false;
        clearTimeout(gTimer);
        const dest: Record<string, string> = {
          o: "/ops/orders",
          a: "/ops/accounts",
          i: "/ops/inventory",
          d: "/ops/deliveries",
          b: "/ops/billing",
          h: "/ops",
        };
        const path = dest[e.key.toLowerCase()];
        if (path) {
          e.preventDefault();
          router.push(path);
        }
        return;
      }

      if (e.key.toLowerCase() === "g") {
        awaitingG = true;
        // A chord that never times out means a stray `g` silently swallows the
        // next keystroke, which feels like the app dropped an input.
        gTimer = setTimeout(() => {
          awaitingG = false;
        }, 1200);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(gTimer);
    };
  }, [router]);

  return null;
}
