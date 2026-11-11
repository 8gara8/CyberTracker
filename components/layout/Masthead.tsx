// STUB (SPEC §7 "Page frame", Masthead). Owner: pages lane. Reads run.json (lib/site.ts): row 1 TabBar
// variant="family", row 2 the wordmark, tagline, "Daily before 08:00 Taipei · @8gara8" and the Stamp, row 3
// TabBar variant="main". No props.
import Link from "next/link";
import { SIBLINGS, SITE_NAME } from "@/lib/site";
import { TabBar } from "./TabBar";

export function Masthead() {
  return (
    <header className="mb-2">
      <TabBar variant="family" siblings={SIBLINGS} />
      <Link href="/" className="font-display text-[23px] font-semibold text-fg no-underline md:text-[28px]">{SITE_NAME}</Link>
      <TabBar variant="main" />
    </header>
  );
}
