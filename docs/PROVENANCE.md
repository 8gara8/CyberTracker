# Provenance

CyberTracker is forked from **8gara8/EuropeTracker at `2232913cb40bb9d6fe29cbf585dadbc658c89570`**
(`main` on 2026-11-07, "Merge pull request #8 from 8gara8/phase-5-go-live"; SPEC §0.3). Nothing was
merged from Git history: files were copied by hand into a fresh repo and changed as below.

Verdicts:

- **copied**: the same code, with only comments, names and imports changed;
- **adapted**: the same job, rewritten where CyberTracker differs (the "What changed" column);
- **later**: not copied in the Foundation PR; the phase named in SPEC §8's table or §10 adapts it;
- **dropped**: not carried over (SPEC §2 "Dropped from EuropeTracker" says why).

Every carried file names its Europe source in its header comment.

## Scaffolding

| Europe file | Verdict | What changed |
|---|---|---|
| `package.json` | adapted | Name `cybertracker`; the same packages and exact pins (SPEC §2); only the Foundation scripts (`typecheck`, `test`, `check`, `agent:check`); `engines.node >=22` |
| `package-lock.json` | adapted | Europe's lockfile with the name changed, because `npm install` on this machine fails inside npm itself (`edgesOut` of null); `npm ci` installs it cleanly |
| `tsconfig.json`, `vitest.config.ts`, `postcss.config.mjs` | copied | |
| `next.config.ts` | adapted | `poweredByHeader: false` only; P4 adds the CSP and headers (SPEC §6.6) |
| `.gitignore` | adapted | Exactly SPEC §3.1 |
| `.github/workflows/ci.yml` | adapted | One job running `npm run check` on Node 24 (SPEC §9.2); P1 adds the report-only `content` job |
| `README.md`, `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `docs/DESIGN.md` | replaced | Written for CyberTracker in PR 1 |
| `docs/RUNBOOK.md` | later | P3 writes CyberTracker's runbook |
| `docs/SEED-REPORT.md`, `research/**` | dropped | The Gap history is computed from feeds in P2; the source registry is `config/sources.yaml` |

## Libraries (`lib/`)

| Europe file | Verdict | What changed |
|---|---|---|
| `lib/dates.ts` | adapted | Kept `isValidDate`, `taipeiToday`, `taipeiDateOf`, `taipeiTime`, `addDays`, `daysBetween`, `isMonday`, `inRange`. Added `taipeiTimestamp`, `at`, `utcDateOf`, `weekday`, `dataCutoffFor`, `windowEnding`, `isoWeekStart`, `lastSunday`, `newestCompleteWeek` (SPEC §5.1). Dropped the Kyiv helper, the 05:30 window and the month list |
| `lib/text.ts` | copied | `countWords()` unchanged |
| `lib/urls.ts` | adapted | Kept `stripArchivePrefix`, `normalizeUrl` (Telegram folding removed) and `isHttpsUrl`. Added `hostOf`, `hostMatches`, `extractUrls`, `defang` and `blockedEntry` (SPEC §4.12). Dropped `isGoogleNewsUrl` |
| `lib/vocab.ts` | replaced | The Foundation holds only `BLOCKED_HOSTS` (Appendix B.3) and the canary; P1 adds CyberTracker's vocabularies |
| `lib/collect.ts` | later (P2) | Keeps the harness, RSS parsing, `feedDate`, dedupe and caps; drops Telegram and Google News |
| `lib/context.ts` | later (P3) | The pattern, for CyberTracker's `AgentContext` |
| `lib/validate.ts`, `lib/rules/types.ts`, `lib/rules/words.ts`, `lib/rules/sources.ts`, `lib/schema/common.ts`, `lib/json-schema.ts` | later (P1) | The validator's frame and the generic rules; every rule is rewritten for items, metrics and the Gap |
| `lib/apply.ts` | later (P1) | `applyDraft()` and `dropUnverified()` for CyberTracker's brief |
| `lib/content.ts`, `lib/site.ts`, `lib/site-data.ts`, `lib/format.ts`, `lib/markdown.ts` | later (P4) | The site's content reader and helpers |
| `lib/aggregate.ts`, `lib/probability.ts`, `lib/rules/{board,developments,forecasts,indicators,meta,records}.ts`, `lib/schema/{brief,context,draft-brief,forecast,incident,index,misc,pack,state,strike}.ts` | dropped | Europe's domain (incidents, strikes, state, indicators, forecasts, the board, probability terms) |

## Scripts

| Europe file | Verdict | What changed |
|---|---|---|
| `scripts/lib/log.ts` | copied | |
| `scripts/lib/lock.ts` | adapted | The lock appears atomically through a hard link, so a lost race returns the holder instead of throwing (PR 2 review) |
| `scripts/lib/run.ts` | adapted | An `onLine` hook (returning `"stop"` kills the child) and a `stopped` flag, for the sandbox guard (SPEC §8.12) |
| `scripts/lib/git.ts` | adapted | `syncMain(g, layout)` takes the allowed paths, fast-forwards, and rebases with `--autostash` only when local commits stay inside the layout; `onOriginMain` replaces `onOrigin`; `ensureIdentity` sets a commit identity only when none is configured (SPEC §8.8) |
| `scripts/lib/transcript.ts` | adapted | More fields (tools, MCP servers, permission mode, calls with results, denials, usage, terminal reason, limits, safety stops) and `scrubModels()` (SPEC §8.12) |
| `scripts/lib/agent.ts` | adapted | `--restricted`, `--safe-mode`, no model flag, an isolated config dir. Written for the retired cloud run; P3 brings it back to Europe's Kobol harness (keychain token, `~/.cybertracker`, SPEC §9.4) |
| `scripts/agent-check.ts` | adapted | `ask()` kept; sandbox tests and the canary test (SPEC §8.12). P3 drops the cloud-only `--find-passthrough` and `--network` and restores Europe's Mac sign-in check |
| `scripts/publish.ts` | later (P3) | Commits only `content/` to `main` in this repo and pushes (SPEC §8.7) |
| `scripts/daily.ts` | later (P3) | Data-only edition first, run records, CyberTracker's stages (SPEC §8.2) |
| `scripts/preflight.ts` | later (P3) | Europe's arm64, keychain and push-path checks |
| `scripts/collect.ts` | later (P2) | `--check-feeds` becomes `sources:check` |
| `scripts/build-context.ts` | later (P3) | |
| `scripts/validate.ts`, `scripts/gen-json-schema.ts` | later (P1) | |
| `scripts/lib/summary.ts` | later (P1) | Becomes `lib/chat.ts` and `scripts/chat.ts` (four formats; `changes()` dropped) |
| `scripts/lib/keychain.ts`, `scripts/daily.sh` | later (P3) | CyberTracker's names and paths (SPEC §8.2, §9.6) |
| `scripts/archive-urls.ts`, `scripts/promote.ts`, `scripts/score-forecasts.ts`, `scripts/seed-build.ts` | dropped | SPEC §2 |
| none | new in Foundation | `lib/feeds/http.ts` (`fetchFeed()`, SPEC §8.3) |

## Routine, fixtures and tests

| Europe file | Verdict | What changed |
|---|---|---|
| `routine/agent-settings.json` | adapted | SPEC §9.5: the fixed denies, then both WebFetch domain forms of every `BLOCKED_HOSTS` host entry in order, then `*.onion` and `*.i2p`; hooks off |
| `routine/TASK.md`, `routine/PROMPT.md`, `routine/REPAIR.md`, `routine/STYLE.md`, `routine/schema/draft-brief.schema.json` | later (P1 to P3) | Rewritten for CyberTracker |
| `fixtures/agent/transcript-auth-failed.jsonl` | copied | Its model value replaced by `<model>`. The current CLI could not be made to fail sign-in (it signs in even with an empty passthrough), so the shape is Europe's (SPEC §0.5) |
| `fixtures/agent/fake-claude.mjs` | later (P3) | For the end-to-end pipeline tests |
| none | new in Foundation | `fixtures/agent/transcript-ok.jsonl` (a real transcript from `agent:check` on CLI 2.1.319, model values replaced), `fixtures/injection/` (the planted page, RSS item and pre-P3 canary prompt) |
| `fixtures/src/**`, `fixtures/empty-content/**` | later (P1, P4) | The fixture builder's pattern; every fixture is CyberTracker's own |
| `fixtures/briefs/**`, `fixtures/collect/**`, `fixtures/context/**`, `fixtures/evidence/**`, `fixtures/site-content/**` | dropped | Europe's data; CyberTracker builds its own (P1, P2) |
| `tests/lib.test.ts` | adapted | CyberTracker's dates (cutoff, windows, ISO weeks, the two CVE timestamps without a zone), URLs, defang and the blocked list |
| `tests/collect.test.ts`, `tests/daily.test.ts`, `tests/fixtures.test.ts`, `tests/validate.test.ts`, `tests/site.test.tsx` | later | Rewritten in the phase that adds their code |
| `tests/aggregate.test.ts`, `tests/pipeline.test.ts`, `tests/seed.test.ts` | dropped | Europe's domain |
| none | new in Foundation | `tests/no-europe-strings.test.ts`, `tests/agent.test.ts`, `tests/transcript.test.ts`, `tests/lock.test.ts` |

## Site (`app/`, `components/`)

| Europe file | Verdict | What changed |
|---|---|---|
| `app/layout.tsx`, `app/globals.css`, `app/not-found.tsx`, `app/archive/page.tsx`, `app/methodology/page.tsx`, `app/feed.xml/route.ts`, `components/Markdown.tsx`, `components/layout/{MastheadNav,chrome}.tsx`, `components/brief/sources.tsx`, `components/charts/index.tsx`, `components/ui/badges.tsx` | later (P4) | The paper look and CyberTracker's pages (SPEC §6, §7) |
| `app/{board,forecasts,incidents,indicators,strikes}/**`, `app/brief/[date]/page.tsx`, `app/page.tsx`, `components/brief/{BriefView,analysis,board,overview,props,records}.tsx`, `components/incidents/**`, `components/strikes/**` | dropped | Europe's pages; P4 builds CyberTracker's |

## Content

| Europe file | Verdict | What changed |
|---|---|---|
| `content/**` | dropped | CyberTracker's content lives in `8gara8/CyberTracker-content`, written only by `scripts/publish.ts` |
