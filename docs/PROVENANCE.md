# Provenance

CyberTracker is forked from **8gara8/EuropeTracker at `2232913cb40bb9d6fe29cbf585dadbc658c89570`**
(`main` on 2026-11-07, "Merge pull request #8 from 8gara8/phase-5-go-live"; the SPEC header). Nothing was
merged from Git history: files were copied by hand into a fresh repo and changed as below.

Verdicts:

- **copied**: the same code, with only comments, names and imports changed;
- **adapted**: the same job, rewritten where CyberTracker differs (the "What changed" column);
- **later**: not copied in the Foundation PR; the phase named in SPEC §8's table or §10 adapts it, and
  that phase's PR changes the verdict here;
- **dropped**: not carried over (SPEC §2 "Dropped from EuropeTracker" says why).

Every carried file names its Europe source in its header comment.

## Scaffolding

| Europe file | Verdict | What changed |
|---|---|---|
| `package.json` | adapted | Name `cybertracker`; the same packages and exact pins (SPEC §2); only the Foundation scripts (`typecheck`, `test`, `check`, `agent:check`); `engines.node >=22`. Each phase adds its scripts (SPEC §8.1); P3 adds `postinstall`, `context`, `daily`, `publish`, `recheck` and `links`; P4 adds `dev`, `dev:sample`, `build`, `build:sample`, `build:empty`, `start` and `color:check`, and `check`'s last three steps, with no new package |
| `package-lock.json` | adapted | Europe's lockfile with the name changed, because `npm install` on this machine fails inside npm itself (`edgesOut` of null); `npm ci` installs it cleanly |
| `tsconfig.json`, `postcss.config.mjs` | copied | |
| `vitest.config.ts` | adapted | P2 adds `setupFiles: ["tests/setup/offline.ts"]`, the offline guard for every test file (SPEC §8.1) |
| `next.config.ts` | adapted (P4) | `poweredByHeader: false` and the header comment kept; P4 adds the CSP and the five headers for every route, exported as `contentSecurityPolicy(env)` and `securityHeaders(env)` so the tests read both modes (SPEC §7 "Security headers") |
| `.gitignore` | adapted | Exactly SPEC §3 |
| `.github/workflows/ci.yml` | adapted | One job running `npm run check` on Node 24; pushes to `main` that change only `content/` skip it (SPEC §9.2) |
| `README.md`, `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `docs/DESIGN.md` | replaced | Written for CyberTracker in PR 1 |
| `docs/RUNBOOK.md` | adapted (P3) | Europe's sections kept (the morning, the scheduled task, what each file tells you, error codes, manual runs, the CLI and its token, things not to do), rewritten for CyberTracker's times, paths, codes and commands; added: how to read each place of SPEC §9.8, the lock, needs-review, git recovery and the P3 deploy note |
| `docs/SEED-REPORT.md`, `research/**` | dropped | The Gap history is computed from feeds in P2; the source registry is `config/sources.yaml` |

## Libraries (`lib/`)

| Europe file | Verdict | What changed |
|---|---|---|
| `lib/dates.ts` | adapted | Kept `isValidDate`, `taipeiToday`, `taipeiDateOf`, `taipeiTime`, `addDays`, `daysBetween`, `isMonday`, `inRange`. Added `taipeiTimestamp`, `at`, `utcDateOf`, `weekday`, `dataCutoffFor`, `windowEnding`, `isoWeekStart`, `lastSunday`, `newestCompleteWeek` (SPEC §5.1). Dropped the Kyiv helper, the 05:30 window and the month list |
| `lib/text.ts` | copied | `countWords()` unchanged |
| `lib/urls.ts` | adapted | Kept `stripArchivePrefix`, `normalizeUrl` (Telegram folding removed) and `isHttpsUrl`. Added `hostOf`, `hostMatches`, `extractUrls`, `defang` and `blockedEntry` (SPEC §4.12). Dropped `isGoogleNewsUrl` |
| `lib/vocab.ts` | replaced | The Foundation holds only `BLOCKED_HOSTS` (Appendix B.3) and the canary; P1 adds CyberTracker's vocabularies |
| `lib/collect.ts` | adapted (P2) | Kept the job and the shape: `inWindow()` (now with the lookback), `keywordHits()`, the item score (`packScore()`, +4 for tier 1 publishers), `dedupe()` (`jaccard()` moved to `lib/text.ts`, with character bigrams for Han and Kana), `capItems()` (SPEC §4.14's caps), `toPackItems()` and `renderPackMd()` (every line fitted within 1,000 characters). New: the record window, the zip plan, the pack records of every structured feed, the record cap and renumbering, feed states, the degraded rule and the stdout summary (SPEC §4.14, §8.3). The RSS harness moved to `lib/feeds/rss.ts`; Telegram, Google News, `classifyDomain()`, `stripOutletSuffix()` and `USER_AGENT` (now `run.json`) are dropped |
| `lib/collect.ts` (its RSS half) | adapted (P2) | Became `lib/feeds/rss.ts`: `rssParser()`, `feedDate()`, `zoneOf()` and `rssItems()`, without Google News `<source>` handling; reads the RDF channel's `dc:date` and Atom's `<updated>`, dates in "YYYY-MM-DD HH:mm(:ss)" form and named zones (CEST, CET and others), and a body whatever its content type; adds the TWCERT and JPCERT note readers |
| `lib/context.ts` | adapted (P3) | The pattern only: `buildContext()` builds CyberTracker's `AgentContext` (SPEC §4.15) in memory, with the 250 KB trim and `regionsBaseFor()`; the quotable-metrics logic is `quotableRows()` in `lib/metrics/headline.ts` (first written in `fixtures/src/inputs.ts`), not Europe's |
| `lib/validate.ts`, `lib/rules/types.ts`, `lib/rules/words.ts`, `lib/rules/sources.ts`, `lib/schema/common.ts`, `lib/json-schema.ts` | later (P1) | The validator's frame and the generic rules; every rule is rewritten for items, metrics and the Gap |
| `lib/apply.ts` | adapted (P1, P3) | `dropUnverified()` in P1; in P3 `applyDraft()`, `releaseBlockOf()` and the Scoreboard step, ported from CyberTracker's own `fixtures/src/site.ts`, not from Europe |
| `lib/content.ts` | adapted (P4) | Kept: `readJson()` (never throws) and Europe's `readFolder()` as `listJson()`, which lists a folder's `.json` names sorted by name (a missing folder is `[]`), a cache per directory and `{ fresh }`. New: CyberTracker's file set, the re-check of every file through `validateAll(dir, { perFile: true })` and its skip rules, the corrections safety check, `warnings`, `gapFailed`, `loadMetrics()` and `contentLogLines()` (SPEC §6 "Content loading") |
| `lib/site.ts` | adapted (P1, P4) | `siteUrl()`, `contentDir()` and `isSampleData()` kept, with names and URLs read from `config/run.json` in place of constants (P1, with `issueFormUrl()`); P4 adds `SITE_REPO`, `SIBLINGS`, `STALE_AFTER` and `THEME_COLOR` (paper's `#f3eee3`; the `siteLook()` and `themeColor()` of the two-look build went with JL's pick of paper, SPEC §0.4 row 174) |
| `lib/site-data.ts` | adapted (P4) | `indexBy()` and `neighbours()` kept; `archiveMap()` and `asOfDate()` dropped; added `itemPageIds()`, `itemHistory()`, `correctionsFor()`, `heldItemIds()` and `heldCorrection()` |
| `lib/format.ts` | adapted (P1, P4) | `longDate()`, `shortDate()` and `dayMonth()` in P1; P4 carries Europe's `rfc822()` for the feed, now throwing on an invalid timestamp. Europe's month, window, probability, pathway, country, category, incident-type and metric labels and `paragraphs()` are dropped |
| `lib/markdown.ts` | copied (P4) | `parseInline()`, `parseBlocks()` and `section()` for the STYLE.md subset; only `app/methodology/page.tsx` imports it (SPEC §7 "Untrusted text" item 1) |
| `lib/aggregate.ts`, `lib/probability.ts`, `lib/rules/{board,developments,forecasts,indicators,meta,records}.ts`, `lib/schema/{brief,context,draft-brief,forecast,incident,index,misc,pack,state,strike}.ts` | dropped | Europe's domain (incidents, strikes, state, indicators, forecasts, the board, probability terms) |

## Scripts

| Europe file | Verdict | What changed |
|---|---|---|
| `scripts/lib/log.ts` | copied | |
| `scripts/lib/lock.ts` | adapted | The lock appears atomically through a hard link, so a lost race returns the holder instead of throwing (PR 2 review) |
| `scripts/lib/run.ts` | adapted | An `onLine` hook (returning `"stop"` kills the child) and a `stopped` flag, for the sandbox guard (SPEC §8.12); in P2 a 1,000,000-byte stdout limit by default, a per-call `maxStdoutBytes`, a `stdoutCut` flag and one decode of the kept bytes (SPEC §8.3) |
| `scripts/lib/git.ts` | adapted | `syncMain(g, layout)` takes the allowed paths, refuses a dirty tree (untracked files included), fast-forwards, and rebases without `--autostash` only when local commits stay inside the layout (P3); `onOriginMain` replaces `onOrigin`; `ensureIdentity` sets a commit identity only when none is configured (SPEC §8.7); in P2 `git()` keeps 64 MiB of stdout and throws `GitOutputCut` when output is cut (SPEC §8.3) |
| `scripts/lib/transcript.ts` | adapted | More fields (tools, MCP servers, permission mode, calls with results, denials, usage, terminal reason, limits, safety stops) and `scrubModels()` (SPEC §8.12) |
| `scripts/lib/agent.ts` | adapted (P3) | Kept from Europe: `AGENT_TOOLS`, the settings constants, `agentArgs()`, `sandboxViolations()` and `runAgent()`'s wiring; `--restricted`, `--safe-mode`, no model flag, the isolated config dir. New in P3: the fixed environment with the keychain token (SPEC §9.4), `agentConfig()`, `cliVersion()`, the init guard, `renderTemplate()` (checks the template first), `promptVars()`, `repairVars()` and `fetchBudgetLeft()` |
| `scripts/agent-check.ts` | adapted (P3) | Kept: `ask()`, the negative-test helpers and the smoke and sandbox layout. Rewritten: the deps, exit codes (2 on a usage error too), the smoke line, the canary with its own files and evidence, and the removal of the cloud-only `--find-passthrough`, `--network` and passthrough list (SPEC §8.12) |
| `scripts/publish.ts` | adapted (P3) | Kept: the shape of the push loop (retries after 2, 4 and 8 s, revalidation, the stop errors) and `PublishError`. New: the edition, status, withhold and state calls, the dry-run copy, `dropPendingEditions()`, `pushPending()` and the CLI (SPEC §8.7) |
| `scripts/daily.ts` | adapted (P3) | The overall shape only; the stages, the data-only edition first, the run records, the retry, the watchdog and finish are CyberTracker's (SPEC §8.2) |
| `scripts/daily.ts` (`waitLive()`) | adapted (P3) | Became `scripts/lib/deploy.ts` `waitForEdition()`: the polling loop kept, reading the `ct-edition` meta tag with a 15 s cut per GET |
| `scripts/daily.ts` (`cleanup()`) | adapted (P3) | Became `scripts/lib/prune.ts` `pruneRunFiles()`: best-effort pruning kept, now by the date in each name, never file times |
| `scripts/preflight.ts` | adapted (P3) | Kept: the HEAD probe of github.com and the `ls-remote` push-path probe. Rewritten around `PreflightFail`: arm64 and Node, the lock, config and clock, the restore and sync, the idempotency rules, the CLI and token (SPEC §8.2) |
| `scripts/collect.ts` | adapted (P2) | Rewritten around SPEC §8.3: one commit per repo through `GitSource`, the delta zips, per-id records, phase A and B pools, ranking, the record cap and the cache files (`cache/feeds/index.json`, `inputs.json`). Kept from Europe: the feed pool of 8, `readFeed()`'s role and `--check-feeds`, which becomes `sources:check` (SPEC §8.10). Its header comment names the Europe source |
| `scripts/build-context.ts` | adapted (P3) | The CLI's role only: writes what `buildContext()` builds in memory for manual and dry runs (SPEC §8.5) |
| `scripts/validate.ts`, `scripts/gen-json-schema.ts` | later (P1) | |
| `scripts/lib/summary.ts` | later (P1) | Becomes `lib/chat.ts` and `scripts/chat.ts` (four formats; `changes()` dropped) |
| `scripts/lib/keychain.ts` | adapted (P3) | Kept: `execFileSync` of `/usr/bin/security find-generic-password -s <service> -w`, null on failure. New: the binary and timeout injectable for tests, an empty token counts as missing; service `cybertracker-claude-oauth` (SPEC §9.6) |
| `scripts/daily.sh` | adapted (P3) | Kept: the fixed PATH, `TZ`, `mkdir -p logs` and `exec` under `caffeinate -i`. Changed: it is SPEC §8.2's block byte for byte, running the checkout that holds it (`${0:A:h:h}`) where Europe's changes to a fixed path |
| `scripts/archive-urls.ts`, `scripts/promote.ts`, `scripts/score-forecasts.ts`, `scripts/seed-build.ts` | dropped | SPEC §2 |
| none | new in Foundation | `lib/feeds/http.ts` (`fetchFeed()`, SPEC §8.3) |

## Routine, fixtures and tests

| Europe file | Verdict | What changed |
|---|---|---|
| `routine/agent-settings.json` | adapted | SPEC §9.5: the fixed denies, then both WebFetch domain forms of every `BLOCKED_HOSTS` host entry in order, then `*.onion` and `*.i2p`; hooks off |
| `routine/STYLE.md`, `routine/schema/draft-brief.schema.json` | later (P1) | Rewritten for CyberTracker |
| `routine/PROMPT.md` | adapted (P3) | Europe's section order and its "read in this order" framing; every section rewritten for CyberTracker (SPEC §11) |
| `routine/REPAIR.md` | adapted (P3) | Europe's shape, a short instruction with the findings in a fenced block; the text is CyberTracker's |
| `routine/TASK.md` | replaced (P3) | SPEC §11's block copied exactly, not taken from Europe |
| `fixtures/agent/transcript-auth-failed.jsonl` | copied | Its model value replaced by `<model>`. The current CLI could not be made to fail sign-in (it signs in even with an empty passthrough), so the shape is Europe's (found while building v1.0's P0) |
| `fixtures/agent/fake-claude.mjs` | adapted (P3) | Kept: its config file in `CLAUDE_CONFIG_DIR`, the stream-json shapes, the draft path read from the prompt, and the `auth` mode's "Not logged in · Please run /login". New: the `mcp`, `limit` and `repair` modes, `resumeMode`, `attemptModes` and the `repairs` list (a draft per `--resume` call), `calls.jsonl`, `--version`, reported fetches and searches, `touch`, `draftPath`, and the OK or DONE reply |
| none | new in Foundation | `fixtures/agent/transcript-ok.jsonl` (a real transcript from `agent:check`, first on CLI 2.1.319, re-recorded on Kobol on the pinned CLI 2.1.316 on 2026-11-11, model values replaced), `fixtures/injection/` (the planted page and RSS item; the pre-P3 canary prompt was removed in P3, unused) |
| `fixtures/src/**`, `fixtures/empty-content/**` | adapted (P1) | The fixture builder's pattern; every fixture is CyberTracker's own. P4 reads `fixtures/site-content/` and `fixtures/empty-content/` as P1 and P3 wrote them |
| `fixtures/briefs/**`, `fixtures/collect/**`, `fixtures/context/**`, `fixtures/evidence/**`, `fixtures/site-content/**` | dropped | Europe's data; CyberTracker builds its own (P1, P2) |
| `tests/lib.test.ts` | adapted | CyberTracker's dates (cutoff, windows, ISO weeks, the two CVE timestamps without a zone), URLs, defang and the blocked list |
| `tests/collect.test.ts` | adapted (P2) | Rewritten for CyberTracker's collect: the pure helpers, then `scripts/collect.ts` end to end on `fixtures/feeds/` under `CT_FIXTURE_FEEDS`, and the exit codes |
| `tests/daily.test.ts` | adapted (P3) | Europe's end-to-end harness became `tests/helpers/harness.ts`: a bare remote with a `#!/bin/sh` pre-receive hook, and the fake agent behind a `#!/bin/sh` wrapper that execs `process.execPath`. The cases D1 to D47 and DS1 are CyberTracker's (SPEC §8.2) |
| `tests/fixtures.test.ts`, `tests/validate.test.ts` | later | Rewritten in the phase that adds their code |
| `tests/site.test.tsx` | adapted (P4) | Europe's harness kept: Vitest in the node environment, `renderToStaticMarkup()`, the sample from `fixtures/site-content/` loaded fresh. Every case is CyberTracker's, one `describe` per SPEC §7 "Site tests" bullet plus the routes; Skipping moved to `tests/content.test.ts` and Stale to `tests/stale.test.ts` |
| `tests/aggregate.test.ts`, `tests/pipeline.test.ts`, `tests/seed.test.ts` | dropped | Europe's domain |
| none | new in Foundation | `tests/no-europe-strings.test.ts`, `tests/agent.test.ts`, `tests/transcript.test.ts`, `tests/lock.test.ts` |

## New in P2 (no Europe source)

| Files | What they are |
|---|---|
| `lib/feeds/{anthropic-cvd,cache,cvelist,epss,exchange,ghsa,github,kev,myjvn,nvd,types,zip}.ts` | One parser per structured feed, the cache layout, the GitHub refs and asset names, and a zip reader with no new package (SPEC §8.3). `lib/feeds/http.ts` (Foundation) gains `pool()`, `fetchBudget()`, `truncate` and the deadline |
| `lib/rank.ts`, `lib/ids.ts`, `lib/json.ts` | Candidate ranking (SPEC §5.12); id ordering; `jsonText()` and `sha256Hex()` |
| `lib/metrics/{ai-credit,fix-side,flood,index,kev-index,notes,series}.ts`, `lib/schema/reference.ts` | The metrics (SPEC §5) and the reference fixtures' schemas; `lib/metrics/window.ts` gains `joinKev` and `windowStats` |
| `scripts/metrics.ts`, `scripts/backfill.ts`, `scripts/lib/{appendix-d,cve-read-worker,cvelist-clone,feed-cache,feeds,git-source,kev-source}.ts` | The metrics run, the backfill, Appendix D, the clone and its worker threads, the collect cache reader, the feed readers, the git runner and the KEV source (SPEC §5.9, §8.4) |
| `fixtures/src/{feeds,state,scrub-feed,zip-writer}.ts`, `fixtures/src/kev-extra.json`, `fixtures/src/tools/cvelist-clone.ts` | The feed fixtures, `fixtures/state/`, the capture scrubber, a zip writer and the one-time trimming tool for `fixtures/cvelist-clone/` |
| `fixtures/feeds/**`, `fixtures/state/**`, `fixtures/reference/**`, `fixtures/cvelist-clone/**`, `fixtures/ai-credit/records/**` | CyberTracker's own data: real formats with invented prose, trimmed real CVE records with people's names replaced by "SAMPLE Researcher", and the reference counts (SPEC §3) |
| `docs/SOURCES.md` | Each source's terms, attribution lines and limits, as P2 session 1 read them on Kobol (SPEC §10 P2 item 3) |
| `tests/setup/offline.ts` and the P2 tests (`ai-credit`, `backfill`, `captures`, `collect`, `compute-metrics`, `contract`, `feed-readers`, `feeds`, `fix-side`, `fixture-safety`, `fixtures-state`, `flood`, `http`, `metrics-script`, `no-network`, `rank`, `reference`, `registry`, `run`, `series`, `shared`, `sources-check`), `tests/helpers/` | Vitest; no test touches the network (SPEC §8.1) |

## New in P3 (no Europe source)

| Files | What they are |
|---|---|
| `lib/data-only.ts`, `lib/withhold.ts`, `lib/withhold-mask.ts` | The data-only edition and the dispute withholds, ported from CyberTracker's own `fixtures/src/site.ts` (SPEC §4.5, §4.10); `withhold-mask.ts` holds the rewrite both share, the masking of later editions, the same-day withhold's id adoption, re-report replacement and carry-over, and the list of sources only withheld items cite that XREF_CORRECTION checks (SPEC §0.4 rows 95, 121, 124, 127 and 130) |
| `lib/html-text.ts`, `lib/run-inputs.ts` | One page-text extraction for snapshots and the link check; the reads the P3 stages share |
| `scripts/recheck.ts` | Dispute intake, the 14-day re-check and the link check (SPEC §8.9, §8.11) |
| `scripts/lib/{clock,cve-facts,cve-fetch,evidence,paths,run-lines,snapshot,status,validate-loop}.ts` | The run clock and `realDeadline()`, CVE facts and fetches for publish and the validator, the evidence, every run path, the run log's fixed lines, page snapshots, run records and stage notes, and the validate loop (`evidence.ts` replaces Europe's `evidenceUrls()`) |
| `fixtures/agent/drafts/`, `fixtures/agent/transcript-limit.jsonl`, `fixtures/feeds/pages/`, `fixtures/recheck/`, `fixtures/injection/{context,evidence-base,metrics,pack}.json`, `fixtures/injection/pack.md`, `fixtures/agent/cli-help-2.1.316.txt` | The pipeline draft for 2026-10-14 and its two variants, a usage-limit transcript, the 19 sample pages it cites, the re-check's dispute issues and record pairs, the canary's inputs (SPEC §0.4 rows 74, 92, 94 and 109), and the Options section of the pinned CLI's `--help` with its model flags cut, which test A1 reads (SPEC §0.4 row 118) |
| `tests/helpers/{harness,model-names,pipeline-world,publish-world}.ts` and the P3 tests (`agent-check`, `apply`, `clock`, `context`, `daily`, `data-only`, `deploy`, `evidence`, `fake-agent`, `git`, `harness`, `links`, `p3-contract`, `pipeline-draft`, `preflight`, `prompts`, `prune`, `publish`, `recheck`, `snapshot`, `status`, `validate-loop`, `withhold`) | Vitest, offline; `daily`'s harness is adapted from Europe's (above) |

## Site (`app/`, `components/`)

| Europe file | Verdict | What changed |
|---|---|---|
| `app/layout.tsx` | adapted (P4) | The frame kept (`<html lang="en">`, next/font, `metadata` and `viewport`, the one column); CyberTracker's fonts and names, `viewport.themeColor` from `THEME_COLOR` (paper, with no look attribute on `<html>` since JL's pick, SPEC §0.4 row 174), the skip link as `<body>`'s first child, and `robots` noindex with `SampleBanner` only in sample mode (SPEC §7 "Page frame") |
| `app/globals.css` | adapted (P4) | The paper tokens and the semantic colour map copied exactly, in Appendix A.6's order; added the AI, severity and focus tokens and the `.night` Gap scope (the full-dark block P4 offered was deleted with JL's pick of paper, SPEC §0.4 row 174), body text at 15px × 1.6 and `.prose-serif` (Appendix A) |
| `app/not-found.tsx` | adapted (P4) | "brief" changed to "edition" |
| `app/feed.xml/route.ts` | adapted (P4) | The force-static RSS 2.0 route kept; its body moved to `components/pages/feed.ts` (`feedXml()`, whose `escapeXml()` also drops the characters XML 1.0 forbids), and a brief that failed `GAP_MATCH` gets its edition line, never the Gap headline (SPEC §6 `/feed.xml`) |
| `app/methodology/page.tsx` | adapted (P4) | Kept the `section(md, n)` reading of STYLE.md through `components/Markdown.tsx`; every section and table is CyberTracker's (SPEC §6 `/methodology`) |
| `app/page.tsx` | adapted (P4) | Europe's `TodayPage` kept: the newest brief through `BriefView` and `briefPropsFor()`, else `PageHeader` "Today" and `Empty`; the metadata comes from `editionMetadata(brief, gapOk)` and the empty line from `noEditionYet()` (SPEC §6 `/`) |
| `app/brief/[date]/page.tsx` | adapted (P4) | Kept: `generateStaticParams()` over the loaded briefs, `dynamicParams = false`, the Promise `params`, `briefPropsFor()` and `notFound()`; the title is `longDate(date)` and the rest of the metadata is `editionMetadata()` (SPEC §6 `/brief/[date]`) |
| `components/brief/props.ts` | adapted (P4) | `briefPropsFor(content, date)` kept (null without a brief; `prevDate` and `nextDate` from `neighbours()`); CyberTracker's `BriefViewProps` (metrics, `gapOk`, annotations, corrections, held items, item pages, edition dates, earlier items, `isLatest`) |
| `app/archive/page.tsx` | adapted (P4) | Europe's `ArchivePage` frame kept (`metadata` "Archive", the `PageHeader` count line, `Empty`, newest first); every row is CyberTracker's (SPEC §6 `/archive`) |
| `components/Markdown.tsx` | adapted (P4) | React text only, as before; a link keeps its `href` only for a site path (`/...`, not `//...`, or `#...`) or a URL `safeHref()` passes, else it renders as text (SPEC §7 "Untrusted text" item 1) |
| `components/layout/MastheadNav.tsx` | adapted (P4) | Became `components/layout/TabBar.tsx`: the main row (Today, Archive, Method, About) with the ink-filled active tab, a family row for the three trackers, a `pathname` prop for tests, ink underline hover and the focus ring drawn inset (SPEC §7 "Page frame") |
| `components/layout/chrome.tsx` | adapted (P4) | `Dateline`, `PageHeader`, `Section` (now with `className`), `Empty` and `Stamp` kept, the red accent replaced by ink (Appendix A.1); `Masthead`, `Footer` and `SampleBanner` moved to their own files under `components/layout/`, with CyberTracker's names and links from `run.json` and the footer's link row a `<div>` |
| `components/brief/analysis.tsx` (`Aside`) | adapted (P4) | Became `Aside` in `components/brief/brief-parts.tsx` ("Why it matters →", "Angle →") in ink; the rest of the file is Europe's domain and is dropped |
| `components/brief/sources.tsx` | adapted (P4) | `sourceIndex()`, `SourceRefs` and `SourceList` kept, with ink refs, `ExternalLink` titles with `lang`, the tier line, the state label and the withheld rendering; `EvidenceLinks` and the archive map dropped (SPEC §7 "Sources") |
| `components/ui/badges.tsx` | adapted (P4) | Only the neutral `Pill` kept, as `components/ui/Tag.tsx`; the tone, rung, probability, score, attribution, verification, trend, status and importance badges are dropped. `SeverityPips` and `AIChip` are new (Appendix A.3) |
| `components/charts/index.tsx` | dropped | `LineChart`, `MonthlyBars` and `HeatGrid` fit none of the three Gap charts, which are new (below) |
| `app/{board,forecasts,incidents,indicators,strikes}/**`, `components/brief/{BriefView,board,overview,records}.tsx`, `components/incidents/**`, `components/strikes/**` | dropped | Europe's pages; P4 builds CyberTracker's (below) |

## New in P4 (no Europe source)

| Files | What they are |
|---|---|
| `app/items/[id]/page.tsx`, `app/about/page.tsx` | The item page and About (SPEC §6), both static (the item page through `generateStaticParams()` and `dynamicParams = false`) |
| `components/brief/**` (except `sources.tsx`, `props.ts` and the `Aside`), `components/pages/**` | The brief page and its components, the Gap panel and Fix-side strip, the item page, and the text, labels, metadata and feed body of the routes (SPEC §6, §7) |
| `components/charts/**` | The three Gap charts with their shared scale, parts, labels and data table (SPEC §7 "GapPanel and charts") |
| `components/layout/StaleBanner.tsx`, `components/ui/{AIChip,Counted,ExternalLink,PlainText,SeverityPips}.tsx` | The stale banner, the AI chip and severity pips, the word-count marking and the untrusted-text renderers (SPEC §7); `Masthead`, `Footer` and `SampleBanner` come from Europe's `chrome.tsx` (above) |
| `lib/stale.ts`, `lib/record-links.ts`, `safeHref()` in `lib/urls.ts`, the `lib/page-text.ts` additions | The stale rule, the record links, the one URL check for content links and the kicker parts (SPEC §6, §7) |
| `scripts/color-check.ts`, `scripts/screenshots.mjs` | The token check of Appendix A.5 and the Kobol screenshot script (SPEC §9.9 item 6, §10 P4) |
| `tests/content.test.ts`, `tests/stale.test.ts`, `tests/color-check.test.ts`, `tests/screenshots.test.ts`, `tests/helpers/stale-cases.ts` | Vitest, offline; `tests/site.test.tsx` is adapted from Europe's (above) |

## Content

| Europe file | Verdict | What changed |
|---|---|---|
| `content/**` | dropped | Europe's data. CyberTracker's `content/` is tracked in this repo (SPEC §3): `scripts/publish.ts` writes it on `main`, and before go-live only the phase PRs change it (P2's backfill state and cutoff metrics, then `p5-golive`'s catch-up). The separate content repo of SPEC v1.0 was retired on 2026-11-08 and is unused |
