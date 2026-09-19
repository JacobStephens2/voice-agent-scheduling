import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function rewriteJsonl(path: string, records: readonly unknown[], fileMode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const text =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (fileMode === undefined) {
    writeFileSync(path, text, "utf8");
    return;
  }
  writeFileSync(path, text, { encoding: "utf8", mode: fileMode });
  chmodSync(path, fileMode);
}
