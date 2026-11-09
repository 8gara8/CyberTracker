// No test touches the network (SPEC §8.1; ruling R56). vitest.config.ts loads this file before every test
// file. fetch answers only the tests' own servers on 127.0.0.1, localhost and ::1, and git children may use
// only file:// and local-path remotes (GIT_ALLOW_PROTOCOL is inherited by every git child: ls-remote,
// clone, fetch). CT_FIXTURE_FEEDS answers fetchFeed() from saved files before fetch is ever called.
//
// A blocked fetch rejects as a network failure would, and is also recorded: the file then fails in
// afterAll, so code that swallows fetch errors (fetchFeed() turns them into an error class) cannot hide a
// test that tried the network. State lives on globalThis, so importing this file again changes nothing.
import { afterAll } from "vitest";

export interface OfflineGuard {
  /** Host names fetch may reach. */
  readonly localHosts: ReadonlySet<string>;
  /** Every blocked URL since the file started (tests/no-network.test.ts empties it after its own probes). */
  readonly blocked: string[];
  /** The fetch the guard wraps. */
  readonly realFetch: typeof fetch;
}

const KEY = Symbol.for("cybertracker.tests.offline");
type WithGuard = typeof globalThis & { [KEY]?: OfflineGuard };

/** The URL a fetch call names, or null when it cannot be read (the real fetch then rejects it itself). */
function urlOf(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) return input;
    if (typeof input === "string") return new URL(input);
    return new URL(input.url);
  } catch {
    return null;
  }
}

function install(): OfflineGuard {
  const g = globalThis as WithGuard;
  if (g[KEY]) return g[KEY];
  const guard: OfflineGuard = { localHosts: new Set(["127.0.0.1", "localhost", "[::1]"]), blocked: [], realFetch: globalThis.fetch };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url && !guard.localHosts.has(url.hostname)) {
      guard.blocked.push(url.href);
      throw new TypeError(`A test tried the network: ${url.host} (tests reach only 127.0.0.1 and localhost; tests/setup/offline.ts).`);
    }
    return guard.realFetch(input, init);
  }) as typeof fetch;
  g[KEY] = guard;
  return guard;
}

export const offlineGuard = install();
process.env.GIT_ALLOW_PROTOCOL = "file";

afterAll(() => {
  const blocked = offlineGuard.blocked.splice(0);
  if (blocked.length) throw new Error(`A test tried the network ${blocked.length} times: ${blocked.slice(0, 5).join(", ")}`);
});
