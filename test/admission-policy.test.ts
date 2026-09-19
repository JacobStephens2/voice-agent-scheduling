import { describe, expect, it } from "vitest";
import { resolveCallerAdmissionMode } from "../src/admission.js";

describe("caller admission mode", () => {
  it("keeps the authorized allowlist when public admission is not enabled", () => {
    expect(
      resolveCallerAdmissionMode({
        publicAdmission: false,
        allowedCallerNumbers: ["+15551234567"],
        allowCalendarWrites: true,
        calendarSelected: true,
      }),
    ).toEqual({
      kind: "allowlist",
      allowedCallerNumbers: ["+15551234567"],
    });
  });

  it("refuses to start without an allowlist while public admission is off", () => {
    expect(() =>
      resolveCallerAdmissionMode({
        publicAdmission: false,
        allowedCallerNumbers: undefined,
        allowCalendarWrites: true,
        calendarSelected: true,
      }),
    ).toThrow(/Public admission is disabled/);
  });

  it("refuses public admission until calendar writes and an explicit selection are in place", () => {
    expect(() =>
      resolveCallerAdmissionMode({
        publicAdmission: true,
        allowedCallerNumbers: undefined,
        allowCalendarWrites: false,
        calendarSelected: true,
      }),
    ).toThrow(/calendar writes/);

    expect(() =>
      resolveCallerAdmissionMode({
        publicAdmission: true,
        allowedCallerNumbers: undefined,
        allowCalendarWrites: true,
        calendarSelected: false,
      }),
    ).toThrow(/calendar selection/);
  });

  it("refuses to combine public admission with an allowlist", () => {
    expect(() =>
      resolveCallerAdmissionMode({
        publicAdmission: true,
        allowedCallerNumbers: ["+15551234567"],
        allowCalendarWrites: true,
        calendarSelected: true,
      }),
    ).toThrow(/allowlist/);
  });

  it("opens public admission only with writes, selection, and no allowlist", () => {
    expect(
      resolveCallerAdmissionMode({
        publicAdmission: true,
        allowedCallerNumbers: undefined,
        allowCalendarWrites: true,
        calendarSelected: true,
      }),
    ).toEqual({ kind: "public" });
  });
});
