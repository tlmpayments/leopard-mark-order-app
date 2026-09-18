"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./icons";
export function Navigation({ items }: { items: Array<{ href: string; key: string; label: string; count?: number; hot?: boolean }> }) {
  const path = usePathname();
  return <nav className="nav" aria-label="Sections">{items.map(item => {
    const active = item.href === "/ops" ? path === item.href : path.startsWith(item.href);
    return <Link key={item.href} href={item.href} className={active ? "on" : ""} aria-current={active ? "page" : undefined}><NavIcon name={item.key} />{item.label}{item.count ? <span className={`cnt${item.hot ? " hot" : ""}`}>{item.count}</span> : null}</Link>;
  })}</nav>;
}
