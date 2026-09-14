import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSelection,
  requiredCalendarIds,
  saveSelection,
} from "../src/calendar/selection.js";

describe("calendar selection", () => {
  it("is empty until Jacob selects, and is never inferred", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-selection-"));
    expect(loadSelection({ dataDir, env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it("round-trips an explicit selection through the data dir", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-selection-"));
    saveSelection(dataDir, {
      primaryCalendarId: "primary-id",
      conflictCalendarIds: ["team-id"],
      updatedAt: new Date().toISOString(),
    });

    const loaded = loadSelection({ dataDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded?.primaryCalendarId).toBe("primary-id");
    expect(loaded?.conflictCalendarIds).toEqual(["team-id"]);
    expect(requiredCalendarIds(loaded!)).toEqual(["primary-id", "team-id"]);
  });

  it("treats corrupt selection data as missing rather than guessing", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-selection-"));
    saveSelection(dataDir, {
      primaryCalendarId: "primary-id",
      conflictCalendarIds: [],
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(join(dataDir, "scheduling-calendars.json"), "not json");
    expect(loadSelection({ dataDir, env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });

  it("lets explicit environment selection win for operations", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "scheduling-selection-"));
    const loaded = loadSelection({
      dataDir,
      env: {
        SCHEDULING_PRIMARY_CALENDAR: "env-primary",
        SCHEDULING_CONFLICT_CALENDARS: "env-a, env-b, env-primary",
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(loaded?.primaryCalendarId).toBe("env-primary");
    expect(requiredCalendarIds(loaded!)).toEqual(["env-primary", "env-a", "env-b"]);
  });
});
