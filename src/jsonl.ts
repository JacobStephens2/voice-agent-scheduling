import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function isAbsentFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A missing file is an empty ledger. Any other read or parse failure must
 * surface: retention cleanup rewrites from this result, and a failed load
 * is not an empty ledger.
 */
export function loadJsonl<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isAbsentFile(error)) {
      return [];
    }
    throw error;
  }
  const records: T[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`Failed to load ${path} at line ${index + 1}`, { cause: error });
    }
  }
  return records;
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
