// TWSE and TPEx material-information notices (SPEC §4.13 `exchange-tw`): the OpenAPI JSON arrays, keyless.
// TWSE (t187ap04_L) and TPEx (mopsfin_t187ap04_O) name the code and company columns differently and TWSE
// writes `主旨 ` with a trailing space (Kobol, 2026-11-09), so keys are trimmed and both spellings read.
// Dates are ROC (year + 1911) in Taipei time. The parser keeps every notice; collect sanitises the text
// and keeps those that hit EXCHANGE_TERMS (hitsExchangeTerms()). Every string is raw feed data.

import { z } from "zod";
import { isValidDate } from "../dates";
import { sha256Hex } from "../json";
import { FeedParseError, type ExchangeNotice, type Parsed } from "./types";

/** The terms a notice must hit to be kept (§4.13). */
export const EXCHANGE_TERMS = ["資安", "網路攻擊", "駭客", "勒索"] as const;

/**
 * The two endpoints. The OpenAPI rows carry no per-notice link, so a notice's `url` is its endpoint's
 * (a canonical MOPS page per notice is a Kobol check, feeds plan §12 item 26).
 */
export const EXCHANGE_ENDPOINTS = {
  twse: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
  tpex: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
} as const;

/** True when `text` (sanitised by the caller) holds one of EXCHANGE_TERMS. */
export function hitsExchangeTerms(text: string): boolean {
  return EXCHANGE_TERMS.some((t) => text.includes(t));
}

/** A ROC date ("1151108", "115/11/08") as an ISO date ("2026-11-08"), or null. */
export function rocDate(raw: string): string | null {
  const m = /^(\d{2,3})\/?(\d{2})\/?(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const iso = `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  return isValidDate(iso) ? iso : null;
}

/** A Taipei time ("173012", "17:30:12", "1730") as "HH:MM:SS", or null. */
function clock(raw: string): string | null {
  const m = /^(\d{2}):?(\d{2})(?::?(\d{2}))?$/.exec(raw.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? "0") > 59) return null;
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

const Rows = z.array(z.record(z.string(), z.unknown()));

/**
 * One endpoint's notices, in the order given; ROC dates (+1911) become +08:00 instants (`spoken_at` from
 * 發言日期 and 發言時間). A row without a readable date, code or subject is skipped. Not JSON is "parse"; not
 * an array of objects "schema"; an empty array is a quiet day, not an error.
 */
export function parseExchange(body: Buffer, endpoint: "twse" | "tpex"): Parsed<ExchangeNotice> {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8").replace(/^﻿/, ""));
  } catch {
    throw new FeedParseError("parse", `${endpoint}: not JSON`);
  }
  const parsed = Rows.safeParse(json);
  if (!parsed.success) throw new FeedParseError("schema", `${endpoint}: not an array of notices`);
  const entries: ExchangeNotice[] = [];
  let newest: string | null = null;
  for (const raw of parsed.data) {
    const row = new Map<string, string>();
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" || typeof v === "number") row.set(k.trim(), String(v));
    const pick = (...keys: string[]) => keys.map((k) => row.get(k)).find((v) => v !== undefined && v.trim() !== "")?.trim() ?? null;
    const date = rocDate(pick("發言日期") ?? "");
    const time = clock(pick("發言時間") ?? "") ?? "00:00:00";
    const code = pick("公司代號", "SecuritiesCompanyCode");
    const subject = pick("主旨");
    if (!date || !code || !subject) continue;
    const spoken_at = `${date}T${time}+08:00`;
    if (newest === null || Date.parse(spoken_at) > Date.parse(newest)) newest = spoken_at;
    entries.push({
      company_code: code,
      company: pick("公司名稱", "CompanyName") ?? code,
      subject,
      text: pick("說明") ?? "",
      spoken_at,
      url: EXCHANGE_ENDPOINTS[endpoint],
    });
  }
  return { newest, entries, version: null, sha256: sha256Hex(body), total: parsed.data.length };
}
