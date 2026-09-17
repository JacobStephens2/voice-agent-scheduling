import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadJsonl<T>(path: string): T[] {
  try {
    const text = readFileSync(path, "utf8");
    const records: T[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line) as T);
    }
    return records;
  } catch {
    return [];
  }
}

export function appendJsonl(path: string, record: unknown, fileMode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  if (fileMode === undefined) {
    appendFileSync(path, line, "utf8");
    return;
  }
  appendFileSync(path, line, { encoding: "utf8", mode: fileMode });
}
