# Sources: terms, rate limits and credit lines

What CyberTracker reads, on what terms, how often, and how it credits each source. The registry itself
is `config/sources.yaml` (SPEC §4.13); this file is its companion (SPEC §10 P2 item 3). Times are
Asia/Taipei, with UTC labelled.

Status on 2026-11-10. The licences of the three GitHub-hosted datasets were read from their own
repositories. Kobol read every registry URL once on 2026-11-09, about 18:40 Taipei (10:40 UTC; SPEC §0.4
row 39), and P2 session 1 ran `npm run sources:check` there and read each source's terms page on
2026-11-09 between 22:15 and 22:50 Taipei (14:15 to 14:50 UTC). The wording below is from those pages.
What no page answered, or what waits on a publisher's answer, is marked **Open**: JVN's terms, whether
TWCERT/CC agrees to titles and links, the reuse terms of the RSS publishers, and the exact copyright line
the CVE Terms of Use ask for. JPCERT/CC asks sites that link to it to tell it by e-mail; that notice has
not been sent.

## How CyberTracker reads

- **One request pattern.** Collect runs once a morning at 04:30 Taipei (20:30 UTC the day before), plus
  manual reruns and `npm run sources:check`. GET only, in two waves: first the small feeds (RSS, MyJVN,
  the exchanges, the dashboard, KEV; `sources:check` adds NVD), then the large downloads (the CVE List
  delta log and zips, the EPSS files, the GHSA sync), at most 8 at a time in each, and 16 per-id record
  reads at a time; one retry after 2 s on a timeout, network error or 5xx, never on a 4xx; and a 240 s
  cap on the whole run (SPEC §8.3). The waves came from session 1's first run, where six small feeds
  timed out while the 37 MB delta log, the EPSS files and the GHSA data downloaded beside them.
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
| CISA Known Exploited Vulnerabilities (`kev`) | The `cisagov/kev-data` mirror on GitHub (fallback: the catalog on cisa.gov). Its LICENSE: "distributed under the Creative Commons 0 1.0 License"; third-party links in the data keep their own terms; no use of the CISA logo or DHS seal, and no suggestion of CISA or DHS endorsement | One catalog read a run (about 1.8 MB, 1,769 entries on 2026-11-09) from raw.githubusercontent.com; GitHub publishes no fixed number for raw reads, and session 1 saw no HTTP 429. When the mirror's catalog is older than the committed index, the run tries cisa.gov; only when every catalog that answers is older does it mark KEV failed (class `schema`), never reading an older catalog (SPEC §0.4 row 46) | "Known Exploited Vulnerabilities Catalog, CISA (CC0 1.0)" |
| CVE List V5 (`cvelist`) | `CVEProject/cvelistV5`: its README says the content may be searched, downloaded and used "per the CVE Program Terms of Use" (https://www.cve.org/Legal/TermsOfUse). The terms' "CVE Usage" section grants a licence to reproduce and distribute CVE "provided that you reproduce MITRE's copyright designation and this license in any such copy" | Each run: `deltaLog.json` (about 37 MB, 27 s on Kobol), the delta zips for the days it counts (release assets on github.com, at most 25 days), and at most 500 per-id records from raw.githubusercontent.com. The backfill makes one shallow clone (about 4.6 GiB) and then updates it in place | "CVE records from the CVE Program (cve.org), CVE List V5", followed by MITRE's copyright designation and the licence text, as the Terms of Use ask. **Open:** the exact copyright line, to be copied from the terms page when P4 writes the Methodology page |
| FIRST EPSS (`epss`) | Daily score file, `epss.empiricalsecurity.com` (the registry's `-current` URL redirects to the dated file; confirmed on Kobol 2026-11-09); fallback FIRST's API at api.first.org. Free to use, with attribution requested (https://www.first.org/epss/faq): "EPSS is maintained by the EPSS Special Interest Group at FIRST. Scores are generated by Empirical Security." The API "is designed for lookup, not bulk access" | At most three CSV files a run (E, E − 1, E − 7, about 2.8 MB each; the file starts `#model_version:v2026.06.15,score_date:...`); the API fallback asks only for candidates, in batches of 100, one request at a time. api.first.org: "Public endpoints without authentication are limited to 1000 requests per minute", and FIRST asks callers to avoid concurrent requests | "EPSS scores by FIRST (first.org/epss). EPSS is maintained by the EPSS Special Interest Group at FIRST. Scores are generated by Empirical Security." |
| GitHub Advisory Database (`ghsa`) | `github/advisory-database` git export, reviewed advisories only. Its LICENSE.md is Creative Commons Attribution 4.0 International (CC-BY 4.0) | A shallow sparse clone of about five months of `advisories/github-reviewed/`, then one fetch a run. CyberTracker does not use the REST `/advisories` API; read without a token on Kobol it allowed 60 requests an hour, and its credits are GitHub logins (SPEC §5.5, §0.4 row 40) | "GitHub Advisory Database (CC-BY 4.0)", with a link to github.com/advisories |
| NVD CVE API 2.0 (`nvd`) | services.nvd.nist.gov, keyless. Its terms of use (https://nvd.nist.gov/developers/terms-of-use) ask API users to show: "This product uses the NVD API but is not endorsed or certified by the NVD." | Without a key, 5 requests in a rolling 30-second window, with a 6 s sleep between requests recommended (the terms page); collect makes at most 2 a run, 6 s apart, and only when a kept candidate has no CNA or CISA ADP score | The NVD notice, word for word, on the Methodology page; scores labelled "NVD" where shown |
| JVN iPedia, JVNDB new entries (`myjvn`) | `jvndb.jvn.jp/ja/rss/jvndb_new.rdf`, run by JPCERT/CC and IPA (every MyJVN API form answered 404 on Kobol, 2026-11-09). **Open:** session 1 found no terms page for JVN or JVN iPedia | One GET a run (about 1.1 MB, 500 items covering about four days on 2026-11-09, short of the 7-day window) | "JVN iPedia (JPCERT/CC and IPA)", with a link to the JVNDB entry |
| JPCERT/CC (`jpcert`) | `www.jpcert.or.jp/rss/jpcert.rdf`. Its site guide (https://www.jpcert.or.jp/guide.html): linking is free, but JPCERT/CC asks to be told by e-mail; quoting is free when the source name, the document name and the URL are given; reprinting needs contact first. CyberTracker links and quotes titles only | One GET a run (21 items on 2026-11-09, 6 under `/at/`) | "JPCERT/CC", with the document name and a link to the alert or advisory |
| TWCERT/CC vulnerability notes (`twcert-tvn`) | `www.twcert.org.tw` RSS. Its terms (https://www.twcert.org.tw/tw/cp-39-470-19dcd-1.html): the content is TWCERT/CC's, and quoting needs the site's permission; titles with links are not explicitly permitted. **Open:** whether TWCERT/CC agrees to titles and links | One GET a run | "TWCERT/CC", with a link to the TVN note |
| TWSE and TPEx material information (`exchange-tw`, `exchange-tpex`) | Keyless open-data APIs: `openapi.twse.com.tw` and `www.tpex.org.tw/openapi`. TWSE: terms at https://www.twse.com.tw/zh/page/terms/use.html, data under the Open Government Data License v1 (https://data.gov.tw/license; compatible with CC BY 4.0, and it needs its own attribution statement). TPEx: terms only (https://www.tpex.org.tw/zh-tw/gtsm_disclaimer.html), with no open-data licence named. Both forbid automated download except by the routes they agree to, and the OpenAPI is one | One GET each a run (TWSE 4 rows and TPEx 2 rows on 2026-11-09) | "Taiwan Stock Exchange OpenAPI", with the Open Government Data License v1 attribution statement, and "Taipei Exchange OpenAPI". Neither answer carries a per-notice MOPS link, so the endpoint URL stays the link |
| Anthropic coordinated disclosure dashboard (`anthropic-cvd`) | `red.anthropic.com/2026/cvd/` and its `data/payload.json` (about 6.4 MB), read only when the revision changes. Its about page (https://red.anthropic.com/2026/cvd/about/) states no licence or reuse terms; CyberTracker shows only the published figures and ids, with a link | At most one page and one payload read a run | Always shown as "Anthropic disclosure dashboard (one lab, open source only, self-reported), revision N, date" (SPEC §5.6), with a link to the page |

## News and agency feeds (`rss`)

Every `rss` entry is read once a run, one GET, and only its headline, a short snippet, its date and its
link are kept. Each is credited by its outlet's name and a link to the item. **Open:** session 1 did not
read the RSS publishers' own terms for feed reuse; JPCERT/CC's and TWCERT/CC's are in the table above.

| Region | Entries (registry ids) |
|---|---|
| Global and US | `therecord`, `bleepingcomputer`, `securityweek`, `krebs`, `thehackernews`, `techcrunch-security`, `cisa-advisories`, `cisa-alerts`, `gtig`, `msft-security`, `unit42`, `volexity`, `project-zero`, `google-security`, `openai-news` |
| Europe | `ncsc-uk`, `cert-eu`, `bsi`, `cert-fr` |
| Taiwan | `twcert-tvn` (above), `focustaiwan`, `taipeitimes`, `cna`, `ithome-security` |
| Japan | `jpcert` (above), `ipa`, `security-next`, `nhk` |

Settled by session 1's `sources:check` on 2026-11-09:

- `gtig` reads the feed at cloudblog.withgoogle.com/topics/threat-intelligence/rss/ (the old URL was an
  HTML page).
- `google-security` reads https://feeds.feedburner.com/GoogleOnlineSecurityBlog directly (the blog's own
  URL redirected to an http feedburner address).
- `bsi` reads BSI's press and events feed (the old URL answered 404).
- `cisa-advisories` reads the joint advisories feed (about 1.4 MB, about one a month, fresh for 60 days),
  and the new `cisa-alerts` reads CISA's alerts (about 110 KB): the all-items feed was 5,685,118 bytes,
  over the 5 MiB feed cap.
- `cert-eu` is fresh for 30 days (its newest item was 16 days old; it publishes rarely).
- `ithome-security`'s dates carry no zone and are Taipei time (`date_zone: +08:00` in the registry).

## Search entries (`search`)

Reuters, AP, Anthropic's frontier red team, ENISA, Taiwan's Administration for Cyber Security,
Investigation Bureau and National Security Bureau, Japan's National Cybersecurity Office and National
Police Agency, Nikkei and labelled PRC state sources are `search` entries: collect fetches nothing from
them. From P3 they reach the drafting agent as suggested searches in its context (SPEC §4.13, §4.15),
and it cites what it reads with a link, under its sandbox rules (SPEC §9.5).
