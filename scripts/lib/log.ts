import fs from "node:fs";
import path from "node:path";

/** A human-readable run log: each line is timestamped (Taipei) and goes to the file and to stdout. */
export class RunLog {
  constructor(readonly file: string, private readonly echo = true) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  line(message: string): void {
    const stamp = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(11, 19);
    const text = `${stamp} ${message}`;
    fs.appendFileSync(this.file, `${text}\n`);
    if (this.echo) console.log(text);
  }
}
