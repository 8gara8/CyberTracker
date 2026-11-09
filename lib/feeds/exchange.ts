// TWSE and TPEx material-information notices (SPEC §4.13 `exchange-tw`). P2 WP1 fills this stub (S0 contract).

import type { ExchangeNotice, Parsed } from "./types";

/** The terms a notice must hit to be kept (§4.13). */
export const EXCHANGE_TERMS = ["資安", "網路攻擊", "駭客", "勒索"] as const;

/** One endpoint's notices; ROC dates (+1911) become +08:00 instants. */
export function parseExchange(body: Buffer, endpoint: "twse" | "tpex"): Parsed<ExchangeNotice> {
  throw new Error("not implemented: parseExchange");
}
