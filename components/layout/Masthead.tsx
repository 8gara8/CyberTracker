// SPEC §7 "Page frame", Masthead: the siblings' masthead in three rows. Row 1 TabBar variant="family"; row 2
// the wordmark "Cyber Tracker" ("Cyber" in italic, Newsreader 600, 23px, 28px from md) linking `/`, the
// tagline and "Daily before 08:00 Taipei · @8gara8" (both hidden below md), the Stamp and the siblings'
// 3px double rule; row 3 TabBar variant="main". Names, times and the handle come from run.json (lib/site.ts).
// No day count and no brief number anywhere. Owner: pages lane.
import Link from "next/link";
import { Stamp } from "@/components/layout/chrome";
import { dailyLine } from "@/components/pages/site-text";
import { SIBLINGS, SITE_NAME, SITE_TAGLINE } from "@/lib/site";
import { TabBar } from "./TabBar";

/** The wordmark's two words: "Cyber" (italic) and "Tracker", from run.json site.name. */
function wordmark(name: string): [string, string] {
  const m = /^(.+?)(Tracker)$/.exec(name);
  return m ? [m[1]!, m[2]!] : [name, ""];
}

export function Masthead() {
  const [first, rest] = wordmark(SITE_NAME);
  return (
    <header className="mb-2">
      <TabBar variant="family" siblings={SIBLINGS} />
      <div className="mb-[10px] flex flex-wrap items-center gap-x-5 gap-y-2 border-b-[3px] border-double border-rule pb-[10px] md:items-baseline">
        <Link href="/" className="flex-1 whitespace-nowrap font-display text-[23px] font-semibold leading-none tracking-[-0.02em] text-fg no-underline md:flex-none md:text-[28px]">
          <span className="italic">{first}</span>{rest ? ` ${rest}` : null}
        </Link>
        <span className="hidden font-display text-[18px] text-muted md:inline">{SITE_TAGLINE}</span>
        <div className="flex items-center gap-3 md:ml-auto">
          <span className="kicker hidden whitespace-nowrap md:inline">{dailyLine()}</span>
          <Stamp text="AI-written · open sources" />
        </div>
      </div>
      <TabBar variant="main" />
    </header>
  );
}
