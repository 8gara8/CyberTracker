# CyberTracker design v0.2

2026-11-07 · JL · Replaces v0.1 · **Approved by JL on 2026-11-07**

> This is a frozen copy of the approved Claude Doc "Cyber Tracker — Design Doc v0.2"
> (https://claude.ai/artifact/3h9ZW23JKPnLmywbstVHEC). Change it only through a pull request.
> Where `SPEC.md` differs, the spec wins and lists the difference in its §0.3.
>
> **Decisions taken at approval (2026-11-07):**
> - The morning run is a cloud scheduled task at 05:47 Taipei, not a Kobol task (JL, decision card).
> - Sign-off: "yes write spec. then start the build, set PR ready for review, then wait for Codex
>   review comments to fix, don't merge, i will do that" (JL).
> - Still open, with defaults: the look (paper family; JL picks on real pages in P4), the Scoreboard
>   seed (approved once in the P5 PR), the tagline.
>
> **v0.3 (JL, decision card, 2026-11-08): built and run on Kobol, the EuropeTracker way.** JL stopped
> the build because the cloud setup needed too many manual steps. These points override the v0.2 text
> below wherever it says otherwise; the product itself does not change:
> - The morning run is a Claude desktop scheduled task on Kobol at 04:30 Taipei (it starts about 04:37
>   and stops by 05:30, before Europe's 05:30 task begins). There is no cloud task, cloud environment,
>   ops task or setup phase (P0).
> - One public repo, `8gara8/CyberTracker`, holds the code and the daily content (`content/`), like
>   EuropeTracker. Only the morning pipeline's publish step pushes to `main`, and only under `content/`.
>   Vercel rebuilds the site on every push. There is no content repo, deploy hook or ruleset.
> - Claude builds it in a Remote Control session on Kobol with JL's own GitHub login. The drafting
>   agent is sandboxed exactly as EuropeTracker's (no shell, no connectors or MCP servers, writes only
>   to `drafts/`), plus CyberTracker's block list of exploit, paste, leak and scanner sites.
> - SPEC.md v2.0 is the build spec; it is about a third of v1.0's length.

## What changed in v0.2

**v0.1 went through an independent review by eight reviewers (data feeds, metrics, editorial, visual, pipeline, accuracy and legal, the wider landscape, and scope), with a skeptic checking each finding, plus a check against how the Europe tracker really runs on Kobol.** 69 findings survived. The product idea stands: one daily question, a script-counted signature metric, an AI lens on every item, exploits before breaches, and Taiwan and Japan in view. Five things changed.

1. **The Gap is now built only from what public data can measure.** v0.1 promised three lines that no feed supplies: first-exploitation dates, AI-found counts and patching speed. The Gap now has three script-counted parts. The Flood counts new CVE records. The Window measures how fast newly public flaws land on CISA's list of exploited flaws, split into flaws already exploited when disclosed and the race after disclosure. AI-credited counts disclosures whose credit line names an AI finder, as a lower bound. Each is compared with a fixed pre-AI reference period, 2023–24, rather than with its own recent past.
2. **The first reading cuts against the thesis on speed and supports it on volume.** I joined CISA's exploited list (catalog 2026.11.06) to CVE publication dates for all 903 additions since 2023. Over the past 26 weeks, 37% of recently disclosed flaws that CISA listed were already exploited when disclosed, the same as in 2023–24 (37%). For the rest, the median wait for CISA confirmation was 17 days, against 21 in 2023–24, which is within the noise. What did move is volume: 157 such flaws were listed in 26 weeks, more than twice the 2023–24 pace, partly because CISA now lists more overall. The tracker will say this plainly. A ledger that only records support would be worthless to JL.
3. **The morning run gets its own slot.** v0.1's 06:10 start collided with the Europe run (05:30, up to 06:55). It now runs as a cloud scheduled task at 05:47 Taipei that does not depend on Kobol (JL's choice, 7 Nov).
4. **Hard rules for an unattended writer that reads attacker-written text.** A trust boundary that keeps the model away from publishing and from site code, source tiers, rules for naming victims and attackers, no exploit links, and a corrections process.
5. **A tighter page in the family look.** 5–8 items (cap 10) and about 1,100 words. The paper design shared with the ME and Europe trackers, with AI violet as the one accent and the Gap as the one dark panel. Region levels come from named rules, not item counts. A chat edition written by script, so the message JL reads matches the site.

Decisions for JL are collected in §7. The full-dark look from v0.1 is not dropped: JL will see both looks on real dry-run editions before choosing.

## 1. Product overview

**CyberTracker is a daily morning brief, on Taipei time, on the AI-era cyber threat across the US, Europe, Taiwan, Japan and the wider world.** Each morning it asks two questions. Is AI flooding defenders with flaws faster than they can fix them? Are attackers exploiting those flaws faster? It measures what public data can show: how many flaws are disclosed (the Flood), how fast newly public flaws are confirmed exploited (the Window), and how many disclosures carry an AI credit. It says plainly that whether organisations actually patch faster cannot be measured publicly from day to day.

It is not a news roundup and not a vulnerability database. It is a measured daily read on whether AI is helping attackers or defenders faster, with Taiwan and Japan in view, and it links out for everything else. For a reader in Taipei it is the first synthesis of the US working day.

### Why now

- Anthropic says partners in Project Glasswing (about 50 at launch in spring 2026, about 150 from June) reported more than 10,000 high or critical findings in the first month. This is self-reported. Its disclosure dashboard (revision 40, 2 Nov 2026) lists 37,966 candidate findings, 6,009 confirmed, 5,087 disclosed and 629 patched upstream ([Implicator](https://www.implicator.ai/anthropic-says-mythos-found-10-000-critical-software-flaws-in-a-month/)).
- OpenAI says an unreleased model produced working root exploits for 948 distinct Linux kernel flaws in one October run. This is also self-reported ([The Hacker News](https://thehackernews.com/2026/11/openai-ai-pipeline-generates-948-linux.html), 5 Nov 2026).
- Google's threat intelligence group counted monthly disclosures rising from 5,045 in January 2026 to 10,740 in August. Automated Linux kernel CVE assignment inflates that count.
- After the PHP2Shell disclosure on 21 Oct, governments in Australia, France, Finland, Denmark and the Netherlands took sites offline as a precaution ([TechCrunch](https://techcrunch.com/2026/10/21/the-internet-is-having-a-very-bad-cybersecurity-day/)). Credit for the find is shared between AI tooling, Wiz and an earlier Quarkslab audit. CISA added CVE-2026-109619 to its exploited list on 26 Oct.
- The UK NCSC published its assessment [Artificial intelligence and cyber intrusion](https://ncsc.gov.uk/report/artificial-intelligence-and-cyber-intrusion) on 3 Nov 2026. Japan's Active Cyber Defence regime began key operations on 1 Oct 2026. Taiwan's NSB counted 2.63 million intrusion attempts a day in 2025.

A tracker that simply lists breaches would drown in this. The design filters hard and measures only what it can.

### Reader

JL: a Taipei-based strategist and columnist, not a security operations analyst. JL reads the brief in the Claude app each morning, and on the site. The brief should say what matters, why, and what it says about the AI shift, with CVE detail one click down and at least one number worth quoting in a column.

### What makes it different

1. **An AI role on every item.** AI found it, AI was the weapon, AI systems were the target, AI defended, or an AI system acted on its own, with a note on who confirms the claim.
2. **The Gap as the headline, not a day count.** A sentence written by script that compares today with the pre-AI period, with the Flood and AI-credited disclosures beside it.
3. **Exploits first, breaches second.**
4. **Taiwan and Japan as vendors, not only victims.** QNAP, Synology, Zyxel, D-Link, Moxa, ASUS, DrayTek; Trend Micro, Fujitsu, NEC.
5. **A Thesis Scoreboard.** JL's predictions, restated as testable claims with pass and fail thresholds set in advance, tracked beside rival claims.
6. **A sibling of the Europe and ME trackers.** The same look, a shared tab bar, and cross-links when Russian or Iranian actors appear.

### Name and home

- **Name:** CyberTracker (chosen by JL, 7 Nov).
- **Code:** [8gara8/CyberTracker](https://github.com/8gara8/CyberTracker) (public, created 7 Nov) holds the site and the pipeline.
- **Data:** a second public repo, 8gara8/CyberTracker-content, holds only what the morning run writes. See §5, Trust boundary.
- **Site:** cybertracker.vercel.app if Vercel grants that name. Links read the address from config, so a different name costs nothing.
- **Tagline:** "The AI-era exploit and breach brief" unless JL prefers "Find vs fix: the AI-era cyber gap, every morning from Taipei".

## 2. Editorial model

**An item makes the brief only if it clears a bar of exploitation, scale or strategic meaning. Typically 5–8 items, with a hard cap of 10; a quiet day may have none.** Each item carries a kind, an AI role, its regions and, for threat items, a severity.

### What counts

| Kind | Bar | Example |
| --- | --- | --- |
| Exploited flaw | Added to CISA's exploited list (KEV), or exploitation confirmed by the vendor or a national CERT | Ivanti Connect Secure chain, Oct 2026 |
| Critical flaw | CVSS 9 or higher (the vendor's own score) or EPSS in the top 1%, in widely deployed software, and at least one of: a Taiwanese or Japanese vendor, a credible AI-discovery claim, a public exploit reported, an internet-facing product. Without vendor confirmation it is labelled as such and capped at Watch | GitLab CVSS 10.0, 21 Oct |
| Patch batch | A vendor's monthly release becomes one item: "Patch Tuesday: N fixes, n exploited" | Microsoft, 14 Oct |
| Breach or attack | Confirmed or credibly reported impact on a named victim (see naming rules below) | Ahold Delhaize outage, 12 Oct |
| Supply chain | A trusted package, vendor or certificate authority compromised | LiteLLM on PyPI, 21 Oct |
| Campaign | A new report on a state or criminal group active in a tracked region |  |
| Policy | Laws, takedowns, sanctions, government moves on AI and cyber | Japan's Active Cyber Defence, 1 Oct |
| AI capability | A measurable jump in what AI can find, exploit or defend | OpenAI's 948 exploits (self-reported) |
| Ecosystem | Whether defenders can keep up: CVE and NVD capacity, maintainer burden, bug bounty changes | NVD stops scoring most CVEs, 15 Apr |

A script picks the candidates before the model reads anything. It takes every new KEV entry, each vendor's monthly release as one bundle, CVSS 9+ flaws from about 150 widely deployed vendors, sharp EPSS rises, AI-credited CVEs and headlines from allowlisted news feeds. It ranks them and keeps at most 40; the model reads at most 15 closely. The cut list goes in the run log. Without this cap, a day like October's Patch Tuesday (about 1,400 fixes) would swamp the run.

Long-running stories (Salt Typhoon, Volt Typhoon, North Korean IT workers, Taiwan's undersea cables) live in a file with the date of their last real development. They come back only on new facts.

### The AI role

Every item gets one primary role. A second role may be stored in the data but is not shown.

- **AI-found:** an AI system found the flaw (Big Sleep, Mythos, OpenAI's pipeline, XBOW, AIxCC tools).
- **AI-weapon:** a human attacker used AI (AI-written malware, agentic intrusion, deepfake fraud, AI-scaled phishing).
- **AI-target:** AI systems were attacked (model gateways, agents, training data, AI keys, prompt injection).
- **AI-defend (new):** AI detected, patched or blocked something. Without it the brief could never record evidence that the gap is narrowing.
- **AI-actor (new):** an AI system caused the event without a human attacker directing it.
- **None:** never guessed.

Each role also carries a confidence, set by who backs the claim. **Confirmed** means a party other than the claimant backs it: the vendor's advisory, a CVE credit naming the AI system, or a victim or government statement. **Claimed** means only the AI lab or AI security vendor that benefits says so; it shows as an outlined chip reading "AI role claimed by X". **Reported** means press only.

The masthead shows "AI-linked: x of y items today" and nothing more. The share is never charted or cited as evidence, because the model picks the items and one item moves it by 10 points. Every item about Anthropic, Mythos or Glasswing carries the line "CyberTracker is written by Claude, made by Anthropic."

### Severity

Severity applies to threat items. Policy, AI-capability and ecosystem items carry none and may be flagged Landmark instead.

| Level | Meaning |
| --- | --- |
| ●●●● Critical | Exploited now in software on millions of systems, or critical infrastructure disrupted |
| ●●●○ High | Exploited in a narrower product, or a major breach with data stolen |
| ●●○○ Elevated | A critical flaw not yet exploited, or a notable campaign |
| ●○○○ Watch | Credible and relevant, but not exploited, and narrow or early |

### Regions

The US, Europe, Taiwan and Japan each get a daily level; Global shows an item count. Levels use the same pips: Baseline ●○○○, Elevated ●●○○, High ●●●○, Critical ●●●●. A script sets them from named rules in a config file, never from item counts, which would only measure how much the English-language press covered a region.

- **Critical:** confirmed disruption of government or critical infrastructure in the region, reported by at least two independent primary or newsroom sources within 72 hours.
- **High:** an emergency advisory from the region's national agency within 7 days, or a confirmed High-severity breach of a victim in the region. The agencies are CISA for the US; CERT-EU, NCSC, BSI and ANSSI for Europe; the Administration for Cyber Security, TWCERT, NSB and MJIB for Taiwan; the National Cybersecurity Office and JPCERT for Japan.
- **Elevated:** a Critical or High item whose victim is in the region, or a campaign that names the region as a target. For Taiwan and Japan only, also a KEV addition for a home vendor's flaw published within the past year, or a national CERT reporting exploitation at home.
- **Baseline:** no rule fired. The tooltip says "baseline means no rule fired, not calm".

Each row shows the rule that fired, the item behind it and the change since yesterday. The model may raise a level one step, with a visible "Editor raised:" note naming the reason. The rules are reviewed after three weeks. A home vendor's KEV addition never makes a region High on its own: since January 2025 CISA listed Taiwanese-vendor flaws on 11 different days, mostly years-old routers and cameras hit by global botnets, which says nothing about Taiwan being targeted.

China does not get its own region. Every item carries an actor nexus (PRC, Russia, North Korea, Iran, criminal or unknown), taken only from named attributions. China appears through that and through the Taiwan Lens.

### Sourcing, naming and attribution

- **Source tiers.** Tier 1 is primary: vendor advisories, CVE, KEV, GitHub, JVN and TVN records, CERTs, governments, regulators, victim statements and original research. Tier 2 is newsrooms doing their own reporting: The Record, BleepingComputer, SecurityWeek, Krebs, Reuters, AP, TechCrunch, Focus Taiwan, Taipei Times, CNA, iThome, NHK and Nikkei. Tier 3 is never cited for facts: aggregators, AI-written sites, blogs, social media, Telegram, leak sites and marketing. Every item needs a tier 1 or tier 2 source. A critical item needs two different publishers, at least one of them tier 1, and syndicated copies count once. The Hacker News cannot be the only newsroom source for a critical item.
- **Victims.** A victim is named only when the incident is confirmed (a victim statement, a regulator filing such as a US SEC 8-K, a Taiwan MOPS or Japan TDnet notice, or a CERT notice) or reported as observed fact by a tier 2 newsroom. A ransomware gang's claim never names a victim on its own; such claims appear unnamed ("a Taiwanese electronics maker, claimed by X, unverified") and only when they matter strategically. No individuals, no leak-site links, no description of stolen data.
- **Attribution.** A country or sponsor appears only with the attributor named in the same sentence ("Mandiant: China-nexus UNC… exploits…"), and never when the attributor's own confidence is low or "possible". It is never inferred from the product targeted or from past campaigns. This matters for a Taipei-based publisher under Taiwan's criminal defamation law.
- **Dangerous material.** No exploit code, payloads, Shodan queries or links to exploit repositories, paste sites or Telegram. Indicators such as domains and IP addresses are defanged and shown as plain text. Items say "Public exploit reported: yes or no" instead.

### Voice

Plain, short and factual. Every claim is sourced and disagreements are noted. Self-reported claims are written "X says" and carry a "not independently verified" chip. Every number names its denominator. A banned list catches hype words (unprecedented, game-changer, apocalypse and the like). Quotes are at most 25 words, attributed and linked; summaries are in our own words; no images or charts are copied.

## 3. Page design

**One page per morning, read in about five minutes, with the masthead, Lead and Gap readable in 60 seconds.** The target is about 1,100 words from the masthead to the end of the Taiwan Lens, with a hard cap of 1,300. The validator counts them, as in the Europe tracker.

1. **Masthead.** Taipei date, edition time, reading time, the Gap headline sentence, "AI-linked: x of y items", and a tab bar: ME · Europe · Cyber. No day count.
2. **The Lead.** At most 90 words, written last, with every sentence tied to the items it draws on. Under it, one Angle line: a sourced, dated number, the strongest counter-point, and the Scoreboard claim it bears on. This is material for JL's columns.
3. **Regions.** Four rows (code, pips, word, change since yesterday, a one-line reason that opens for more) plus the Global count.
4. **The Gap.** The only dark panel on the page; see below.
5. **Top stories.** Three full cards of at most 70 words each, including one "why it matters" sentence. Ranked by severity, with exploited flaws ahead of breaches at equal severity.
6. **Also today.** One-line rows of at most 25 words that open for detail, under four fixed heads: Exploits · Breaches and supply chain · AI frontier · Policy and actors.
7. **Actors seen today.** One line of actor chips. Russian or Iranian actors that the Europe or ME tracker covered that morning become cross-links.
8. **Taiwan Lens, with a Japan sub-block.** At most 120 words of analysis that links to items rather than repeating them. Fixed rows: attacks on Taiwan's government and infrastructure; Taiwanese and Japanese vendor flaws reported exploited, with a script line ("KEV additions for Taiwanese vendors: x in 30 days, y in 90") and the note "absence from CISA's list does not mean not exploited"; semiconductors and the defence supply chain; undersea cables and telecoms; cognitive warfare and influence operations; and the China axis (PRC operations against Taiwan, PRC counter-accusations labelled as state claims, and Chinese AI models used in attacks). Watch windows, such as Taiwan's local elections on 28 Nov, come from a data file, never from code.
9. **Thesis Scoreboard.** Shown on days with a new entry; otherwise one line naming the last entry.
10. **Elsewhere.** Up to six headlines with links and no summary.
11. **Sources,** collapsed. The page ends "That's today's brief."

On Mondays a Week in review adds the Scoreboard status table and a "Strongest evidence against" box, which reads "none found" when that is true.

### The Gap panel

Every value is computed by script from CISA's exploited list and the CVE List, with no API keys. The model never writes a number here.

**The headline** is one sentence filled in by script. With today's data it would read: "37% of recently disclosed flaws on CISA's exploited list were already being exploited when disclosed (2023–24: 37%). For the rest, CISA confirmed exploitation after a median 17 days (2023–24: 21, no clear change). 157 such flaws were listed in 26 weeks, more than twice the 2023–24 pace." A second line gives the Flood and the AI-credited count.

**Three small charts on one shared two-year time axis:**

- **A. The Flood.** Weekly new CVE records as a 13-week line, with last year's line dashed. Linux kernel records sit in their own band, because automated kernel assignment inflates the count.
- **B. The Window.** Two lines over rolling 26-week windows: the share already exploited at disclosure, and the median days to CISA confirmation for the rest. Each has an 80% band and a flat line for the 2023–24 reference. Under them, weekly bars of how many recent flaws CISA listed, so a reader can see when a change only reflects CISA listing more. Dated markers include NVD stopping most scoring (15 Apr 2026), the three-day US agency deadline for the worst listed flaws (10 Jun 2026), the July kernel batch and the Glasswing launch. The deadline is a policy marker, never drawn as a defender series.
- **C. AI-credited (the only violet series).** Weekly CVE and GitHub advisory records whose credit line names an AI finder, split by finder family (Anthropic, OpenAI, Google, others), with a total that excludes Anthropic. The last four weeks are hatched as provisional because credits are added late. Caption: "Lower bound. Credits are missing for about half of CVEs, including Microsoft, Chrome, Apple and Oracle, and most AI-found bugs never get a CVE." Beneath it: "AI-credited and now on CISA's list: k since 1 Jan 2025", with each CVE listed.

**A fix-side strip,** text only, each figure dated: Anthropic's disclosure figures (one lab, open source only, self-reported), and the share of GitHub-reviewed advisories 30–120 days old that still list no fixed version, if the data proves good enough in the build. Then a fixed caption: "Whether organisations actually patch faster is not publicly measurable day to day; annual studies are logged in the Scoreboard."

**A footer:** "data to {date} UTC · KEV catalog {version} · CVE List {release} · AI-finder list v{n}".

The headline says "faster" or "slower than 2023–24" only when the current 80% interval excludes the reference value. The panel never shows daily raw counts, arrows, log axes, monthly medians or any figure based on fewer than 30 cases.

### Other pages

- **Archive:** a list by date, as in the Europe tracker.
- **Item pages:** built for items that appear in two or more editions or in a Scoreboard entry. Each shows our own dated timeline plus links to CVE.org, CISA's list and one aggregator.
- **Methodology:** the region rules, metric definitions, AI-finder list and source tiers.
- **About:** "Written each morning by Claude (Anthropic's AI) without human review. Gap numbers are computed by scripts. Report errors here."

### When things go wrong

The brief degrades in steps: full, then partial (named feeds stale, with their values shown and dated), then data-only, then a stale banner. A data-only edition carries no editorial: the script composes new KEV entries, the Gap and the biggest EPSS movers, marks AI roles "unassessed", and keeps the day out of every AI trend.

The data-only edition is published first, about ten minutes into the run, and the full edition replaces it. Every run, including a failed one, writes a status file for each stage and feed. A page still showing yesterday's edition after 08:00 Taipei says "Not updated today. Last edition: date, time". The check runs in the browser on Taipei time, so a failed run that deploys nothing still shows the banner.

### Corrections

Each run re-checks the last 14 days of items: CVEs rejected or disputed, changes on CISA's list or in CVSS, and sources that have gone missing or changed. Claude reviews only the flagged items. A correction never silently edits an archived page. The item gets a "Corrected" banner with the date, and the correction is listed at the foot of the next brief and in the chat edition, so no alert is needed.

Readers report errors through a GitHub issue form with structured fields only (item id, type, evidence link). The model sees only the item id and the link, never free text. A dispute over a victim or an attribution removes the name automatically until the item is reviewed.

## 4. Information architecture

**The daily briefs and the daily metrics are the whole database. There is no long-lived store that the model edits.** v0.1's separate Vulnerability, Incident and Actor stores asked the model to fill fields that no feed supplies (first exploitation date, patch date, exposure), and model-edited stores are where drift and repair loops come from. Everything is JSON in the content repo, checked by Zod schemas before publish and checked again by the site at build.

### Brief (one per day)

| Field | Notes |
| --- | --- |
| date | Taipei date |
| generatedAt, publishedAt, late | Times are recorded, not enforced by the schema, so reruns and backfills still validate. The 08:00 deadline is a run rule |
| edition | full, partial or data-only |
| lead, angle | The Lead and the Angle line |
| regions | Four region rows plus the Global count, from the rules engine |
| items | 0–10 items |
| taiwanLens | Required, with a Japan sub-block |
| scoreboardEntries | New entries only |
| weekInReview | Mondays |
| corrections | Corrections listed that day |
| sources | The source list items cite by id |

### Item

| Field | Notes |
| --- | --- |
| id | A lowercase CVE id (cve-2026-104935) or a slug (inc-ahold-delhaize-2026-10) |
| kind | One of the nine kinds in §2 |
| headline | At most 90 characters |
| summary, whyItMatters | whyItMatters is one strategic sentence, required for the top three |
| severity, landmark | Severity is empty for policy, AI-capability and ecosystem items |
| aiRole, aiRoleSecondary, aiConfidence, aiEvidence | Evidence entries hold a quote of at most 25 words, a link and the kind of source (CVE record, vendor advisory, finder write-up, government, victim, press) |
| claimType | independent, self-reported or government |
| regions, topics | Topics are tags such as ot-cni, telecom, illicit-finance, influence-op and market |
| attribution | Who attributed it, the actor name they used, the sponsor they claimed, their confidence in their own words, the basis, the date and a link |
| actorNexus | PRC, Russia, North Korea, Iran, criminal or unknown, derived only from attribution |
| incident fields | Victim, sector, country, impact, and status: confirmed, reported or claimed |
| sources, firstSeen | Source ids, at least one tier 1 or tier 2; two publishers for critical items |

**The CVE block** is filled by script from the feeds and checked by the validator; the model never writes it. It holds the CVSS score with its version and scorer; EPSS with its date; CISA's decision data where present; the KEV date, due date and ransomware flag; the vendor and vendor country; the raw credit text and any AI-finder match; the discovery credit (AI on its own, AI-assisted, human or unknown, never inferred); the advisory date; a patch date only when a cited advisory says a fix exists; and the exploitation evidence, each entry dated and marked as listed by CISA, confirmed by the vendor or reported in the news. An exposure count appears only as text with a link when a public source gives one.

### Metrics (one file per day, written by script)

- **Flood:** weekly and 13-week CVE record counts, change on a year ago with and without the Linux kernel, and the count with no score.
- **Window:** the cohort size, the share already exploited at disclosure, the n-day count and median lag with their intervals, the 2023–24 reference values, the direction, old flaws newly listed (more than a year after disclosure) and KEV additions since the last edition.
- **AI-credited:** weekly and 13-week counts by finder family, and the list of AI-credited flaws now on CISA's list.
- **Fix side:** Anthropic's disclosure figures with their date and a stale flag, and the GitHub unfixed share if kept.
- **Provenance:** the data cutoff (the last complete UTC day), the KEV catalog version, the CVE List release, the AI-finder list version and feed hashes. A daily manifest lists every counted id, so any figure can be audited.

The brief may quote only numbers from this file, and the validator checks every Gap number against it.

### Scoreboard claim

Each claim has an id, its text (a testable restatement of one of JL's predictions, or a rival claim), the metric and data source it is judged on, a support threshold, a challenge threshold, a deadline, a status (open, hit, miss or void) and its latest reading with a date. Entries name their claim, and their direction follows the thresholds set in advance, not the model's reading. A lab's self-reported claim enters as neutral until something independent backs it. No probabilities unless JL stated them, and no Brier scores.

### Status and corrections

A status file per day records each stage and each feed (for example "KEV: ok; Anthropic dashboard: stale since 2 Nov; editorial: failed"). The corrections file records the date, item, type (correction, clarification, update or name removed), before, after, reason and source.

### Config files

Versioned, and changed only through normal PRs.

- **vendors.json:** about 150 widely deployed vendors with their home country. Taiwan includes QNAP, Synology, Zyxel, D-Link, Moxa, ASUS, MediaTek, Realtek, DrayTek, GeoVision and Edimax. Japan includes Trend Micro, Fujitsu, NEC, Hitachi and Mitsubishi Electric.
- **ai-finders.json:** AI finder names and match patterns, with exclusions, so that "vLLM" or "Claude Code" as the affected product never counts. Bare lab names count only beside a tool name. Any change recomputes the whole history.
- **source-tiers.json, regions.json, annotations.json, watch-windows.json.**
- **actors.json:** aliases, merged only by citing a published vendor mapping.
- **run.json:** times, URLs and paths, so that no Europe-tracker constant leaks into the code.

## 5. Sources and pipeline

**Scripts fetch, count, check and publish; the model only selects and writes.** This is the Europe tracker's principle, with a harder boundary because this run reads text written by attackers.

### Structured feeds (v1, no API keys)

| Feed | Used for |
| --- | --- |
| CISA Known Exploited Vulnerabilities (the cisagov/kev-data mirror on GitHub, with cisa.gov as fallback) | Exploited flaws and the Window |
| CVE List V5 (CVEProject on GitHub: the daily change log, plus a one-time bulk copy for the backfill) | The Flood, credits, publication dates and scores (the vendor's own score first, then CISA's) |
| FIRST EPSS (API, plus the CSV history for the backfill) | Exploit likelihood and candidate ranking |
| GitHub Advisory Database (REST, or its git export as fallback) | Open-source advisories, credits and fixed versions |
| TWCERT/CC TVN RSS | Taiwan vulnerability notes |
| JPCERT/CC alerts (jpcert.rdf) and one MyJVN call a day | Japan's urgent alerts (注意喚起) and vulnerability notes |
| Anthropic's disclosure dashboard (headline numbers, read only when its revision changes) | The fix-side strip and the AI-credit join |
| News RSS from allowlisted outlets | Candidate headlines |

Dropped from v1:

- **The NVD API as a source of counts.** NVD stopped scoring most CVEs on 15 Apr 2026 and the CVE List already has what we need. NVD stays as optional enrichment for at most 40 candidates, with no key.
- **ENISA's EUVD.** Its exploited list mostly copies CISA's dates.
- **ransomware.live.** Its leak-site claims are unverified and its terms bar raw redistribution.

EUVD and ransomware.live are reconsidered for v1.1. Every feed gets a freshness check (the newest entry is younger than N days), not just a reachability check. Terms and rate limits go in docs/SOURCES.md, and the footer credits CISA, FIRST, CVE.org and GitHub. Everything in v1 is keyless, so JL has no tokens to set up.

### News and agencies the model reads

- **Global:** The Record, BleepingComputer, SecurityWeek, Krebs, Reuters, AP and TechCrunch; CISA, NCSC UK, CERT-EU, BSI and ANSSI; Google's threat intelligence group, Microsoft, Mandiant, Unit 42 and Volexity; AI labs' security posts.
- **Taiwan:** Focus Taiwan, Taipei Times, CNA 中央社, iThome 資安, the Administration for Cyber Security 資安署, MJIB and NSB, and TWSE and TPEx material-information notices that mention cyber incidents.
- **Japan:** the National Cybersecurity Office 国家サイバー統括室 (which replaced NISC in July 2025), NPA, JPCERT, IPA, Security NEXT, NHK and Nikkei.
- **PRC state sources** (CVERC, Xinhua, Global Times) are used only when labelled as such.

Original-language titles are stored with their translations.

### Where and when it runs

**Decided (JL, 7 Nov): a cloud scheduled task at 05:47 Taipei, separate from Kobol.** Claude sets it up with no connectors and with notifications off, and it starts a fresh session each morning. It runs while Kobol sleeps, it cannot collide with the Europe run (05:30, up to 06:55) or the ME run (07:30), and each edition arrives as a session in the Claude app. 05:47 Taipei is 16:47 in Washington, after most of the US working day. It runs in its own cloud environment whose network allowlist names only the feed and news hosts the run needs.

The Kobol alternative (a third desktop task at 04:30, stopping by 05:15) was not chosen. `npm run daily` stays available as a manual fallback on any machine.

Either way:

- A data-only edition by about 05:58 and the full edition by about 06:40.
- One retry inside the run, only if it can start before 06:50.
- A hard stop at 07:40, and nothing published after 11:00.
- Budgets: at most 35 minutes of agent time, 40 page fetches and 2 repair rounds.
- The edition date is computed in Taipei time explicitly, because cloud machines run on UTC.
- CyberTracker never creates, edits or reschedules the Europe or ME tasks.
- P0 proves that the chosen place can reach every feed. During this review, the cloud sandbox reached GitHub's git mirrors but was refused by Anthropic's dashboard and GitHub's advisory API, so this is a real check.

### Trust boundary

Every morning the run reads text written by strangers: advisories anyone can submit, exploit READMEs, attacker posts. Some of it will contain instructions aimed at AI agents. The run is therefore split into four steps.

1. **Collect** is a script with no model. It strips HTML, invisible and direction-control characters, flattens links, cuts every string to 1,000 characters and wraps it as untrusted.
2. **Draft** is the model, writing only draft files. Where the platform allows, it runs as a restricted sub-agent with no shell, git or connectors, as in the Europe tracker. It never clones, installs or runs exploit code, and never opens leak sites, .onion addresses, paste sites, Telegram or link shorteners.
3. **Validate** is a script, with at most two repair rounds.
4. **Publish** is a script that pushes only to the content repo.

The run has no write access to the code repo; it fetches the code read-only. The site is built from the code repo, pulls the content repo, re-checks every file with its own schemas, skips any invalid file and keeps the last good one. Model text is rendered as plain text only, under a strict content security policy. This keeps model-written bytes away from deployable code. It also avoids opening a pull request every morning, which would notify JL daily. P0 tests this from a real run: pushing to the code repo must fail. A test page with a planted instruction checks in CI that the draft never follows it.

### Validator

Hard rules:

- **Schema,** plus sequential ids with no gaps or duplicates.
- **Every cited link was seen.** It came from the source pack or from the agent's own searches and fetches. No live link checks, as in the Europe tracker.
- **Source tiers** as in §2.
- **Every CVE id exists** and is published in that day's CVE List.
- **Vendor confirmation** for critical-flaw items.
- **The Lead uses only names and numbers** that appear in items or metrics.
- **Every Gap number matches** the metrics file.
- **Victim and attribution wording** follow the rules in §2.
- **No live indicators or exploit links.**
- **Limits:** quote length, word budgets, banned words, and a Taiwan Lens that is not empty.

Soft rules, with one repair pass: numbers and names in headlines and the Lead are compared with snapshots of the cited pages. The snapshots stay inside the run; only each page's link and hash are kept. After publishing, a background check flags dead links in the next run log, and it never blocks.

### Chat edition

A script renders the chat message from the validated JSON, following the Europe tracker's summary pattern, and the model never rewrites it. That keeps the message JL reads in the Claude app identical to the site. At most 15 lines, no tables, no emoji:

1. The title and publish time.
2. The Gap headline.
3. The Flood and AI-credited figures on one line.
4. The Lead.
5. The top three, one line each, with pips, AI role, regions and a link.
6. Taiwan in one sentence.
7. The regions.
8. "Also today (n)" with a link to the full brief.
9. A run line, for example "Run 05:47–06:41 · data-only 05:58 · 1 attempt · 24 sources · data to 7 Nov UTC".

Failed, skipped and data-only versions follow the Europe tracker's wording and say which edition the site still shows.

### Time base

Every series is counted by its source's own event date in UTC; CISA's listing date is a US date and is labelled as one. Weeks are ISO weeks, and rolling windows end at the last complete UTC day. A retry reuses the stored cutoff, so the numbers do not move. Backfilled points are flagged "reconstructed from current records".

## 6. Visual design

**The paper look shared by the ME and Europe trackers, with AI violet as CyberTracker's single accent and the Gap as the one dark "night desk" panel.** The Europe tracker started with a look of its own and was redesigned after JL's first preview. A sibling that looks like a sibling avoids that rework, and the dark panel keeps v0.1's night-desk idea as a signature rather than the whole theme. The full-dark theme from v0.1 will be rendered on the same dry-run editions in P4, and JL chooses there.

### Layout

- **Designed for a 375px phone first:** one reading column, about 720px at most, at every width.
- **From 1200px,** only a right rail for footnotes and metric notes, never a second column of items.
- **No carousel and no tap-to-filter.** A region row links to the item behind it.
- **One card anatomy for every kind.** A kicker row in mono capitals (pips and word · AI chip · region codes). A headline of at most 90 characters. One serif "why it matters" sentence. For flaws, a one-line timeline ("CVE published 2 Nov → on CISA's list +1 day → US deadline 5 Nov · patch: 3 Nov \[source\]"). A footer: "sources \[n\] · details".
- **Vendor country as text,** such as "QNAP (TW)", never a flag.
- **Analyst detail sits under "details":** CVSS with its scorer, EPSS, CISA's decision data, credits, attribution and exploitation evidence. Incident cards lead with impact.

### Typography

| Role | Font | Size |
| --- | --- | --- |
| Masthead and section titles | Newsreader | As the Europe tracker's scale |
| Lead and summaries | Newsreader 400 | 17–18px, line height 1.55, at most 72 characters a line |
| Interface and labels | IBM Plex Sans | 14px |
| CVE ids, numbers, kickers | IBM Plex Mono, tabular figures | 13px |

Chinese and Japanese names are tagged with their language and get PingFang TC, Noto Sans TC, Hiragino Sans and Noto Sans JP in the font stacks. v0.1's Inter Tight, Inter, Source Serif 4 and JetBrains Mono are dropped.

### Colour

| Token | Value | Use |
| --- | --- | --- |
| Paper | #f3eee3 · deep #eae2d0 · card #fbf8f0 | Shared with the siblings |
| Ink | #14161a · soft #3b3e45 · mute #6b6a62 · rule #c9bfa8 | Text and rules |
| Red, amber, green | #b33a2e · #c48416 · #3e6b3a | Shared accents |
| AI violet (paper) | #6D28D9 | AI chips and the AI series only; 6.1:1 contrast on paper |
| AI violet (dark panel) | #A78BFA | The AI series inside the Gap panel |
| Dark panel | bg #0B0F14 · surface #121821 · border #1F2A37 · text #E6EDF3 · muted #8B98A5 | The Gap panel only |

Square corners. Each section opens with a 1px rule, §NN and a mono capital kicker, as in the siblings.

Severity is shown by chip treatment, not by hue alone. Critical is a filled ink chip, High a filled tinted chip, Elevated an outline chip, and Watch and Baseline grey text. Every level always shows its pips and its word. There is no blue in the severity or region scales: in v0.1, the watch blue and the AI violet looked identical to colour-blind readers. Focus outlines are 2px ink at 3:1 contrast or better. A colour-check script runs on both token sets in CI.

### Glyph grammar

The same symbols on the site, in the chat edition and in alt text, so the chat message loses nothing that matters.

- **Severity:** ●●●● CRITICAL · ●●●○ HIGH · ●●○○ ELEVATED · ●○○○ WATCH. Regions use the same pips, with BASELINE as the floor.
- **AI role:** word chips (AI-found, AI-weapon, AI-target, AI-defend, AI-actor), outlined when only claimed.
- **Regions:** US · EU · TW · JP · GLOBAL.
- **Change:** ↑ ↓ =.

### Charts

As in the Europe tracker: SVG on a 400-unit-wide canvas capped at 560px, a title on every mark, and the data as a table under "details". Lines are labelled directly, without legends where possible. On a phone the three Gap charts stack at about 72px each.

### Key components

Masthead with tab bar · RegionRow · GapPanel (three small charts and the fix-side strip) · ItemCard · ItemRow · AIChip · SeverityPips · ActorChips · TaiwanLens · ScoreboardTable · StaleBanner.

## 7. Rationale, decisions and build plan

**The design measures only what public data supports, records evidence both ways, and keeps the model away from numbers, publishing and site code.**

### Key decisions

| Decision | Why |
| --- | --- |
| The Gap compares today with 2023–24, not with its own recent past | A baseline that sits entirely inside the AI era cannot show whether the AI era changed anything |
| The Window is split into "exploited at disclosure" and the race after it | About two thirds of the flaws CISA lists within a week were already exploited when disclosed. JL's thesis is about the race after disclosure, so that has to be visible on its own |
| AI-credited is a lower bound, split by finder | No feed records AI discovery. Anthropic accounts for over half of the matches, and a brief written by Claude has to show that |
| Region levels come from named rules | Item counts measure press attention, not threat |
| 5–8 items and about 1,100 words | v0.1's 8–15 items ran to about 1,500 words on a busy day |
| The run gets its own slot, away from the Europe and ME runs | The desktop app skips a task while another one is running |
| A separate content repo | The run acts under JL's GitHub account, so only a separate repo keeps it away from site code. It also avoids a daily pull request notifying JL |
| The pipeline is forked from the Europe tracker at a recorded commit | The Europe pipeline already carries fixes for eight ME tracker failures. A check in P0 keeps Europe-only constants out, the same class of bug as the ME tracker's day count |
| The same stack as the Europe tracker | Next.js, TypeScript, Zod, Vitest and Vercel. No shared package until the same fix has had to be made by hand in all three repos twice |

### Decisions for JL

- [ ] **Scoreboard seed:** Claude drafts 4–6 testable versions of JL's published predictions, plus two rival claims (the NCSC's judgement that AI-powered malware is highly likely to hit UK critical infrastructure by 2028, and a base-rate claim that AI-found flaws get exploited no more often than others). JL approves them once, in the go-live PR. Is there one prediction JL most wants tracked?
- [ ] **Look:** the paper family (recommended) or full dark, chosen on real pages in P4.
- [ ] **Tagline:** keep the current one, or "Find vs fix: the AI-era cyber gap, every morning from Taipei".

Already settled: the name CyberTracker and a public repo (JL, 7 Nov); the morning run as a cloud scheduled task at 05:47 Taipei (JL, 7 Nov); no separate China region (actor nexus instead).

### Build phases

Each phase is one pull request: Claude writes it, Codex reviews it, Claude fixes it, and JL merges it. SPEC.md comes first, written from this doc once JL signs it off. Target dates depend on review turnaround.

1. **P0, repo and fork.** Fork the Europe pipeline at a recorded commit and move every Europe constant into config. Create the content repo and protect main. Add skeleton config files and keep raw feed data out of git. Probe every feed from the chosen run location and prove the run cannot push code. Done when CI is green, a search finds no Europe strings, and the reachability and push-denial reports are committed.
2. **P1, data contract, validator and chat renderer.** Done when every rule has a passing and a failing test case, all four chat formats have snapshot tests, and the planted-instruction test is in place.
3. **P2, feeds, metrics and the two-year backfill,** plus the 2023–24 reference. Done when every Gap series covers 104 weeks and the reference, reruns give identical output, and the figures above (37% at disclosure, 17 against 21 days) reproduce.
4. **P3, the morning pipeline and timed dry runs** on two past days: 14 Oct (Patch Tuesday) and 22 Oct. Done when each validates within two repair rounds, stays inside 35 minutes of agent time, 10 items and 1,300 words, and a forced failure still leaves a data-only edition and shows the stale banner.
5. **P4, the site, built on the dry-run output,** with the paper and dark looks side by side. Done when phone and desktop screenshots are in the PR, the accessibility checks pass, and JL has picked the look.
6. **P5, supervised go-live: three mornings,** ideally including Wednesday 11 Nov's Patch Tuesday edition (otherwise 9 Dec). Each must publish before 07:30, with Gap numbers matching the metrics file and the chat edition matching the site. This PR also carries the Scoreboard seed and the election watch window. Then the run goes unattended.
7. **P6, calibration.** A design pass after seven or more editions (around 18 Nov). After three weeks (around 2 Dec), a review of the region rules, the AI-finder list and run times, and a decision on v1.1 candidates: EUVD's exploited flaws missing from CISA's list, ransomware.live totals, and Shadowserver exposure data.

### Considered and rejected

- **Anthropic's disclosure backlog as the headline:** one lab, self-reported, and self-serving in a brief written by Claude. It stays as a labelled fix-side figure.
- **A year-on-year headline:** the intervals overlap, and the year-ago window falls on a trough.
- **Median days to CISA listing as the headline:** the distribution has two humps and swings widely. The median stays in the data table.
- **A pull request per edition:** it would notify JL every morning.
- **A hard-coded election section:** the same class of bug as the ME tracker's day count. A watch-window file does the job.
- **Probabilities or Brier scores on JL's claims:** they would put words in JL's mouth. Hit or miss against thresholds set in advance is enough.

## Sources

As of 7 Nov 2026. The Window figures were computed on 7 Nov from CISA's catalog version 2026.11.06, joined to CVE List V5 publication dates for all 903 additions since 1 Jan 2023. The independent review reproduced them separately.

- [CISA Known Exploited Vulnerabilities catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) and its [GitHub mirror](https://github.com/cisagov/kev-data)
- [CVE List V5](https://github.com/CVEProject/cvelistV5)
- [FIRST EPSS](https://www.first.org/epss/)
- [Implicator: Mythos found 10,000 critical flaws in a month](https://www.implicator.ai/anthropic-says-mythos-found-10-000-critical-software-flaws-in-a-month/)
- [The Hacker News: OpenAI pipeline, 948 Linux root exploits](https://thehackernews.com/2026/11/openai-ai-pipeline-generates-948-linux.html)
- [TechCrunch: a very bad cybersecurity day, 21 Oct 2026](https://techcrunch.com/2026/10/21/the-internet-is-having-a-very-bad-cybersecurity-day/)
- [NCSC UK: Artificial intelligence and cyber intrusion, 3 Nov 2026](https://ncsc.gov.uk/report/artificial-intelligence-and-cyber-intrusion)
- [The Star: Japan's active cyber defence laws in force, 1 Oct 2026](https://www.thestar.com.my/aseanplus/aseanplus-news/2026/10/01/preemptive-cybersecurity-laws-enforced-in-japan-amid-rising-threats)
- [Global Taiwan Institute: China's cyberattacks and Taiwan's security](https://globaltaiwan.org/2026/08/chinas-cyberattacks-taiwans-national-security/)
