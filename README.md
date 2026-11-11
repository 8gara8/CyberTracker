# CyberTracker

Daily AI-era cyber threat brief: exploits, breaches and the AI shift across the US, Europe, Taiwan, Japan and global.

Status: rebuilt for Kobol (SPEC.md v2.0, 2026-11-08); the build follows in phases P1 to P5 (SPEC.md §10).
P1 (data contract, validator, chat edition) merged on 2026-11-09, P2 (feeds, metrics and the two-year
backfill) on 2026-11-10 and P3 (the morning pipeline and its dry runs on Kobol) on 2026-11-11. P4 (the
static site) is in progress on draft PR #6: built and tested, with its Kobol steps (the screenshots of
both looks and a few phone and link checks) next.

- Design: [docs/DESIGN.md](docs/DESIGN.md) (approved v0.2, frozen)
- Build spec: [SPEC.md](SPEC.md)
- Agent guide: [AGENTS.md](AGENTS.md)
- Sources, terms and credit lines: [docs/SOURCES.md](docs/SOURCES.md)
- Running and recovering the morning: [docs/RUNBOOK.md](docs/RUNBOOK.md)

Commands (Node from `/opt/homebrew/bin` on Kobol; SPEC.md §8.1 has the full list):

- `npm run check`: what CI runs, before every push
- `npm run collect -- --date D`: fetch D's feeds and write its source pack
- `npm run sources:check`: one line per feed, exit 1 on a priority-1 problem
- `npm run metrics -- --date D`: D's metrics, staged under `cache/staged/D/`
- `npm run backfill -- --check-reference`: reproduce Appendix D from `fixtures/reference/`
- `zsh scripts/daily.sh --dry-run --no-deadline`: a dry run of the whole morning (the morning itself runs
  `scripts/daily.sh` with no arguments; `npm run daily` is for tests)
- `npm run publish -- --date D`: publish a valid draft by hand, before 11:00 Taipei
- `npm run recheck -- --date D`, `npm run links -- --date D`: dispute intake and the 14-day re-check; the
  link check
- `npm run context -- --date D`: write the agent's context for D
- `npm run chat -- --date D`: print D's chat edition
- `npm run agent:check`: check the agent CLI and its sign-in; `-- --all` adds the sandbox and canary tests
- `npm run dev:sample`: the site on the sample data; `npm run build:sample` and `npm run build:empty` build
  it from the sample and from the empty folder
- `npm run color:check`: check the site's colour pairs against SPEC.md Appendix A.5
- `node scripts/screenshots.mjs --base http://localhost:3000 --out docs/screenshots/p4/<look>`: the P4
  screenshots on Kobol, from a running site (needs `playwright-core`, SPEC.md §9.9 item 6)
