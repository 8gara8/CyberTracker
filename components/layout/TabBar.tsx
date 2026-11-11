"use client";
// STUB (SPEC §7 "Page frame", TabBar). Owner: pages lane. Family: <nav aria-label="Trackers">, ME and Europe
// as plain <a> to run.json siblings, then Cyber (aria-current="true"). Main: <nav aria-label="Main"> (the
// siblings' MastheadNav, usePathname()): Today, Archive, Method, About.

export interface TabBarProps {
  variant: "family" | "main";
  /** run.json siblings; the family bar needs them. */
  siblings?: { me: string; europe: string };
}

export function TabBar({ variant }: TabBarProps) {
  return <nav aria-label={variant === "family" ? "Trackers" : "Main"} />;
}
