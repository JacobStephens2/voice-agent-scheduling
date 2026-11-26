import { randomBytes } from "node:crypto";
import { extractE164, isE164 } from "../phone.js";
import { createBookingReadback, type ReadbackHandle } from "./booking-readback.js";
import { prepareBookingDay, SCHEDULING_TIMEZONE } from "./policy.js";

export interface AppointmentProposal {
  readonly proposalId: string;
  readonly callId: string;
  readonly callerName: string;
  readonly callbackNumber: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: typeof SCHEDULING_TIMEZONE;
  readonly purpose?: string;
}

export interface ProposeResult {
  readonly status: "proposed" | "invalid";
  readonly proposalId?: string;
  readonly readback?: {
    readonly callerName: string;
    readonly callbackNumber: string;
    readonly date: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly timezone: typeof SCHEDULING_TIMEZONE;
    readonly purpose?: string;
  };
  readonly message: string;
}

export type ConfirmationEligibility =
  | { readonly status: "eligible"; readonly proposal: AppointmentProposal }
  | { readonly status: "readback_incomplete"; readonly message: string };

export interface AppointmentProposals {
  propose(args: Record<string, unknown>): ProposeResult;
  openReadback(): ReadbackHandle;
  checkConfirmation(args: Record<string, unknown>): ConfirmationEligibility;
  currentForInsert(captured: AppointmentProposal): AppointmentProposal | undefined;
  discard(captured: AppointmentProposal): void;
  clear(): void;
}

/** Owns one call's transient proposal and Booking confirmation eligibility. */
export function createAppointmentProposals(options: {
  readonly callId: string;
  readonly referenceTime?: Date;
  readonly now: () => Date;
}): AppointmentProposals {
  let current: { proposal: AppointmentProposal; readbackFinished: boolean } | undefined;
  return {
    propose(args) {
      const validated = validateProposal(args, options);
      if ("status" in validated) {
        return validated;
      }
      current = { proposal: validated, readbackFinished: false };
      const { proposalId, callId: _callId, ...readback } = validated;
      const purposeLine = validated.purpose ? ` Purpose: ${validated.purpose}.` : "";
      return {
        status: "proposed",
        proposalId,
        readback,
        message: `Please read back: ${validated.callerName}, callback ${validated.callbackNumber}, ${validated.date} ${validated.startTime}–${validated.endTime} ${SCHEDULING_TIMEZONE}.${purposeLine} Wait for explicit agreement before confirming.`,
      };
    },
    openReadback() {
      const readback = createBookingReadback();
      return {
        observe(event) {
          if (readback.observe(event, current?.proposal) && current) {
            current.readbackFinished = true;
          }
        },
        close() {
          readback.close();
        },
      };
    },
    checkConfirmation(args) {
      if (!current) {
        return {
          status: "readback_incomplete",
          message: "There is no current appointment proposal on this call to confirm.",
        };
      }
      if (args.confirmed !== true) {
        return {
          status: "readback_incomplete",
          message:
            "Do not create the appointment. Unclear assent, background speech, or a refusal is not confirmation.",
        };
      }
      if (typeof args.proposalId !== "string" || args.proposalId !== current.proposal.proposalId) {
        return {
          status: "readback_incomplete",
          message:
            "That confirmation does not match the current proposal on this call. Finish a fresh complete readback first.",
        };
      }
      if (!current.readbackFinished) {
        return {
          status: "readback_incomplete",
          message:
            "The readback is not finished. Complete the full readback without interruption before confirming. Do not create the appointment.",
        };
      }
      return { status: "eligible", proposal: { ...current.proposal } };
    },
    currentForInsert(captured) {
      if (
        captured.callId !== options.callId ||
        current?.proposal.proposalId !== captured.proposalId ||
        !current.readbackFinished
      ) {
        return undefined;
      }
      return { ...current.proposal };
    },
    discard(captured) {
      if (captured.callId === options.callId && current?.proposal.proposalId === captured.proposalId) {
        current = undefined;
      }
    },
    clear() {
      current = undefined;
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function invalid(message: string): ProposeResult {
  return { status: "invalid", message };
}

function validateProposal(
  args: Record<string, unknown>,
  options: {
    readonly callId: string;
    readonly referenceTime?: Date;
    readonly now: () => Date;
  },
): AppointmentProposal | ProposeResult {
  const callerName = asString(args.callerName);
  if (!callerName) {
    return invalid("Please ask the caller for their name before proposing an appointment.");
  }
  if (args.callbackConfirmed !== true) {
    return invalid(
      "Ask the caller to confirm the callback number aloud before proposing the appointment.",
    );
  }
  const rawNumber = asString(args.callbackNumber);
  const callbackNumber = rawNumber ? extractE164(rawNumber) : "";
  if (!isE164(callbackNumber)) {
    return invalid(
      "I could not understand that callback number. Ask the caller to repeat it, including the area code.",
    );
  }
  const date = asString(args.date);
  const startTime = asString(args.startTime);
  if (!date || !startTime) {
    return invalid("Please include the chosen date and Eastern start time.");
  }
  const referenceTime = options.referenceTime ?? options.now();
  const day = prepareBookingDay(date, referenceTime);
  const slot = day.window === "invalid_date"
    ? undefined
    : day.eligibleStarts().find((entry) => entry.startTime === startTime);
  if (!slot) {
    return invalid(
      "That time is not a permitted 30-minute weekday start in Eastern Time. Check availability and propose an offered time.",
    );
  }
  const purpose = asString(args.purpose);
  return {
    proposalId: randomBytes(16).toString("hex"),
    callId: options.callId,
    callerName,
    callbackNumber,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: SCHEDULING_TIMEZONE,
    ...(purpose ? { purpose } : {}),
  };
}
