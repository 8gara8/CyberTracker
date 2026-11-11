import fs from "node:fs";
import path from "node:path";

/**
 * A human-readable run log: each line is timestamped (Taipei, HH:MM:SS) and goes to the file and to
 * stdout. `now` is the clock the stamp reads (daily.ts passes Deps.now, so test logs show the test
 * clock; plan G22); the default is the real clock.
 */
export class RunLog {
  constructor(readonly file: string, private readonly echo = true, private readonly now: () => number = Date.now) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  line(message: string): void {
    const stamp = new Date(this.now() + 8 * 3_600_000).toISOString().slice(11, 19);
    const text = `${stamp} ${message}`;
    fs.appendFileSync(this.file, `${text}\n`);
    if (this.echo) console.log(text);
  }
}
