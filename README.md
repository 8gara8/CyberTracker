# CyberTracker

Daily AI-era cyber threat brief: exploits, breaches and the AI shift across the US, Europe, Taiwan, Japan and global.

Status: rebuilt for Kobol (SPEC.md v2.0, 2026-11-08); the build follows in phases P1 to P5 (SPEC.md §10).
P1 (data contract, validator, chat edition) merged on 2026-11-09; P2 (feeds, metrics and the two-year
backfill) is in progress.

- Design: [docs/DESIGN.md](docs/DESIGN.md) (approved v0.2, frozen)
- Build spec: [SPEC.md](SPEC.md)
- Agent guide: [AGENTS.md](AGENTS.md)
- Sources, terms and credit lines: [docs/SOURCES.md](docs/SOURCES.md)

Commands (Node from `/opt/homebrew/bin` on Kobol; SPEC.md §8.1 has the full list):

- `npm run check`: what CI runs, before every push
- `npm run collect -- --date D`: fetch D's feeds and write its source pack
- `npm run sources:check`: one line per feed, exit 1 on a priority-1 problem
- `npm run metrics -- --date D`: D's metrics, staged under `cache/staged/D/`
- `npm run backfill -- --check-reference`: reproduce Appendix D from `fixtures/reference/`
