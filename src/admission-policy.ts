export type CallerAdmissionMode =
  | { readonly kind: "allowlist"; readonly allowedCallerNumbers: readonly string[] }
  | { readonly kind: "public" };

export interface ProductionReadiness {
  readonly publicAdmission: boolean;
  readonly calendarWrites: boolean;
  readonly calendarSelected: boolean;
}

/**
 * Startup gate for who may place a scheduling call. Public admission stays
 * off until the operator explicitly enables it after calendar writes and an
 * explicit destination/conflict selection are in place.
 */
export function resolveCallerAdmissionMode(
  readiness: ProductionReadiness,
  allowedCallerNumbers: readonly string[] | undefined,
): CallerAdmissionMode {
  const allowlist = (allowedCallerNumbers ?? []).map((item) => item.trim()).filter(Boolean);
  if (!readiness.publicAdmission) {
    if (allowlist.length === 0) {
      throw new Error(
        "Public admission is disabled. Set ALLOWED_CALLER_NUMBERS to the authorized smoke-call numbers.",
      );
    }
    return { kind: "allowlist", allowedCallerNumbers: allowlist };
  }
  if (allowlist.length > 0) {
    throw new Error(
      "Public admission cannot be combined with an allowlist. Clear ALLOWED_CALLER_NUMBERS to open the number, or unset SCHEDULING_PUBLIC_ADMISSION to stay allowlisted.",
    );
  }
  if (!readiness.calendarWrites) {
    throw new Error(
      "Public admission requires calendar writes. Set SCHEDULING_ALLOW_CALENDAR_WRITES=true after the test-calendar campaign passes.",
    );
  }
  if (!readiness.calendarSelected) {
    throw new Error(
      "Public admission requires an explicit calendar selection. Set SCHEDULING_PRIMARY_CALENDAR or persist scheduling-calendars.json.",
    );
  }
  return { kind: "public" };
}

export function productionReadiness(input: {
  readonly admissionMode?: CallerAdmissionMode;
  readonly calendarWrites: boolean;
  readonly calendarSelected: boolean;
}): ProductionReadiness {
  return {
    publicAdmission: input.admissionMode?.kind === "public",
    calendarWrites: input.calendarWrites,
    calendarSelected: input.calendarSelected,
  };
}
