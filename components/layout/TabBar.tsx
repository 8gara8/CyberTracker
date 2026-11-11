"use client";
// SPEC §7 "Page frame", TabBar: the two tab rows of the masthead. Family: <nav aria-label="Trackers">, ME
// and Europe as plain <a> to run.json siblings, then Cyber (`/`, aria-current="true", ink fill). Main:
// <nav aria-label="Main">, the siblings' MastheadNav: Today (active on / and /brief/*), Archive, Method,
// About; item pages mark none; the active tab is ink filled with aria-current="page". Mono 11px uppercase,
// 40px tall, scrolling sideways with a hidden scrollbar. Owner: pages lane. One of the two client
// components (usePathname()).
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface TabBarProps {
  variant: "family" | "main";
  /** run.json siblings; the family bar needs them. */
  siblings?: { me: string; europe: string };
  /**
   * The path to mark active, for tests. Default: usePathname() (the page's own path at build time and in
   * the browser).
   */
  pathname?: string;
}

/** A main tab: its path, label and the paths it is active on. */
interface Tab {
  href: string;
  label: string;
  match: (path: string) => boolean;
}

const MAIN_TABS: readonly Tab[] = [
  { href: "/", label: "Today", match: (p) => p === "/" || p.startsWith("/brief/") },
  { href: "/archive", label: "Archive", match: (p) => p === "/archive" || p.startsWith("/archive/") },
  { href: "/methodology", label: "Method", match: (p) => p === "/methodology" || p.startsWith("/methodology/") },
  { href: "/about", label: "About", match: (p) => p === "/about" || p.startsWith("/about/") },
];

/** The main tab active on `path`, or null (item pages, the 404 page). A trailing slash is ignored. */
function activeMainTab(path: string): string | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return MAIN_TABS.find((t) => t.match(p))?.href ?? null;
}

const BAR = "flex items-stretch overflow-x-auto font-mono text-[11px] uppercase tracking-[0.16em] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const TAB = "flex min-h-10 items-center whitespace-nowrap border-r border-line px-3 no-underline md:px-4";
const ACTIVE = "bg-fg text-bg";
const IDLE = "text-fg hover:underline";

export function TabBar({ variant, siblings, pathname }: TabBarProps) {
  const current = usePathname();
  if (variant === "family") {
    return (
      <nav aria-label="Trackers" className={`${BAR} mb-[10px] border-b border-line`}>
        {siblings ? (
          <>
            <a href={siblings.me} className={`${TAB} ${IDLE}`}>ME</a>
            <a href={siblings.europe} className={`${TAB} ${IDLE}`}>Europe</a>
          </>
        ) : null}
        <Link href="/" aria-current="true" className={`${TAB} ${ACTIVE}`}>Cyber</Link>
      </nav>
    );
  }
  const active = activeMainTab(pathname ?? current ?? "/");
  return (
    <nav aria-label="Main" className={`${BAR} border-b border-line`}>
      {MAIN_TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === active ? "page" : undefined}
          className={`${TAB} ${t.href === active ? ACTIVE : IDLE}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
