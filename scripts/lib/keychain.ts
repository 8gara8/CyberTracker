// The agent's sign-in token from the macOS keychain (SPEC §8.2 preflight step 7, §9.6). The token stays in
// memory, goes only into the agent's environment and is never logged. Owner: lane L1. Step S0 wrote the
// exports; L1 replaces the stub bodies.

/** The keychain item JL creates (§9.6). Not a secret: the name only. */
export const KEYCHAIN_SERVICE = "cybertracker-claude-oauth";

/** /usr/bin/security find-generic-password -s <service> -w, timeout 10 s; trimmed; null on any failure or empty. Never logs. */
export function readSecret(service: string, o?: { bin?: string; timeoutMs?: number }): string | null {
  throw new Error("P3 stub: readSecret (lane L1)");
}

/** readSecret(KEYCHAIN_SERVICE). */
export async function readToken(): Promise<string | null> {
  throw new Error("P3 stub: readToken (lane L1)");
}
