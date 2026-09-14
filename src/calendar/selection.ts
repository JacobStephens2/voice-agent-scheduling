import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CalendarSelection {
  readonly primaryCalendarId: string;
  readonly conflictCalendarIds: readonly string[];
  readonly updatedAt: string;
}

const SELECTION_FILE = "scheduling-calendars.json";

function selectionPath(dataDir: string): string {
  return join(dataDir, SELECTION_FILE);
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Load Jacob's explicit calendar selection. Returns undefined until he
 * selects: nothing is inferred, and no default ever replaces his choice.
 */
export function loadSelection(options: {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}): CalendarSelection | undefined {
  const env = options.env ?? process.env;
  const primary = env.SCHEDULING_PRIMARY_CALENDAR?.trim() || undefined;
  const conflicts = parseList(env.SCHEDULING_CONFLICT_CALENDARS);
  if (primary) {
    return {
      primaryCalendarId: primary,
      conflictCalendarIds: [...new Set(conflicts.filter((id) => id !== primary))],
      updatedAt: new Date().toISOString(),
    };
  }
  if (!options.dataDir) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(selectionPath(options.dataDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as {
      primaryCalendarId?: unknown;
      conflictCalendarIds?: unknown;
    };
    if (typeof parsed.primaryCalendarId !== "string" || !parsed.primaryCalendarId) {
      return undefined;
    }
    const conflictsFromFile = Array.isArray(parsed.conflictCalendarIds)
      ? parsed.conflictCalendarIds.filter(
          (id): id is string => typeof id === "string" && Boolean(id),
        )
      : [];
    return {
      primaryCalendarId: parsed.primaryCalendarId,
      conflictCalendarIds: [
        ...new Set(conflictsFromFile.filter((id) => id !== parsed.primaryCalendarId)),
      ],
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export function saveSelection(dataDir: string, selection: CalendarSelection): void {
  if (!selection.primaryCalendarId) {
    throw new Error("A primary calendar is required.");
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    selectionPath(dataDir),
    `${JSON.stringify(
      {
        primaryCalendarId: selection.primaryCalendarId,
        conflictCalendarIds: selection.conflictCalendarIds,
        updatedAt: selection.updatedAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

/** Every calendar whose busy intervals must block availability. */
export function requiredCalendarIds(selection: CalendarSelection): string[] {
  return [
    selection.primaryCalendarId,
    ...selection.conflictCalendarIds.filter((id) => id !== selection.primaryCalendarId),
  ];
}
