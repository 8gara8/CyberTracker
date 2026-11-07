# CyberTracker-content

The data behind [CyberTracker](https://cybertracker.vercel.app), a daily brief on the AI-era cyber
threat across the US, Europe, Taiwan, Japan and the wider world.

This repository holds only what the morning run writes: one brief, one metrics file and one status
file per Taipei date, plus the running state the scripts keep. It holds no code. The site and the
pipeline live in [8gara8/CyberTracker](https://github.com/8gara8/CyberTracker), whose `SPEC.md`
describes every file here.

| Path | What it is |
|---|---|
| `briefs/YYYY-MM-DD.json` | One edition per Taipei date |
| `metrics/YYYY-MM-DD.json` | That day's metrics, computed by script |
| `metrics/inputs/YYYY-MM-DD.json` | The inputs manifest: every counted id, feed versions and hashes |
| `status/YYYY-MM-DD.json` | Every run that day, failed runs included |
| `state/` | Derived running state that only scripts write |
| `scoreboard.json`, `corrections.json`, `archive-index.json` | The Thesis Scoreboard, the corrections log and the archive index |

Nobody edits these files by hand. Every file is validated before it is committed and again when the
site is built.

## Reporting an error

Use the [correction form](https://github.com/8gara8/CyberTracker-content/issues/new?template=correction.yml).
It asks for the item id, the edition date, what is wrong and an evidence link, and nothing else. A
report that a named victim or an attribution is wrong withholds the item at once while it is reviewed.

## Data credits

- CISA Known Exploited Vulnerabilities catalog (cisa.gov), public domain.
- CVE List V5 (CVE Program, cve.org), under the CVE Terms of Use.
- EPSS scores (FIRST, first.org/epss).
- GitHub Advisory Database (github/advisory-database), CC-BY 4.0.

Each brief cites its own sources item by item.
