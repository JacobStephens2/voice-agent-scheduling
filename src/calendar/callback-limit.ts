import type { AppointmentLedger } from "./appointment-ledger.js";
import { CalendarQueryError, getAppointmentEvent } from "./client.js";
import { appointmentEndMs } from "./policy.js";

export type CallbackLimitOutcome = "clear" | "blocked" | "unknown";

/**
 * Decide whether a callback number already holds an upcoming
 * scheduler-created appointment. Past appointments and manually
 * cancelled or deleted events no longer block; an unreachable Calendar
 * is "unknown" rather than a guess in either direction.
 */
export async function evaluateCallbackLimit(options: {
  readonly fetchFn: typeof fetch;
  readonly accessToken: string;
  readonly ledger: AppointmentLedger;
  readonly numberHash: string;
  readonly now: Date;
  /**
   * The committing operation's own identity. Its records describe this
   * attempt's uncertain write, reconciled separately against the same
   * identity; only other operations can hold a competing appointment.
   */
  readonly excludeOperationId?: string;
}): Promise<CallbackLimitOutcome> {
  const candidates = options.ledger.operationsHoldingAppointment(
    options.numberHash,
    options.excludeOperationId,
  );
  for (const record of candidates) {
    const endMs = appointmentEndMs(record.startUtc);
    if (Number.isNaN(endMs)) {
      return "unknown";
    }
    if (endMs <= options.now.getTime()) {
      continue;
    }
    let status: string | undefined;
    try {
      const event = await getAppointmentEvent(
        options.fetchFn,
        options.accessToken,
        record.calendarId,
        record.eventId,
      );
      status = event.status;
    } catch (error) {
      if (error instanceof CalendarQueryError && error.kind === "not_found") {
        continue;
      }
      return "unknown";
    }
    if (status === "cancelled") {
      continue;
    }
    return "blocked";
  }
  return "clear";
}
