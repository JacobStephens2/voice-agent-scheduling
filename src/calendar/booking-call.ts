import { createAppointmentProposals, type AppointmentProposals } from "./booking-proposal.js";
import type { BookingToolResult, ConfirmResult } from "./booking-tool.js";

export interface BookingCallOptions {
  readonly callId: string;
  readonly referenceTime?: Date;
}

export interface AppointmentBookingCall {
  execute(name: string, args: Record<string, unknown>): Promise<BookingToolResult>;
  observe(event: Readonly<Record<string, unknown>>): void;
  close(): void;
}

/** Owns admission, Readback and proposal disposal for one Scheduling call. */
export function createAppointmentBookingCall(options: BookingCallOptions & {
  readonly now: () => Date;
  readonly confirm: (args: Record<string, unknown>, proposals: AppointmentProposals) => Promise<ConfirmResult>;
}): AppointmentBookingCall {
  const proposals = createAppointmentProposals(options);
  const readback = proposals.openReadback();
  let closed = false;
  let pending = 0;

  const disposeIfSettled = () => {
    if (closed && pending === 0) {
      proposals.clear();
    }
  };

  return {
    async execute(name, args) {
      if (name === "propose_appointment") {
        return closed
          ? { status: "invalid", message: "This scheduling call has ended." }
          : proposals.propose(args);
      }
      if (name === "confirm_appointment") {
        if (closed) {
          return { status: "readback_incomplete", message: "This scheduling call has ended." };
        }
        // Accept synchronously, before joining the process queue. Eligibility
        // still belongs to queued work, and close cannot abandon this request.
        pending += 1;
        try {
          return await options.confirm(args, proposals);
        } finally {
          pending -= 1;
          disposeIfSettled();
        }
      }
      return { status: "failed", message: "Unknown booking tool." };
    },
    observe(event) {
      if (!closed) {
        readback.observe(event);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      readback.close();
      disposeIfSettled();
    },
  };
}
