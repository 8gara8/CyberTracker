import { execFileSync } from "node:child_process";
import { P3_LIMITS } from "./clock";

// The agent's sign-in token from the macOS keychain (SPEC §8.2 preflight step 7, §9.6). The token stays in
// memory, goes only into the agent's environment (scripts/lib/agent.ts agentEnv) and is never logged,
// printed or written. Errors are swallowed whole: the security tool's stderr is never read, so nothing it
// says can reach a log. Adapted from the Europe fork's scripts/lib/keychain.ts (the service name and the
// injectable binary and timeout are ours).

/** The keychain item JL creates (§9.6). Not a secret: the name only. */
export const KEYCHAIN_SERVICE = "cybertracker-claude-oauth";

/** macOS's keychain tool. Tests inject another binary; nothing else should. */
const SECURITY_BIN = "/usr/bin/security";

/**
 * `/usr/bin/security find-generic-password -s <service> -w` within `timeoutMs` (default 10 s): the value
 * trimmed, or null when the tool is missing, fails, times out or prints nothing. Never logs.
 */
export function readSecret(service: string, o: { bin?: string; timeoutMs?: number } = {}): string | null {
  try {
    const value = execFileSync(o.bin ?? SECURITY_BIN, ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: o.timeoutMs ?? P3_LIMITS.keychainMs,
      maxBuffer: 64 * 1024,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** readSecret(KEYCHAIN_SERVICE): the agent's OAuth token, or null. */
export async function readToken(): Promise<string | null> {
  return readSecret(KEYCHAIN_SERVICE);
}
