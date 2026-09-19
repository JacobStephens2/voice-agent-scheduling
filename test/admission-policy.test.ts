import { describe, expect, it } from "vitest";
import { resolveCallerAdmissionMode } from "../src/admission-policy.js";

const READY = {
  publicAdmission: false,
  calendarWrites: true,
  calendarSelected: true,
} as const;

describe("caller admission mode", () => {
  it("keeps the authorized allowlist when public admission is not enabled", () => {
    expect(resolveCallerAdmissionMode(READY, ["+15551234567"])).toEqual({
      kind: "allowlist",
      allowedCallerNumbers: ["+15551234567"],
    });
  });

  it("refuses to start without an allowlist while public admission is off", () => {
    expect(() => resolveCallerAdmissionMode(READY, undefined)).toThrow(
      /Public admission is disabled/,
    );
  });

  it("refuses public admission until calendar writes and an explicit selection are in place", () => {
    expect(() =>
      resolveCallerAdmissionMode(
        { publicAdmission: true, calendarWrites: false, calendarSelected: true },
        undefined,
      ),
    ).toThrow(/calendar writes/);

    expect(() =>
      resolveCallerAdmissionMode(
        { publicAdmission: true, calendarWrites: true, calendarSelected: false },
        undefined,
      ),
    ).toThrow(/calendar selection/);
  });

  it("refuses to combine public admission with an allowlist", () => {
    expect(() =>
      resolveCallerAdmissionMode(
        { publicAdmission: true, calendarWrites: true, calendarSelected: true },
        ["+15551234567"],
      ),
    ).toThrow(/allowlist/);
  });

  it("opens public admission only with writes, selection, and no allowlist", () => {
    expect(
      resolveCallerAdmissionMode(
        { publicAdmission: true, calendarWrites: true, calendarSelected: true },
        undefined,
      ),
    ).toEqual({ kind: "public" });
  });
});
