# Seed config contents

The starting contents of the config files in `config/`, moved verbatim from SPEC v1.0 Appendix B when
the spec was rewritten for Kobol (SPEC v2.0, 2026-11-08). P1 writes each file to `config/` in the shape
SPEC §4.11 gives, validates it with its schema, and checks the counts stated here. From then `config/` governs
and this file stays frozen as the record of the seed and its Verify notes, like `docs/DESIGN.md`. "Verify" notes say
which phase checks a value. Section references are to SPEC v2.0.

These are the contents of `config/` when it first lands: the Foundation PR for `run.json` and `sources.yaml`, P1 for
the other files (Verify fixes in P2). Two files land in P1 in a starting form and get their seed in P5:
`claims.json` starts as `{"schema_version":1,"version":0,"claims":[]}` (B.10), and `watch-windows.json`
starts with an empty `windows` list (B.7). Every other file starts at `version: 1`. Tables below become JSON arrays with the field
names of §4.11, in table order; empty cells are `[]` or `null`. "Verify" marks a fact to check against
the live source in the named phase before the PR is marked ready; a wrong value is fixed in that PR,
not carried forward.

### B.1 `vendors.json`

213 vendors: 162 widely deployed, 27 Taiwanese, 26 Japanese. `wd` is `widely_deployed` (y or n);
`cna` lists CNA short names exactly as CVE records spell them. Taiwanese and Japanese vendors come first,
then the rest by country, then community projects with no country.

With this list, CISA's KEV additions for Taiwanese vendors since 2025-01-01 fall on **13** distinct
dates. The design doc's 11 counted only its eleven named vendors; Digiever (2025-12-22,
CVE-2023-52163) and TeamT5 (2026-02-17, CVE-2024-7694) add two. Japanese vendors: 6 dates. Over the
30 and 90 days to 2026-11-06: Taiwan 0 and 1 (Zyxel, 2026-09-21), Japan 0 and 0 (Appendix D).

Verify in P2: the headquarters of entries whose note says Verify, every `domains` entry (the vendor's
advisory pages must live there), and every `cna` value against the CVE Program's partner list.

| id | name | country | wd | aliases | cna | domains | note |
|---|---|---|---|---|---|---|---|
| `acer` | Acer | TW | y |  |  | acer.com |  |
| `advantech` | Advantech | TW | y |  |  | advantech.com |  |
| `arcadyan` | Arcadyan | TW | n |  |  | arcadyan.com | Router OEM; KEV lists Buffalo firmware under Arcadyan |
| `asus` | ASUS | TW | y | ASUSTeK Computer, ASUSTeK | `ASUS` | asus.com |  |
| `asustor` | ASUSTOR | TW | n |  |  | asustor.com | NAS maker, ASUS group |
| `aten` | ATEN | TW | n | ATEN International |  | aten.com |  |
| `avtech` | AVTECH | TW | n | AVTECH Security |  | avtech.com.tw | Verify domain |
| `d-link` | D-Link | TW | y | D-Link and TRENDnet, D-Link Systems |  | dlink.com |  |
| `delta-electronics` | Delta Electronics | TW | y |  |  | deltaww.com |  |
| `digiever` | Digiever | TW | n |  |  | digiever.com | NVR maker. Verify HQ before merge |
| `draytek` | DrayTek | TW | y |  |  | draytek.com |  |
| `edimax` | Edimax | TW | y | Edimax Technology |  | edimax.com |  |
| `geovision` | GeoVision | TW | y |  |  | geovision.com.tw |  |
| `gigabyte` | GIGABYTE | TW | y | GIGA-BYTE Technology |  | gigabyte.com |  |
| `insyde` | Insyde Software | TW | y | Insyde |  | insyde.com | UEFI firmware in many PCs |
| `mediatek` | MediaTek | TW | y |  |  | mediatek.com |  |
| `merit-lilin` | Merit LILIN | TW | n | LILIN |  | meritlilin.com | Verify domain |
| `moxa` | Moxa | TW | y |  |  | moxa.com |  |
| `msi` | MSI | TW | y | Micro-Star International |  | msi.com |  |
| `nuuo` | NUUO | TW | n |  |  | nuuo.com |  |
| `planet` | Planet Technology | TW | n |  |  | planet.com.tw |  |
| `qnap` | QNAP | TW | y | QNAP Systems | `qnap` | qnap.com |  |
| `realtek` | Realtek | TW | y | Realtek Semiconductor |  | realtek.com |  |
| `synology` | Synology | TW | y |  |  | synology.com |  |
| `teamt5` | TeamT5 | TW | n |  |  | teamt5.org | Security vendor (ThreatSonar) |
| `vivotek` | VIVOTEK | TW | n |  |  | vivotek.com |  |
| `zyxel` | Zyxel | TW | y | Zyxel Networks, ZyXEL Communications | `Zyxel` | zyxel.com |  |
| `brother` | Brother | JP | y | Brother Industries |  | brother.com |  |
| `buffalo` | Buffalo | JP | y |  |  | buffalo.jp |  |
| `canon` | Canon | JP | y |  |  | canon.com, global.canon |  |
| `contec` | CONTEC | JP | n | SolarView |  | contec.com | KEV lists the SolarView product line as vendor |
| `cybozu` | Cybozu | JP | n |  |  | cybozu.com |  |
| `elecom` | ELECOM | JP | n |  |  | elecom.co.jp |  |
| `epson` | Epson | JP | y | Seiko Epson |  | epson.com, epson.jp |  |
| `fujitsu` | Fujitsu | JP | y |  |  | fujitsu.com |  |
| `fxc` | FXC | JP | n |  |  | fxc.jp | Verify domain |
| `hitachi` | Hitachi | JP | y | Hitachi Vantara, Hitachi Energy | `HITVAN` | hitachi.com, hitachivantara.com, hitachienergy.com | Subsidiaries trading as Hitachi take JP |
| `i-o-data` | I-O DATA | JP | n | I-O DATA DEVICE |  | iodata.jp |  |
| `konica-minolta` | Konica Minolta | JP | y |  |  | konicaminolta.com |  |
| `kyocera` | Kyocera | JP | y | KYOCERA Document Solutions |  | kyocera.com, kyoceradocumentsolutions.com |  |
| `mitsubishi-electric` | Mitsubishi Electric | JP | y |  |  | mitsubishielectric.com |  |
| `motex` | MOTEX | JP | n |  |  | motex.co.jp | LANSCOPE |
| `nec` | NEC | JP | y | NEC Platforms |  | nec.com, jpn.nec.com |  |
| `omron` | Omron | JP | y |  |  | omron.com |  |
| `panasonic` | Panasonic | JP | y |  |  | panasonic.com |  |
| `ricoh` | Ricoh | JP | y |  |  | ricoh.com |  |
| `sharp` | Sharp | JP | y |  |  | global.sharp, sharp.co.jp | Foxconn-owned, HQ Sakai |
| `sky` | Sky Co. | JP | n | SKYSEA |  | skygroup.jp | SKYSEA Client View. Verify domain |
| `soliton` | Soliton Systems | JP | n | Soliton Systems K.K |  | soliton.co.jp |  |
| `sony` | Sony | JP | y |  |  | sony.com |  |
| `toshiba` | Toshiba | JP | y |  |  | toshiba.co.jp, global.toshiba |  |
| `trend-micro` | Trend Micro | JP | y |  | `trendmicro` | trendmicro.com |  |
| `yokogawa` | Yokogawa | JP | y | Yokogawa Electric |  | yokogawa.com |  |
| `atlassian` | Atlassian | AU | y |  | `atlassian` | atlassian.com | Dual HQ Sydney and San Francisco |
| `papercut` | PaperCut | AU | y |  | `PaperCut` | papercut.com |  |
| `mitel` | Mitel | CA | n |  |  | mitel.com |  |
| `opentext` | OpenText | CA | y | Micro Focus |  | opentext.com, microfocus.com |  |
| `sierra-wireless` | Sierra Wireless | CA | n |  |  | sierrawireless.com | Part of Semtech |
| `abb` | ABB | CH | y |  |  | abb.com |  |
| `acronis` | Acronis | CH | y |  | `Acronis` | acronis.com |  |
| `dahua` | Dahua | CN | y | Dahua Technology | `dahua` | dahuasecurity.com |  |
| `four-faith` | Four-Faith | CN | n | Xiamen Four-Faith |  | four-faith.com | Chinese, not Taiwanese |
| `h3c` | H3C | CN | n |  |  | h3c.com |  |
| `hikvision` | Hikvision | CN | y |  |  | hikvision.com |  |
| `huawei` | Huawei | CN | y |  |  | huawei.com |  |
| `kingsoft` | Kingsoft | CN | n | WPS |  | wps.com |  |
| `lenovo` | Lenovo | CN | y |  |  | lenovo.com | HQ Beijing and Hong Kong |
| `reolink` | Reolink | CN | n |  |  | reolink.com |  |
| `ruijie` | Ruijie Networks | CN | n | Ruijie |  | ruijienetworks.com |  |
| `sangfor` | Sangfor | CN | n |  |  | sangfor.com |  |
| `tenda` | Tenda | CN | n |  |  | tendacn.com |  |
| `terramaster` | TerraMaster | CN | n |  |  | terra-master.com |  |
| `tp-link` | TP-Link | CN | y | TP-Link Systems, TP-Link Technologies | `TPLink` | tp-link.com | Founded in Shenzhen; US-based TP-Link Systems Inc. split off in 2024. Never TW |
| `tvt` | TVT | CN | n | Shenzhen TVT |  | tvt.net.cn |  |
| `xiaomi` | Xiaomi | CN | y |  |  | mi.com |  |
| `yealink` | Yealink | CN | n |  |  | yealink.com |  |
| `zkteco` | ZKTeco | CN | n |  |  | zkteco.com |  |
| `zte` | ZTE | CN | y |  |  | zte.com.cn |  |
| `jetbrains` | JetBrains | CZ | y |  | `JetBrains` | jetbrains.com |  |
| `kentico` | Kentico | CZ | n |  |  | kentico.com |  |
| `codesys` | CODESYS | DE | y |  |  | codesys.com | OT runtime used by many PLC makers |
| `n8n` | n8n | DE | n |  |  | n8n.io |  |
| `paessler` | Paessler | DE | n |  |  | paessler.com | PRTG |
| `phoenix-contact` | Phoenix Contact | DE | y |  |  | phoenixcontact.com |  |
| `rarlab` | RARLAB | DE | y | win.rar |  | rarlab.com, win-rar.com | WinRAR; distributed by win.rar GmbH |
| `roundcube` | Roundcube | DE | y |  |  | roundcube.net | Part of Nextcloud |
| `sap` | SAP | DE | y |  | `sap` | sap.com |  |
| `siemens` | Siemens | DE | y |  | `siemens` | siemens.com |  |
| `suse` | SUSE | DE | y |  |  | suse.com |  |
| `nokia` | Nokia | FI | y |  |  | nokia.com |  |
| `dassault` | Dassault Systèmes | FR | y |  | `3DS` | 3ds.com |  |
| `schneider-electric` | Schneider Electric | FR | y |  |  | se.com |  |
| `arm` | Arm | GB | y |  | `Arm` | arm.com |  |
| `canonical` | Canonical | GB | y | Ubuntu | `canonical` | canonical.com, ubuntu.com |  |
| `sophos` | Sophos | GB | y |  | `Sophos` | sophos.com |  |
| `check-point` | Check Point | IL | y | Check Point Software | `checkpoint` | checkpoint.com |  |
| `cyberark` | CyberArk | IL | y |  |  | cyberark.com |  |
| `jfrog` | JFrog | IL | y |  | `JFROG` | jfrog.com |  |
| `unitronics` | Unitronics | IL | n |  |  | unitronicsplc.com |  |
| `zoho` | Zoho | IN | y | ManageEngine |  | zoho.com, manageengine.com |  |
| `lg` | LG Electronics | KR | n | LG |  | lg.com |  |
| `samsung` | Samsung | KR | y |  | `Samsung Mobile`, `SamsungMobile`, `samsung.tv_appliance` | samsung.com |  |
| `mikrotik` | MikroTik | LV | y |  |  | mikrotik.com |  |
| `zabbix` | Zabbix | LV | y |  |  | zabbix.com |  |
| `bitdefender` | Bitdefender | RO | n |  |  | bitdefender.com |  |
| `kaspersky` | Kaspersky | RU | n |  |  | kaspersky.com |  |
| `ericsson` | Ericsson | SE | y |  |  | ericsson.com |  |
| `eset` | ESET | SK | y |  |  | eset.com |  |
| `adobe` | Adobe | US | y |  | `adobe` | adobe.com |  |
| `akamai` | Akamai | US | y |  |  | akamai.com |  |
| `amazon` | Amazon Web Services | US | y | Amazon, AWS |  | aws.amazon.com |  |
| `amd` | AMD | US | y | Advanced Micro Devices |  | amd.com |  |
| `ami` | AMI | US | y | American Megatrends | `AMI` | ami.com | BMC and UEFI firmware |
| `anthropic` | Anthropic | US | y |  |  | anthropic.com | Affected-product vendor only; never an AI-finder match |
| `anyscale` | Anyscale | US | y | Ray-Project, Ray |  | anyscale.com, ray.io |  |
| `apache` | Apache Software Foundation | US | y | Apache | `apache` | apache.org |  |
| `apple` | Apple | US | y |  | `apple` | apple.com |  |
| `arista` | Arista | US | y | Arista Networks | `Arista` | arista.com |  |
| `barracuda` | Barracuda | US | y | Barracuda Networks |  | barracuda.com |  |
| `berriai` | BerriAI | US | y | LiteLLM |  | litellm.ai | LiteLLM |
| `beyondtrust` | BeyondTrust | US | y |  | `BT` | beyondtrust.com |  |
| `broadcom` | Broadcom | US | y | Brocade, CA Technologies, Symantec | `brocade` | broadcom.com |  |
| `cisco` | Cisco | US | y |  | `cisco` | cisco.com |  |
| `citrix` | Citrix | US | y | NetScaler, Cloud Software Group | `Citrix`, `NetScaler` | citrix.com, netscaler.com |  |
| `cleo` | Cleo | US | n |  |  | cleo.com |  |
| `cloudflare` | Cloudflare | US | y |  |  | cloudflare.com |  |
| `commvault` | Commvault | US | n |  |  | commvault.com |  |
| `connectwise` | ConnectWise | US | y |  | `ConnectWise` | connectwise.com |  |
| `crowdstrike` | CrowdStrike | US | y |  |  | crowdstrike.com |  |
| `databricks` | Databricks | US | y | MLflow |  | databricks.com, mlflow.org |  |
| `dell` | Dell | US | y | Dell Technologies | `dell` | dell.com |  |
| `docker` | Docker | US | y |  |  | docker.com |  |
| `elastic` | Elastic | US | y |  |  | elastic.co | Incorporated in the Netherlands, HQ San Francisco |
| `emerson` | Emerson | US | n |  |  | emerson.com |  |
| `extreme` | Extreme Networks | US | n |  |  | extremenetworks.com |  |
| `f5` | F5 | US | y | F5 Networks | `f5` | f5.com |  |
| `fortinet` | Fortinet | US | y |  | `fortinet` | fortinet.com, fortiguard.com |  |
| `fortra` | Fortra | US | y | HelpSystems | `Fortra` | fortra.com | GoAnywhere |
| `github` | GitHub | US | y |  |  | github.blog, docs.github.com | github.com itself is governed by source-tiers github rules |
| `gitlab` | GitLab | US | y |  | `GitLab` | about.gitlab.com, gitlab.com |  |
| `google` | Google | US | y | Android, Chrome, Google Chrome | `Chrome`, `google_android`, `Google_Devices` | google.com, android.com, googleblog.com, chromium.org | CNA Google also assigns for third parties, so it is not listed |
| `grafana` | Grafana Labs | US | y | Grafana |  | grafana.com |  |
| `grandstream` | Grandstream | US | n |  |  | grandstream.com |  |
| `hashicorp` | HashiCorp | US | y |  |  | hashicorp.com |  |
| `honeywell` | Honeywell | US | y |  |  | honeywell.com |  |
| `hp` | HP Inc. | US | y | Hewlett Packard (HP) |  | hp.com |  |
| `hpe` | Hewlett Packard Enterprise | US | y | Hewlett Packard Enterprise (HPE), HPE, Aruba Networks, HPE Aruba Networking | `hpe` | hpe.com, arubanetworks.com |  |
| `hugging-face` | Hugging Face | US | y |  |  | huggingface.co |  |
| `ibm` | IBM | US | y |  | `ibm` | ibm.com |  |
| `intel` | Intel | US | y |  |  | intel.com |  |
| `ivanti` | Ivanti | US | y | Pulse Secure, MobileIron | `ivanti` | ivanti.com |  |
| `juniper` | Juniper Networks | US | y | Juniper | `juniper` | juniper.net | Part of HPE since 2025 |
| `kaseya` | Kaseya | US | y |  |  | kaseya.com |  |
| `kiteworks` | Kiteworks | US | n | Accellion |  | kiteworks.com |  |
| `langchain` | LangChain | US | y |  |  | langchain.com |  |
| `langflow` | Langflow | US | y | DataStax |  | langflow.org |  |
| `lantronix` | Lantronix | US | n |  |  | lantronix.com |  |
| `meta` | Meta | US | y | Meta Platforms, Facebook, WhatsApp | `facebook`, `Meta` | facebook.com/security, whatsapp.com/security |  |
| `microsoft` | Microsoft | US | y |  | `microsoft` | microsoft.com |  |
| `mongodb` | MongoDB | US | y |  | `mongodb` | mongodb.com |  |
| `mozilla` | Mozilla | US | y |  | `mozilla` | mozilla.org |  |
| `n-able` | N-able | US | y |  | `N-able` | n-able.com |  |
| `nagios` | Nagios | US | n |  |  | nagios.com |  |
| `netgear` | NETGEAR | US | y |  |  | netgear.com |  |
| `nvidia` | NVIDIA | US | y |  |  | nvidia.com |  |
| `okta` | Okta | US | y |  |  | okta.com |  |
| `ollama` | Ollama | US | y |  |  | ollama.com |  |
| `openai` | OpenAI | US | y |  |  | openai.com | Affected-product vendor; AI-finder matches use config/ai-finders.json |
| `oracle` | Oracle | US | y |  | `oracle` | oracle.com |  |
| `palo-alto-networks` | Palo Alto Networks | US | y |  | `palo_alto` | paloaltonetworks.com |  |
| `progress` | Progress Software | US | y | Progress, Telerik, Progress Telerik | `ProgressSoftware` | progress.com, telerik.com | MOVEit |
| `ptc` | PTC | US | y |  | `PTC` | ptc.com |  |
| `qlik` | Qlik | US | n |  |  | qlik.com |  |
| `qualcomm` | Qualcomm | US | y |  | `qualcomm` | qualcomm.com |  |
| `red-hat` | Red Hat | US | y |  | `redhat` | redhat.com | CNA redhat also assigns for upstream projects; vendor_confirmed only when the affected vendor is Red Hat |
| `redis` | Redis | US | y |  |  | redis.io |  |
| `rockwell` | Rockwell Automation | US | y | Rockwell |  | rockwellautomation.com |  |
| `salesforce` | Salesforce | US | y |  |  | salesforce.com |  |
| `sentinelone` | SentinelOne | US | y |  |  | sentinelone.com |  |
| `servicenow` | ServiceNow | US | y |  | `SN` | servicenow.com |  |
| `sitecore` | Sitecore | US | n |  |  | sitecore.com |  |
| `solarwinds` | SolarWinds | US | y |  | `SolarWinds` | solarwinds.com |  |
| `sonatype` | Sonatype | US | n |  |  | sonatype.com |  |
| `sonicwall` | SonicWall | US | y |  | `sonicwall` | sonicwall.com |  |
| `splunk` | Splunk | US | y |  |  | splunk.com | Part of Cisco |
| `supermicro` | Supermicro | US | y | Super Micro Computer |  | supermicro.com |  |
| `synacor` | Synacor | US | y | Zimbra |  | synacor.com, zimbra.com | Zimbra |
| `trellix` | Trellix | US | n | McAfee |  | trellix.com |  |
| `ubiquiti` | Ubiquiti | US | y |  |  | ui.com |  |
| `veeam` | Veeam | US | y |  |  | veeam.com |  |
| `veritas` | Veritas | US | n |  |  | veritas.com |  |
| `vmware` | VMware | US | y | VMware Tanzu, VMware by Broadcom | `vmware` | vmware.com | Part of Broadcom |
| `watchguard` | WatchGuard | US | y |  | `WatchGuard` | watchguard.com |  |
| `zoom` | Zoom | US | y | Zoom Video Communications |  | zoom.us, zoom.com |  |
| `curl` | curl | null | y |  |  | curl.se |  |
| `drupal` | Drupal | null | y |  | `drupal` | drupal.org |  |
| `exim` | Exim | null | y |  |  | exim.org |  |
| `git` | Git | null | y |  |  | git-scm.com |  |
| `imagemagick` | ImageMagick | null | y |  |  | imagemagick.org |  |
| `jenkins` | Jenkins | null | y |  | `jenkins` | jenkins.io |  |
| `joomla` | Joomla | null | y |  | `Joomla` | joomla.org | CNA Joomla also assigns for extensions |
| `kubernetes` | Kubernetes | null | y |  |  | kubernetes.io |  |
| `linux` | Linux kernel | null | y | Linux | `Linux` | kernel.org | Kernel CVEs are the Flood's separate band |
| `nodejs` | Node.js | null | y |  |  | nodejs.org |  |
| `openssh` | OpenSSH | null | y | OpenBSD |  | openssh.com, openbsd.org |  |
| `openssl` | OpenSSL | null | y |  |  | openssl.org, openssl-library.org |  |
| `php` | PHP | null | y | PHP Group | `php` | php.net |  |
| `postgresql` | PostgreSQL | null | y |  |  | postgresql.org |  |
| `python` | Python | null | y | Python Software Foundation |  | python.org |  |
| `samba` | Samba | null | y |  |  | samba.org |  |
| `seven-zip` | 7-Zip | null | y |  |  | 7-zip.org |  |
| `sudo` | Sudo | null | y |  |  | sudo.ws |  |
| `vllm` | vLLM | null | y |  |  | vllm.ai |  |

### B.2 `ai-finders.json`

Tested on 2026-11-07 against 12,714 credit strings in recent CVE records and the 448 credit lines of
Anthropic's public disclosure list: every example below behaves as stated, and no credit that names a
person called Claude, a product such as vLLM, or a bare lab name was matched. The test script becomes
`tests/ai-finders.test.ts` (P2).

```json
{
  "schema_version": 1,
  "version": 1,
  "updated": "2026-11-07",
  "fields": [
    "cna.credits",
    "adp.credits",
    "ghsa.credits"
  ],
  "prefilter": "\\b(?:AI|LLMs?|Claude|Mythos|Glasswing|ANT-20\\d\\d|Anthropic|Aardvark|Codex|OpenAI|ChatGPT|Big ?Sleep|CodeMender|DeepMind|Gemini|XBOW|AISLE|depthfirst|ZeroPath|AIxCC|Buttercup|Atlanta|Atlantis|RoboDuck|Vulnhuntr|autonomous)\\b",
  "strip": [
    "\\S+@\\S+",
    "\\b[\\w-]+\\.(?:ai|AI)\\b",
    "\\bClaude (?!Mythos\\b|Code\\b)[A-Z][\\w'’-]+\\b(?! \\d)",
    "\\b[A-Z][a-z]+-Claude\\b",
    "\\b[Hh]untr(?:\\.com|\\.dev)?\\b",
    "\\bProtect ?AI\\b",
    "\\b(?:vLLM|LiteLLM|llama\\.cpp|LangChain|Langflow|Ollama|AutoGPT)\\b",
    "\\bOpenAI[- ](?:Python|Node|SDK|API)\\b"
  ],
  "lab_context": "\\b(?:AI|LLMs?|[Mm]odels?|[Aa]gents?|[Aa]gentic|[Aa]utomated|[Aa]utonomous|[Mm]achine[- ][Ll]earning|[Ss]canner|[Tt]ool|OSS)\\b",
  "finders": [
    {
      "id": "anthropic-claude",
      "name": "Anthropic: Claude, Claude Mythos, Project Glasswing",
      "family": "anthropic",
      "kind": "ai_system",
      "patterns": [
        "\\bClaude\\b(?! Code\\b)",
        "\\bMythos\\b",
        "\\bProject Glasswing\\b"
      ],
      "patterns_case_sensitive": [
        "\\bANT-20\\d\\d-[A-Z0-9]{6,}\\b"
      ],
      "lab_names": [
        "\\bAnthropic\\b"
      ],
      "examples": {
        "match": [
          "Claude (Anthropic)",
          "Claude Mythos Preview",
          "Anthropic's OSS Scanner, as vulnerability ANT-2026-K3J9QX",
          "Claude and Ada Logics",
          "Anthropic OSS program"
        ],
        "no_match": [
          "Claude Dupont of Example Labs",
          "Jean-Claude Martin",
          "Anthropic Research",
          "security@anthropic.com"
        ]
      },
      "note": "Bare 'Anthropic' counts only beside a tool word (lab_context)"
    },
    {
      "id": "anthropic-claude-code",
      "name": "Anthropic: Claude Code used by a researcher",
      "family": "anthropic",
      "kind": "ai_assisted",
      "patterns": [
        "\\bClaude Code\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "Jane Doe, found with Claude Code"
        ],
        "no_match": [
          "Jane Doe"
        ]
      },
      "note": "A flaw in Claude Code is never matched: only credit fields are read"
    },
    {
      "id": "openai-codex",
      "name": "OpenAI: Aardvark, Codex Security",
      "family": "openai",
      "kind": "ai_system",
      "patterns": [
        "\\bAardvark\\b",
        "\\bCodex Security\\b",
        "\\bOpenAI Codex\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [
        "\\bOpenAI\\b"
      ],
      "examples": {
        "match": [
          "OpenAI Codex Security",
          "Aardvark (OpenAI)",
          "OpenAI security research agent"
        ],
        "no_match": [
          "OpenAI Python SDK maintainers",
          "OpenAI Security Research"
        ]
      },
      "note": null
    },
    {
      "id": "openai-chatgpt",
      "name": "OpenAI: ChatGPT used by a researcher",
      "family": "openai",
      "kind": "ai_assisted",
      "patterns": [
        "\\bChatGPT\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "Wei Chen, using ChatGPT"
        ],
        "no_match": [
          "Wei Chen"
        ]
      },
      "note": null
    },
    {
      "id": "google-big-sleep",
      "name": "Google: Big Sleep, CodeMender",
      "family": "google",
      "kind": "ai_system",
      "patterns": [
        "\\bBig ?Sleep\\b",
        "\\bCodeMender\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [
        "\\b(?:Google )?DeepMind\\b"
      ],
      "examples": {
        "match": [
          "Google Big Sleep",
          "Big Sleep (Google Project Zero and Google DeepMind)",
          "Google DeepMind AI agent"
        ],
        "no_match": [
          "Google Project Zero",
          "Google DeepMind"
        ]
      },
      "note": null
    },
    {
      "id": "google-gemini",
      "name": "Google: Gemini used by a researcher",
      "family": "google",
      "kind": "ai_assisted",
      "patterns": [
        "\\b(?:using|with|via|by|and) Gemini\\b",
        "\\bGemini (?:CLI|Code Assist)\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "Ana Silva, with Gemini"
        ],
        "no_match": [
          "Gemini Trust security team"
        ]
      },
      "note": null
    },
    {
      "id": "xbow",
      "name": "XBOW",
      "family": "other",
      "kind": "ai_system",
      "patterns": [
        "\\bXBOW\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "XBOW",
          "https://github.com/xbow-security"
        ],
        "no_match": [
          "crossbow"
        ]
      },
      "note": null
    },
    {
      "id": "aisle",
      "name": "AISLE",
      "family": "other",
      "kind": "ai_system",
      "patterns": [],
      "patterns_case_sensitive": [
        "\\bAISLE\\b"
      ],
      "lab_names": [],
      "examples": {
        "match": [
          "AISLE Research"
        ],
        "no_match": [
          "Aisle Smith"
        ]
      },
      "note": "Case-sensitive: 'aisle' is an ordinary word"
    },
    {
      "id": "depthfirst",
      "name": "depthfirst",
      "family": "other",
      "kind": "ai_system",
      "patterns": [
        "\\bdepthfirst\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "depthfirst"
        ],
        "no_match": [
          "depth first search"
        ]
      },
      "note": null
    },
    {
      "id": "zeropath",
      "name": "ZeroPath",
      "family": "other",
      "kind": "ai_system",
      "patterns": [
        "\\bZeroPath\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "ZeroPath"
        ],
        "no_match": [
          "zero path traversal"
        ]
      },
      "note": null
    },
    {
      "id": "aixcc",
      "name": "DARPA AIxCC systems (Team Atlanta, Buttercup, RoboDuck)",
      "family": "other",
      "kind": "ai_system",
      "patterns": [
        "\\bAIxCC\\b",
        "\\bTeam Atlanta\\b",
        "\\bAtlantis[- ]CRS\\b",
        "\\bButtercup\\b",
        "\\bRoboDuck\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "Team Atlanta (AIxCC)",
          "Buttercup CRS"
        ],
        "no_match": [
          "Atlanta, GA"
        ]
      },
      "note": null
    },
    {
      "id": "vulnhuntr",
      "name": "Vulnhuntr",
      "family": "other",
      "kind": "ai_assisted",
      "patterns": [
        "\\bVulnhuntr\\b"
      ],
      "patterns_case_sensitive": [],
      "lab_names": [],
      "examples": {
        "match": [
          "found with Vulnhuntr"
        ],
        "no_match": [
          "huntr.dev"
        ]
      },
      "note": null
    },
    {
      "id": "generic-ai-assisted",
      "name": "Other credits that say AI or an LLM was used",
      "family": "other",
      "kind": "ai_assisted",
      "patterns": [],
      "patterns_case_sensitive": [
        "\\bAI[- ](?:[Aa]ssisted|[Pp]owered|[Dd]riven|[Bb]ased|[Aa]ugmented)\\b",
        "\\b(?:[Uu]sing|[Ww]ith|[Vv]ia|[Bb]y) (?:an? )?(?:AI|LLMs?)\\b",
        "\\bLLM[- ](?:assisted|based|powered|driven)\\b",
        "\\bAI (?:[Aa]gents?|[Tt]ools?|[Ss]canners?)\\b",
        "\\b[Aa]utonomous (?:AI|[Aa]gents?)\\b"
      ],
      "lab_names": [],
      "examples": {
        "match": [
          "Kim Lee (AI-assisted)",
          "found using an LLM",
          "Example Corp AI agent"
        ],
        "no_match": [
          "reported by Ai Tanaka",
          "Protect AI",
          "vLLM maintainers",
          "huntr"
        ]
      },
      "note": "Last: a named finder above always wins"
    }
  ]
}
```

Verify in P2: the AI security vendors active by then (re-read the year's AI-found CVE credits and add
any new finder before the backfill), and whether GitHub advisory credits use names or logins.

### B.3 `source-tiers.json`

`sole_newsroom_for_critical` is `true` for every publisher except where the note says otherwise.
Vendor advisory domains from B.1 are implicit tier 1 publishers and are not repeated here.

**Tier 1: registries and data**

| id | name | kind | country | domains |
|---|---|---|---|---|
| `cve-org` | CVE Program | other | US | cve.org, cve.mitre.org |
| `nvd` | NIST NVD | government | US | nvd.nist.gov |
| `cisa-kev` | CISA KEV catalog | government | US | cisa.gov/known-exploited-vulnerabilities-catalog |
| `github-advisories` | GitHub Advisory Database | other | US | github.com (paths in `github.tier1_paths` only) |
| `osv` | OSV | other | US | osv.dev |
| `first-epss` | FIRST EPSS | other | US | first.org/epss, api.first.org |

**Tier 1: governments, CERTs and regulators**

| id | name | kind | country | domains |
|---|---|---|---|---|
| `cisa` | CISA | government | US | cisa.gov |
| `cert-cc` | CERT/CC | cert | US | kb.cert.org |
| `fbi` | FBI | government | US | fbi.gov, ic3.gov |
| `doj` | US Department of Justice | government | US | justice.gov |
| `treasury` | US Treasury | government | US | treasury.gov |
| `state-dept` | US State Department | government | US | state.gov |
| `white-house` | The White House | government | US | whitehouse.gov |
| `nsa` | NSA | government | US | nsa.gov |
| `dod` | US Department of Defense | government | US | defense.gov |
| `nist` | NIST | government | US | nist.gov |
| `sec` | US SEC | regulator | US | sec.gov |
| `ftc` | US FTC | regulator | US | ftc.gov |
| `cert-eu` | CERT-EU | cert | null | cert.europa.eu |
| `enisa` | ENISA | government | null | enisa.europa.eu |
| `eu` | European Union institutions | government | null | europa.eu |
| `ncsc-uk` | NCSC (UK) | cert | GB | ncsc.gov.uk |
| `uk-gov` | UK government | government | GB | gov.uk |
| `ico` | UK ICO | regulator | GB | ico.org.uk |
| `bsi` | BSI | cert | DE | bsi.bund.de |
| `anssi` | ANSSI and CERT-FR | cert | FR | cyber.gouv.fr, ssi.gouv.fr |
| `ncsc-nl` | NCSC-NL | cert | NL | ncsc.nl |
| `cnil` | CNIL | regulator | FR | cnil.fr |
| `acsc` | ACSC | cert | AU | cyber.gov.au |
| `cccs` | Canadian Centre for Cyber Security | cert | CA | cyber.gc.ca |
| `ncsc-nz` | NCSC (New Zealand) | cert | NZ | ncsc.govt.nz |
| `twcert` | TWCERT/CC | cert | TW | twcert.org.tw |
| `moda-acs` | Ministry of Digital Affairs and its Administration for Cyber Security (資安署) | government | TW | moda.gov.tw |
| `nics` | National Institute of Cyber Security | cert | TW | nics.nat.gov.tw |
| `nsb` | National Security Bureau | government | TW | nsb.gov.tw |
| `mjib` | Investigation Bureau (MJIB) | government | TW | mjib.gov.tw |
| `ey` | Executive Yuan | government | TW | ey.gov.tw |
| `president-tw` | Office of the President | government | TW | president.gov.tw |
| `mnd` | Ministry of National Defense | government | TW | mnd.gov.tw |
| `mac` | Mainland Affairs Council | government | TW | mac.gov.tw |
| `cec` | Central Election Commission | government | TW | cec.gov.tw |
| `ncc-tw` | National Communications Commission | regulator | TW | ncc.gov.tw |
| `mops` | TWSE and TPEx material information (MOPS) | regulator | TW | mops.twse.com.tw, twse.com.tw, tpex.org.tw |
| `jpcert` | JPCERT/CC | cert | JP | jpcert.or.jp |
| `jvn` | JVN | cert | JP | jvn.jp |
| `ipa` | IPA | government | JP | ipa.go.jp |
| `nco-jp` | National Cybersecurity Office (国家サイバー統括室) | government | JP | cyber.go.jp, nisc.go.jp |
| `npa` | National Police Agency | government | JP | npa.go.jp |
| `meti` | METI | government | JP | meti.go.jp |
| `mic-jp` | Ministry of Internal Affairs and Communications | government | JP | soumu.go.jp |
| `mofa-jp` | Ministry of Foreign Affairs | government | JP | mofa.go.jp |
| `kantei` | Prime Minister's Office | government | JP | kantei.go.jp |
| `mod-jp` | Ministry of Defense | government | JP | mod.go.jp |
| `tdnet` | TDnet timely disclosure | regulator | JP | release.tdnet.info |

**Tier 1, labelled: PRC state sources.** Cited only for what the PRC government says, and always with
`state_label` "PRC state source" beside the citation.

| id | name | kind | country | domains |
|---|---|---|---|---|
| `cverc` | CVERC (National Computer Virus Emergency Response Center) | government | CN | cverc.org.cn |
| `prc-mfa` | PRC Ministry of Foreign Affairs | government | CN | fmprc.gov.cn, mfa.gov.cn |
| `prc-mps` | PRC Ministry of Public Security | government | CN | mps.gov.cn |
| `prc-cac` | Cyberspace Administration of China | government | CN | cac.gov.cn |

Verify in P2: the National Cybersecurity Office's domain (it replaced NISC in July 2025), the
Administration for Cyber Security's pages under moda.gov.tw, the TDnet host, and CVERC's domain.

**Tier 1: original research.** A lab's write-up about its own AI system's findings is a
`finder_writeup` and makes the claim `self_reported` (§4.2).

| id | name | country | domains |
|---|---|---|---|
| `mandiant` | Mandiant and Google Threat Intelligence | US | mandiant.com, cloud.google.com/blog/topics/threat-intelligence |
| `google-tag` | Google Threat Analysis Group | US | blog.google/threat-analysis-group |
| `project-zero` | Google Project Zero | US | googleprojectzero.blogspot.com, projectzero.google |
| `google-security` | Google Security Blog | US | security.googleblog.com |
| `deepmind` | Google DeepMind | GB | deepmind.google |
| `microsoft-threat-intel` | Microsoft Threat Intelligence | US | microsoft.com/en-us/security/blog |
| `unit42` | Unit 42 | US | unit42.paloaltonetworks.com |
| `volexity` | Volexity | US | volexity.com |
| `citizen-lab` | Citizen Lab | CA | citizenlab.ca |
| `eset-research` | ESET Research | SK | welivesecurity.com |
| `securelist` | Kaspersky GReAT | RU | securelist.com |
| `talos` | Cisco Talos | US | talosintelligence.com |
| `recorded-future` | Recorded Future Insikt | US | recordedfuture.com |
| `proofpoint` | Proofpoint | US | proofpoint.com |
| `check-point-research` | Check Point Research | IL | research.checkpoint.com |
| `wiz` | Wiz Research | US | wiz.io |
| `rapid7` | Rapid7 | US | rapid7.com |
| `horizon3` | Horizon3.ai | US | horizon3.ai |
| `watchtowr` | watchTowr Labs | SG | labs.watchtowr.com, watchtowr.com |
| `greynoise` | GreyNoise | US | greynoise.io |
| `shadowserver` | Shadowserver | US | shadowserver.org |
| `censys` | Censys | US | censys.com |
| `vulncheck` | VulnCheck | US | vulncheck.com |
| `huntress` | Huntress | US | huntress.com |
| `arctic-wolf` | Arctic Wolf | US | arcticwolf.com |
| `eclecticiq` | EclecticIQ | NL | eclecticiq.com |
| `sekoia` | Sekoia | FR | sekoia.io |
| `group-ib` | Group-IB | SG | group-ib.com |
| `dragos` | Dragos | US | dragos.com |
| `claroty` | Claroty Team82 | US | claroty.com |
| `nozomi` | Nozomi Networks Labs | US | nozominetworks.com |
| `forescout` | Forescout | US | forescout.com |
| `zscaler` | Zscaler ThreatLabz | US | zscaler.com/blogs/security-research |
| `elastic-labs` | Elastic Security Labs | US | elastic.co/security-labs |
| `sentinel-labs` | SentinelLABS | US | sentinelone.com/labs |
| `trend-research` | Trend Micro Research | JP | trendmicro.com/en_us/research |
| `sophos-xops` | Sophos X-Ops | GB | news.sophos.com |
| `symantec` | Symantec Threat Hunter Team | US | security.com |
| `trail-of-bits` | Trail of Bits | US | blog.trailofbits.com |
| `lab52` | Lab52 | ES | lab52.io |
| `teamt5` | TeamT5 | TW | teamt5.org |
| `cycraft` | CyCraft | TW | cycraft.com |
| `anthropic` | Anthropic | US | anthropic.com, red.anthropic.com |
| `openai` | OpenAI | US | openai.com |
| `xbow` | XBOW | US | xbow.com |
| `aisle` | AISLE | US | aisle.com |

All rows have `tier` 1 and `kind` `research`. Verify in P2: the AISLE and XBOW domains.

**Tier 2: newsrooms doing their own reporting**

| id | name | country | domains |
|---|---|---|---|
| `the-record` | The Record | US | therecord.media |
| `bleepingcomputer` | BleepingComputer | US | bleepingcomputer.com |
| `securityweek` | SecurityWeek | US | securityweek.com |
| `krebs` | Krebs on Security | US | krebsonsecurity.com |
| `reuters` | Reuters | GB | reuters.com |
| `ap` | Associated Press | US | apnews.com |
| `techcrunch` | TechCrunch | US | techcrunch.com |
| `cyberscoop` | CyberScoop | US | cyberscoop.com |
| `dark-reading` | Dark Reading | US | darkreading.com |
| `the-register` | The Register | GB | theregister.com |
| `ars-technica` | Ars Technica | US | arstechnica.com |
| `wired` | Wired | US | wired.com |
| `404-media` | 404 Media | US | 404media.co |
| `risky-biz` | Risky Business | AU | risky.biz |
| `the-hacker-news` | The Hacker News | US | thehackernews.com (`sole_newsroom_for_critical` false) |
| `sc-media` | SC Media | US | scworld.com |
| `infosecurity` | Infosecurity Magazine | GB | infosecurity-magazine.com |
| `help-net` | Help Net Security | HR | helpnetsecurity.com |
| `cso` | CSO Online | US | csoonline.com |
| `zdnet` | ZDNET | US | zdnet.com |
| `bloomberg` | Bloomberg | US | bloomberg.com |
| `ft` | Financial Times | GB | ft.com |
| `wsj` | The Wall Street Journal | US | wsj.com |
| `nyt` | The New York Times | US | nytimes.com |
| `wapo` | The Washington Post | US | washingtonpost.com |
| `bbc` | BBC | GB | bbc.com, bbc.co.uk |
| `guardian` | The Guardian | GB | theguardian.com |
| `politico` | Politico | US | politico.com, politico.eu |
| `axios` | Axios | US | axios.com |
| `cnbc` | CNBC | US | cnbc.com |
| `euractiv` | Euractiv | BE | euractiv.com |
| `heise` | heise online | DE | heise.de |
| `le-monde` | Le Monde | FR | lemonde.fr |
| `spiegel` | Der Spiegel | DE | spiegel.de |
| `cna` | 中央社 Central News Agency and Focus Taiwan (CNA English) | TW | cna.com.tw, focustaiwan.tw |
| `taipei-times` | Taipei Times | TW | taipeitimes.com |
| `ithome` | iThome | TW | ithome.com.tw |
| `udn` | 聯合報 United Daily News | TW | udn.com |
| `ltn` | 自由時報 Liberty Times | TW | ltn.com.tw |
| `rti` | Radio Taiwan International | TW | rti.org.tw |
| `pts` | 公視 Public Television Service | TW | pts.org.tw |
| `the-reporter` | 報導者 The Reporter | TW | twreporter.org |
| `commonwealth` | 天下雜誌 CommonWealth | TW | cw.com.tw |
| `digitimes` | DIGITIMES | TW | digitimes.com, digitimes.com.tw |
| `nhk` | NHK | JP | nhk.or.jp |
| `nikkei` | Nikkei | JP | nikkei.com |
| `japan-times` | The Japan Times | JP | japantimes.co.jp |
| `kyodo` | Kyodo News | JP | kyodonews.net, kyodonews.jp |
| `asahi` | 朝日新聞 Asahi Shimbun | JP | asahi.com |
| `yomiuri` | 読売新聞 Yomiuri Shimbun | JP | yomiuri.co.jp |
| `mainichi` | 毎日新聞 Mainichi Shimbun | JP | mainichi.jp |
| `jiji` | 時事通信 Jiji Press | JP | jiji.com |
| `itmedia` | ITmedia | JP | itmedia.co.jp |
| `security-next` | Security NEXT | JP | security-next.com |
| `scmp` | South China Morning Post | HK | scmp.com |

All rows have `tier` 2 and `kind` `newsroom`. Focus Taiwan is CNA's English service, so both domains
are one publisher (§4.12 Publishers).

**Tier 3: never cited for facts**

| id | domains | kind | state_label |
|---|---|---|---|
| `portal-msn` | msn.com | aggregator | |
| `portal-yahoo` | yahoo.com | aggregator | |
| `medium` | medium.com | social | |
| `substack` | substack.com | social | |
| `dev-to` | dev.to | social | |
| `linkedin` | linkedin.com | social | |
| `x` | x.com, twitter.com | social | |
| `reddit` | reddit.com | social | |
| `facebook` | facebook.com | social | |
| `youtube` | youtube.com | social | |
| `mastodon` | mastodon.social, infosec.exchange | social | |
| `bluesky` | bsky.app | social | |
| `gbhackers` | gbhackers.com | aggregator | |
| `cybersecuritynews` | cybersecuritynews.com | aggregator | |
| `securityaffairs` | securityaffairs.com | aggregator | |
| `cyberpress` | cyberpress.org | aggregator | |
| `cyber-express` | thecyberexpress.com | aggregator | |
| `hackread` | hackread.com | aggregator | |
| `vulners` | vulners.com | aggregator | |
| `cvefeed` | cvefeed.io | aggregator | |
| `feedly` | feedly.com | aggregator | |
| `opencve` | opencve.io | aggregator | |
| `vuldb` | vuldb.com | aggregator | |
| `databreaches` | databreaches.net | aggregator | |
| `xinhua` | news.cn, xinhuanet.com | state_media | PRC state media |
| `global-times` | globaltimes.cn | state_media | PRC state media |
| `cgtn` | cgtn.com | state_media | PRC state media |
| `tass` | tass.com, tass.ru | state_media | Russian state media |
| `rt` | rt.com | state_media | Russian state media |

**Blocked: `BLOCKED_HOSTS` in `lib/vocab.ts` (§4.2).** Not part of `source-tiers.json`; listed here so
the seed lists sit together. Never in any draft or brief field (`NO_EXPLOIT_LINK`, `SOURCE_URL`), never
fetched, and dropped by collect. A host entry matches the host and every subdomain; an entry with a path
matches that host and path prefix; `.onion` and `.i2p` match any host ending so. The agent's deny list
holds both forms of every host entry, `domain:<host>` and `domain:*.<host>`, plus `*.onion` and `*.i2p`
(§9.5).

| pattern | reason |
|---|---|
| exploit-db.com, packetstormsecurity.com, packetstorm.news, sploitus.com, 0day.today, cxsecurity.com | `exploit_code` |
| gitlab.com, bitbucket.org, codeberg.org, sourceforge.net, huggingface.co (code hosts; `github.com` is limited to `github.tier1_paths` instead, below) | `exploit_code` |
| pastebin.com, paste.ee, pastes.io, hastebin.com, justpaste.it, privatebin.net, controlc.com, rentry.co, gist.github.com, gist.githubusercontent.com, raw.githubusercontent.com, objects.githubusercontent.com, codeload.github.com | `paste` |
| t.me, telegram.me, telegram.org, discord.gg | `messaging` |
| bit.ly, tinyurl.com, t.co, goo.gl, ow.ly, is.gd, buff.ly, rebrand.ly, cutt.ly, shorturl.at, rb.gy, tiny.cc, s.id, lnkd.in | `shortener` |
| news.google.com, google.com/url, l.facebook.com, out.reddit.com, href.li | `redirect` |
| archive.org (web.archive.org included), archive.ph, archive.today, archive.is, ghostarchive.org | `archive` |
| ransomware.live, ransomlook.io, `.onion`, `.i2p` | `leak_site` |
| shodan.io/search, search.censys.io, fofa.info, zoomeye.org | `scan_query` |

The one exception: collect fetches the KEV mirror and CVE List V5 from `raw.githubusercontent.com` by
script only (§4.13); briefs cite those records by their canonical URLs (cve.org, cisa.gov), never the
raw URL.

`github.tier1_paths`: `^/advisories/GHSA-[\w-]+`, `^/[^/]+/[^/]+/security/advisories/GHSA-[\w-]+`,
`^/CVEProject/`, `^/cisagov/`, `^/github/advisory-database/`.

### B.4 `regions.json`

`EU` covers the EU 27, the other EEA states (Iceland, Liechtenstein, Norway), Switzerland and the UK,
matching the agencies the design names. Ukraine and the other candidate states are left out so that a
steady war-time signal does not hold the row at Elevated; their incidents still appear as items.

```json
{
  "schema_version": 1,
  "version": 1,
  "updated": "2026-11-07",
  "review_due": "2026-12-02",
  "regions": [
    {
      "code": "US",
      "countries": ["US"],
      "agencies": ["cisa"],
      "alert_patterns": ["cisa\\.gov/news-events/directives/ed-\\d"],
      "certs": [],
      "home_vendor_country": null
    },
    {
      "code": "EU",
      "countries": ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
        "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "CH", "GB"],
      "agencies": ["cert-eu", "ncsc-uk", "bsi", "anssi"],
      "alert_patterns": ["cert\\.ssi\\.gouv\\.fr/alerte/CERTFR-\\d{4}-ALE-\\d+"],
      "certs": [],
      "home_vendor_country": null
    },
    {
      "code": "TW",
      "countries": ["TW"],
      "agencies": ["moda-acs", "twcert", "nsb", "mjib"],
      "alert_patterns": [],
      "certs": ["twcert"],
      "home_vendor_country": "TW"
    },
    {
      "code": "JP",
      "countries": ["JP"],
      "agencies": ["nco-jp", "jpcert"],
      "alert_patterns": ["jpcert\\.or\\.jp/at/\\d{4}/at\\d+"],
      "certs": ["jpcert"],
      "home_vendor_country": "JP"
    }
  ],
  "rules": [
    {
      "id": "cni-disruption",
      "type": "confirmed_disruption",
      "level": "critical",
      "regions": ["US", "EU", "TW", "JP"],
      "params": { "lookback_hours": 72, "min_publishers": 2, "sectors": ["government", "defence", "energy", "water", "transport", "telecom", "health", "finance"], "statuses": ["confirmed"], "min_severity": null, "max_lag_days": null },
      "reason": "Confirmed disruption of {sector} in {country}: {headline}",
      "label": "Government or critical infrastructure disrupted"
    },
    {
      "id": "agency-alert",
      "type": "agency_alert",
      "level": "high",
      "regions": ["US", "EU", "TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": null, "min_severity": null, "max_lag_days": null },
      "reason": "{publisher} emergency alert: {title}",
      "label": "National agency emergency alert"
    },
    {
      "id": "high-breach",
      "type": "confirmed_breach",
      "level": "high",
      "regions": ["US", "EU", "TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": ["confirmed"], "min_severity": "high", "max_lag_days": null },
      "reason": "Confirmed breach in {country}: {headline}",
      "label": "Confirmed High or Critical breach of a victim in the region"
    },
    {
      "id": "serious-victim",
      "type": "victim_in_region",
      "level": "elevated",
      "regions": ["US", "EU", "TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": ["confirmed", "reported"], "min_severity": "high", "max_lag_days": null },
      "reason": "Victim in {country}: {headline}",
      "label": "High or Critical item whose victim is in the region"
    },
    {
      "id": "campaign-target",
      "type": "campaign_target",
      "level": "elevated",
      "regions": ["US", "EU", "TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": null, "min_severity": null, "max_lag_days": null },
      "reason": "Campaign naming the region: {headline}",
      "label": "Campaign that names the region as a target"
    },
    {
      "id": "home-vendor-kev",
      "type": "home_vendor_kev",
      "level": "elevated",
      "regions": ["TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": null, "min_severity": null, "max_lag_days": 365 },
      "reason": "CISA listed a {vendor} flaw as exploited: {cve}",
      "label": "KEV addition for a home vendor's flaw published within a year"
    },
    {
      "id": "home-cert-exploitation",
      "type": "national_cert_exploitation",
      "level": "elevated",
      "regions": ["TW", "JP"],
      "params": { "lookback_hours": 168, "min_publishers": null, "sectors": null, "statuses": null, "min_severity": null, "max_lag_days": null },
      "reason": "{publisher} reports exploitation at home: {title}",
      "label": "National CERT reports exploitation at home"
    }
  ],
  "editor_raise": { "max_steps": 1, "max_per_region": 1 }
}
```

Verify in P2: the emergency-alert URL patterns for CERT-EU, NCSC UK, BSI, the Administration for Cyber
Security, TWCERT, NSB, MJIB and the National Cybersecurity Office. Add each to `alert_patterns` only
once a real alert page matches it and an ordinary advisory page does not; until then those agencies
cannot fire `agency-alert`, and the Methodology page says so.

### B.5 `annotations.json`

```json
{
  "schema_version": 1,
  "annotations": [
    {
      "id": "nvd-scoring-stop",
      "date": "2026-04-15",
      "end_date": null,
      "label": "NVD stops scoring most CVEs",
      "detail": "NIST's NVD stops adding its own scores to most new CVE records; the CNA's and CISA's scores are used instead.",
      "panels": ["flood", "window"],
      "kind": "data_change",
      "source_url": "https://nvd.nist.gov/general/news"
    },
    {
      "id": "us-kev-three-day-deadline",
      "date": "2026-06-10",
      "end_date": null,
      "label": "US 3-day deadline for worst KEV flaws",
      "detail": "US federal agencies must fix the most severe newly listed KEV flaws within three days. A policy marker, not a defender series.",
      "panels": ["window"],
      "kind": "policy",
      "source_url": "https://www.cisa.gov/news-events/directives"
    },
    {
      "id": "kernel-batch-2026-07",
      "date": "2026-07-19",
      "end_date": "2026-07-20",
      "label": "Linux kernel batch",
      "detail": "The Linux kernel CNA published a batch of about 430 CVE records over two days.",
      "panels": ["flood", "window"],
      "kind": "data_change",
      "source_url": null
    }
  ]
}
```

Verify in P2: the NVD notice and its URL; the US directive that set the three-day deadline, its number,
date and page; the kernel batch's exact dates and count from `state/days.json`. Add `glasswing-launch`
(kind `event`, panels `ai` and `window`) once its date is confirmed from Anthropic's announcement.

### B.6 `actors.json`

Every alias cites the MITRE ATT&CK group page in `mitre_id` (`https://attack.mitre.org/groups/<id>/`),
which lists the naming vendors' mappings with references. Entries without a `mitre_id` start with no
aliases. `actors.json` holds no nexus (§4.11).

| id | name | mitre_id | aliases (by) | related_tracker | note |
|---|---|---|---|---|---|
| `volt-typhoon` | Volt Typhoon | G1017 | BRONZE SILHOUETTE (Secureworks), Vanguard Panda (CrowdStrike), VOLTZITE (Dragos), Insidious Taurus (Palo Alto Networks) | | |
| `salt-typhoon` | Salt Typhoon | | | | Aliases only with a cited mapping |
| `flax-typhoon` | Flax Typhoon | | | | Named by Microsoft and the FBI for a Taiwan-focused botnet operation |
| `silk-typhoon` | Silk Typhoon | G0125 | HAFNIUM (Microsoft, former name) | | |
| `apt27` | APT27 | G0027 | Emissary Panda (CrowdStrike), BRONZE UNION (Secureworks), LuckyMouse (Kaspersky), Iron Tiger (Trend Micro) | | |
| `apt41` | APT41 | G0096 | Wicked Panda (CrowdStrike), BARIUM (Microsoft, former name), Brass Typhoon (Microsoft) | | |
| `apt40` | APT40 | G0065 | Leviathan (Proofpoint), TEMP.Periscope (Mandiant), Kryptonite Panda (CrowdStrike), Gingham Typhoon (Microsoft) | | |
| `apt10` | APT10 | G0045 | menuPass, Stone Panda (CrowdStrike), POTASSIUM (Microsoft, former name), Cicada (Symantec) | | Long-running activity against Japan |
| `mustang-panda` | Mustang Panda | G0129 | TA416 (Proofpoint), RedDelta (Recorded Future), BRONZE PRESIDENT (Secureworks) | | |
| `blacktech` | BlackTech | G0098 | Palmerworm (Symantec), Circuit Panda (CrowdStrike) | | Subject of a 2023 US and Japan joint advisory |
| `tropic-trooper` | Tropic Trooper | G0081 | Pirate Panda (CrowdStrike), KeyBoy | | Long-running activity against Taiwan |
| `apt28` | APT28 | G0007 | Fancy Bear (CrowdStrike), Forest Blizzard (Microsoft), STRONTIUM (Microsoft, former name), Sofacy (Kaspersky) | europe | |
| `apt29` | APT29 | G0016 | Cozy Bear (CrowdStrike), Midnight Blizzard (Microsoft), NOBELIUM (Microsoft, former name) | europe | |
| `sandworm` | Sandworm | G0034 | APT44 (Mandiant), Seashell Blizzard (Microsoft), Voodoo Bear (CrowdStrike) | europe | |
| `turla` | Turla | G0010 | Secret Blizzard (Microsoft), Venomous Bear (CrowdStrike), Snake | europe | |
| `noname057-16` | NoName057(16) | | | europe | DDoS group |
| `lazarus` | Lazarus Group | G0032 | HIDDEN COBRA (US government), Diamond Sleet (Microsoft), Labyrinth Chollima (CrowdStrike) | | |
| `kimsuky` | Kimsuky | G0094 | Emerald Sleet (Microsoft), Velvet Chollima (CrowdStrike), THALLIUM (Microsoft, former name) | | |
| `dprk-it-workers` | North Korean IT workers | | | | Aliases only with a cited mapping |
| `apt35` | APT35 | G0059 | Magic Hound, Charming Kitten, Mint Sandstorm (Microsoft), PHOSPHORUS (Microsoft, former name) | me | |
| `muddywater` | MuddyWater | G0069 | Mango Sandstorm (Microsoft), MERCURY (Microsoft, former name), Seedworm (Symantec), Static Kitten (CrowdStrike) | me | |
| `cyberav3ngers` | CyberAv3ngers | | | me | Targets internet-exposed industrial controllers |
| `scattered-spider` | Scattered Spider | G1015 | UNC3944 (Mandiant), Octo Tempest (Microsoft), 0ktapus (Group-IB) | | |
| `lockbit` | LockBit | | | | Ransomware brand |
| `cl0p` | Cl0p | | | | Ransomware brand |

Verify in P5: each alias appears on its cited MITRE page; drop any that does not. Keep `related_tracker`
only where the sibling's site covers the actor (Claude reads the sites and says so in the P5 PR).

### B.7 `watch-windows.json`

```json
{
  "schema_version": 1,
  "windows": [
    {
      "id": "taiwan-local-elections-2026",
      "title": "Taiwan local elections, 28 November 2026",
      "start": "2026-11-08",
      "end": "2026-12-05",
      "regions": ["TW"],
      "lens_row": "influence_ops",
      "search_terms": [
        "Taiwan local elections cyber",
        "Taiwan election disinformation",
        "Central Election Commission Taiwan cyberattack",
        "九合一 資安",
        "選舉 認知作戰",
        "選舉 假訊息",
        "中選會 網路攻擊",
        "台湾 統一地方選挙 サイバー"
      ],
      "note": "Ends a week after polling day to catch post-election claims"
    }
  ]
}
```

This window lands in P5 (`p5-golive`); until then `config/watch-windows.json` holds an empty `windows`
list. Verify before P5: the polling date of 2026-11-28 against the Central Election Commission.

### B.8 `standing-stories.json`

```json
{
  "schema_version": 1,
  "stories": [
    {
      "id": "salt-typhoon",
      "title": "Salt Typhoon and the telecom intrusions",
      "summary": "A PRC-attributed group named by US agencies and vendors for long-running intrusions into telecom carriers, including lawful-intercept systems. New victims, advisories and indictments are developments; recaps are not.",
      "regions": ["US", "EU", "TW", "JP", "GLOBAL"],
      "topics": ["telecom"],
      "actors": ["salt-typhoon"],
      "match_terms": ["Salt Typhoon", "telecom intrusion", "lawful intercept"],
      "seed_last_development": null,
      "seed_source_url": null
    },
    {
      "id": "volt-typhoon",
      "title": "Volt Typhoon and pre-positioning in critical infrastructure",
      "summary": "A PRC-attributed group that US and allied agencies say pre-positions in critical infrastructure networks, including near US bases relevant to a Taiwan contingency.",
      "regions": ["US", "TW", "JP", "GLOBAL"],
      "topics": ["ot_cni", "government"],
      "actors": ["volt-typhoon"],
      "match_terms": ["Volt Typhoon", "Vanguard Panda", "VOLTZITE", "pre-positioning"],
      "seed_last_development": null,
      "seed_source_url": null
    },
    {
      "id": "dprk-it-workers",
      "title": "North Korean IT workers",
      "summary": "North Korean workers who take remote IT jobs under false identities to earn revenue for the state and sometimes steal data or extort employers. New indictments, sanctions and victim disclosures are developments.",
      "regions": ["US", "EU", "JP", "GLOBAL"],
      "topics": ["illicit_finance"],
      "actors": ["dprk-it-workers"],
      "match_terms": ["North Korean IT workers", "DPRK IT workers", "Famous Chollima", "Jasper Sleet", "laptop farm"],
      "seed_last_development": null,
      "seed_source_url": null
    },
    {
      "id": "taiwan-undersea-cables",
      "title": "Damage to Taiwan's undersea cables",
      "summary": "Repeated cuts to cables serving Taiwan and its outlying islands, some involving PRC-linked vessels. New incidents, prosecutions and resilience measures are developments.",
      "regions": ["TW"],
      "topics": ["undersea_cable", "telecom"],
      "actors": [],
      "match_terms": ["undersea cable Taiwan", "海纜", "海底電纜", "Matsu cable", "Penghu cable"],
      "seed_last_development": null,
      "seed_source_url": null
    }
  ]
}
```

The seed dates are `null`: the first item tagged with a story sets its last development (§4.11). P5
fills `seed_last_development` and `seed_source_url` from a cited source for any story that should show
an older date before then.

### B.9 `run.json`

Committed as `config/run.json` (Foundation PR, SPEC v2.0 §4.11). It is the live file, not a seed.

### B.10 `claims.json`

`config/claims.json` lands in P1 as `{"schema_version":1,"version":0,"claims":[]}`, and the approved seed
(version 1) replaces it in the P5 PR, where JL approves it once. Until then tests, fixtures and
`fixtures/site-content/` load `fixtures/config/claims.json` (SB-01 and SB-02 below, marked SAMPLE). Claude drafts 4 to 6 claims from JL's
published predictions (`origin: "jl"`), each with `restates` holding a verbatim quote of at most 25
words, its title, URL and date. No JL claim is drafted before P5, so none is invented here. The two
rival claims below are defaults; P5 fills `restates` from the sources named, or replaces the claim if
no source states it.

| id | text | judged_by | metric_path | support | challenge | deadline | restates (to find in P5) |
|---|---|---|---|---|---|---|---|
| `SB-01` | AI-credited flaws reach CISA's exploited list no more often than other flaws: most AI-found bugs are low-impact. | script | `base_rate.ratio` | `ci80_hi` `<=` 1.0 | `ci80_lo` `>=` 2.0 | 2027-12-31 | A published sceptic's statement that AI-found bugs are mostly low-impact |
| `SB-02` | By the end of 2028, AI-powered malware is used in an attack on UK critical national infrastructure, as the UK government or the NCSC publicly confirms. | report | | event: the UK government or the NCSC states that an attack on UK critical infrastructure used AI-powered malware | event: the UK government or the NCSC states that a claimed AI-powered attack on UK critical infrastructure did not use AI-powered malware | 2028-12-31 | NCSC UK, 'Artificial intelligence and cyber intrusion', 3 Nov 2026, https://ncsc.gov.uk/report/artificial-intelligence-and-cyber-intrusion (P5 matches the wording to the report's key judgement, which the review quotes as a ransomware attack on UK CNI) |

Both rival claims have `origin: "rival"`, `opened` set to the P5 merge date and `stated_probability`
`null`. `SB-03` onward are JL's.

---

