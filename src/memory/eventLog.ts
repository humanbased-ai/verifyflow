import { promises as fs } from "node:fs";
import path from "node:path";
import type { QualityEvent } from "../types.js";

/** Appends structured quality-intelligence events as JSONL (architecture.md). */
export class EventLog {
  private readonly file: string;
  constructor(root: string) {
    this.file = path.join(root, "events.jsonl");
  }
  async append(event: QualityEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, JSON.stringify(event) + "\n");
  }
  async appendMany(events: QualityEvent[]): Promise<void> {
    if (events.length === 0) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** Read all appended events. Returns [] when no log exists yet. Malformed lines are skipped. */
  async readAll(): Promise<QualityEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: QualityEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as QualityEvent);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }
}
