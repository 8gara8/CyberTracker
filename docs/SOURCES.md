# Sources: terms, rate limits and credit lines

What CyberTracker reads, on what terms, how often, and how it credits each source. The registry itself
is `config/sources.yaml` (SPEC §4.13); this file is its companion (SPEC §10 P2 item 3). Times are
Asia/Taipei, with UTC labelled.

Status on 2026-11-09. The licences of the three GitHub-hosted datasets were read from their own
repositories. Kobol read every registry URL once on 2026-11-09, about 18:40 Taipei (10:40 UTC); the
changes that read made are SPEC §0.4 row 39. Each terms page and each limit marked
"(Kobol, P2 session 1)" is still to be read on that source's own site and written in here.

## How CyberTracker reads

- **One request pattern.** Collect runs once a morning at 04:30 Taipei (20:30 UTC the day before), plus
  manual reruns and `npm run sources:check`. GET only, at most 8 feeds at a time and 16 per-id record
  reads at a time, one retry after 2 s on a timeout, network error or 5xx, never on a 4xx, and a 240 s
  cap on the whole run (SPEC §8.3).
- **User agent:** `CyberTracker/1.0 (+https://cybertracker.vercel.app)` (`config/run.json`
  `user_agent`), on every HTTP request.
- **No keys and no accounts.** No source is read with an API key, token or login. Git reads
  (`ls-remote`, the GHSA sparse clone, the backfill's CVE List clone) go to github.com without
  credentials.
- **Only URLs CyberTracker builds.** Collect fetches the registry's URLs, or a URL built from an id, tag
  or commit by a fixed pattern. A URL inside feed content is stored as data and never fetched.
- **Everything read is data.** Feed text is sanitised, wrapped and never treated as an instruction
  (SPEC §4.14).

## What is published

- **Structured data** (KEV, CVE records, EPSS, GHSA, NVD scores, the CERT notes, the dashboard figures):
  ids, dates, counts, scores and short titles, with a link to the record's own page. The Gap's history
  in `content/state/` and `content/metrics/` holds ids, dates and counts, and for AI-credited records
  only the matched tool name ("Claude", "Codex Security"), never the credit line.
- **`content/state/credit-candidates.json`** keeps the credit strings that pass the AI-finder
  `prefilter`, copied from public CVE records (CVE Program data), so a change to the AI-finder list can
  be rematched without a fresh clone. Those strings can include researchers' names as the CNAs publish
  them. The file is never rendered: no page, brief, chat edition or metrics file shows more than the
  matched tool name. At the reference cutoff it holds 1,430 strings from 1,377 records (about 189 KB).
- **News and agency feeds:** only the headline and a short snippet (at most 200 and 300 characters,
  sanitised) reach the agent, and an item is always shown with a link to the original. The brief's
  sentences are CyberTracker's own; no article text is republished.
- **Fixtures** in the repo use real formats with invented prose, and trimmed CVE records with people's
  names replaced by "SAMPLE Researcher" (SPEC §3).

## Structured feeds

| Feed (registry id) | Source and terms | Rate limits | Credit line |
|---|---|---|---|
| CISA Known Exploited Vulnerabilities (`kev`) | The `cisagov/kev-data` mirror on GitHub (fallback: the catalog on cisa.gov). Its LICENSE: "distributed under the Creative Commons 0 1.0 License"; third-party links in the data keep their own terms; no use of the CISA logo or DHS seal, and no suggestion of CISA or DHS endorsement | One catalog read a run (about 1.8 MB) from raw.githubusercontent.com; GitHub publishes no fixed number for raw reads (Kobol, P2 session 1: record any 429) | "Known Exploited Vulnerabilities Catalog, CISA (CC0 1.0)" |
| CVE List V5 (`cvelist`) | `CVEProject/cvelistV5`: its README says the content may be searched, downloaded and used "per the CVE Program Terms of Use" (https://www.cve.org/Legal/TermsOfUse); the terms text itself: (Kobol, P2 session 1) | Each run: `deltaLog.json` (about 37 MB, 27 s on Kobol), the delta zips for the days it counts (release assets on github.com, at most 25 days), and at most 500 per-id records from raw.githubusercontent.com. The backfill makes one shallow clone (about 4.6 GiB) and then updates it in place | "CVE records from the CVE Program (cve.org), CVE List V5", with the wording the Terms of Use ask for (Kobol, P2 session 1) |
| FIRST EPSS (`epss`) | Daily score file, `epss.empiricalsecurity.com` (the registry's `-current` URL redirects to the dated file; confirmed on Kobol 2026-11-09); fallback FIRST's API at api.first.org. Usage terms: (Kobol, P2 session 1) | At most three CSV files a run (E, E − 1, E − 7, about 2.8 MB each); the API fallback asks only for candidates, in batches of 100. API limits: (Kobol, P2 session 1) | "EPSS scores by FIRST (first.org/epss)", in the form FIRST asks for (Kobol, P2 session 1) |
| GitHub Advisory Database (`ghsa`) | `github/advisory-database` git export, reviewed advisories only. Its LICENSE.md is Creative Commons Attribution 4.0 International (CC-BY 4.0) | A shallow sparse clone of about five months of `advisories/github-reviewed/`, then one fetch a run. CyberTracker does not use the REST `/advisories` API; read without a token on Kobol it allowed 60 requests an hour, and its credits are GitHub logins (SPEC §5.5, §0.4 row 40) | "GitHub Advisory Database (CC-BY 4.0)", with a link to github.com/advisories |
| NVD CVE API 2.0 (`nvd`) | services.nvd.nist.gov, keyless. Terms of use and the notice NVD asks API users to show ("uses the NVD API but is not endorsed or certified by the NVD"): confirm the wording (Kobol, P2 session 1) | NVD documents 5 requests in a rolling 30-second window without a key; collect makes at most 2 a run, 6 s apart, and only when a kept candidate has no CNA or CISA ADP score. Confirm (Kobol, P2 session 1) | The NVD notice, on the Methodology page; scores labelled "NVD" where shown |
| JVN iPedia, JVNDB new entries (`myjvn`) | `jvndb.jvn.jp/ja/rss/jvndb_new.rdf`, run by JPCERT/CC and IPA (every MyJVN API form answered 404 on Kobol, 2026-11-09). Terms: (Kobol, P2 session 1) | One GET a run (about 1.1 MB) | "JVN iPedia (JPCERT/CC and IPA)" (Kobol, P2 session 1) |
| JPCERT/CC (`jpcert`) | `www.jpcert.or.jp/rss/jpcert.rdf`. Terms for reuse of titles and links: (Kobol, P2 session 1) | One GET a run | "JPCERT/CC", with a link to the alert or advisory |
| TWCERT/CC vulnerability notes (`twcert-tvn`) | `www.twcert.org.tw` RSS. Terms: (Kobol, P2 session 1) | One GET a run | "TWCERT/CC", with a link to the TVN note |
| TWSE and TPEx material information (`exchange-tw`, `exchange-tpex`) | Keyless open-data APIs: `openapi.twse.com.tw` and `www.tpex.org.tw/openapi`. Open-data licence terms: (Kobol, P2 session 1) | One GET each a run | "Taiwan Stock Exchange OpenAPI" and "Taipei Exchange OpenAPI", with the per-notice MOPS link once confirmed (Kobol, P2 session 1) |
| Anthropic coordinated disclosure dashboard (`anthropic-cvd`) | `red.anthropic.com/2026/cvd/` and its `data/payload.json` (about 6.4 MB), read only when the revision changes. Terms: (Kobol, P2 session 1) | At most one page and one payload read a run | Always shown as "Anthropic disclosure dashboard (one lab, open source only, self-reported), revision N, date" (SPEC §5.6), with a link to the page |

## News and agency feeds (`rss`)

Every `rss` entry is read once a run, one GET, and only its headline, a short snippet, its date and its
link are kept. Each is credited by its outlet's name and a link to the item. The publishers' own terms
for feed reuse are recorded below as they are read (Kobol, P2 session 1).

| Region | Entries (registry ids) |
|---|---|
| Global and US | `therecord`, `bleepingcomputer`, `securityweek`, `krebs`, `thehackernews`, `techcrunch-security`, `cisa-advisories`, `gtig`, `msft-security`, `unit42`, `volexity`, `project-zero`, `google-security`, `openai-news` |
| Europe | `ncsc-uk`, `cert-eu`, `bsi`, `cert-fr` |
| Taiwan | `twcert-tvn` (above), `focustaiwan`, `taipeitimes`, `cna`, `ithome-security` |
| Japan | `jpcert` (above), `ipa`, `security-next`, `nhk` |

Open after Kobol's read on 2026-11-09, for (Kobol, P2 session 1): `gtig` (the registry URL is an HTML
page; the feed is on cloudblog.withgoogle.com), `bsi` (404; CERT-Bund's advisory feed and BSI's press
feed answer), `google-security` (redirects to an http feedburner URL) and `cisa-advisories` (5,685,118
bytes, over the 5 MiB feed cap).

## Search entries (`search`)

Reuters, AP, Anthropic's frontier red team, ENISA, Taiwan's Administration for Cyber Security,
Investigation Bureau and National Security Bureau, Japan's National Cybersecurity Office and National
Police Agency, Nikkei and labelled PRC state sources are `search` entries: collect fetches nothing from
them. From P3 they reach the drafting agent as suggested searches in its context (SPEC §4.13, §4.15),
and it cites what it reads with a link, under its sandbox rules (SPEC §9.5).
