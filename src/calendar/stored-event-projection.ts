import type { StoredEventKind } from "./client.js";

/**
 * One appended appointment-ledger row for a stored-event kind.
 * `storedShape` is present only for a shape miss. Omitting the key
 * clears a previous mark; callers must not copy a mark forward.
 */
export interface LedgerCommit {
  readonly status: "booked" | "inconclusive";
  readonly storedShape?: "mismatched";
}

/**
 * What one stored-event kind means for the appointment. Pure: this does
 * not read Calendar and does not append a ledger row.
 *
 * `announce` is booking confirmation's event-exists flag (safe to tell
 * the caller the appointment is booked). `eventStored` is restart
 * recovery's event-exists flag (an event was read). They are different
 * facts: a cancelled event is stored and is not announced.
 */
export interface StoredKindProjection {
  readonly commit: LedgerCommit;
  /** Booking confirmation may announce the appointment. */
  readonly announce: boolean;
  /** A stored event was read: matching, mismatched, or cancelled. */
  readonly eventStored: boolean;
  readonly callbackHold: "held" | "not_held" | "unknown";
}

/**
 * The one kind table. `announce` is true exactly when `commit.status`
 * is booked. A kind that must settle differently needs a new fact here,
 * not a private switch in a caller.
 */
const STORED_KIND_PROJECTIONS: { readonly [kind in StoredEventKind]: StoredKindProjection } = {
  matching: {
    commit: { status: "booked" },
    announce: true,
    eventStored: true,
    callbackHold: "held",
  },
  mismatched: {
    commit: { status: "inconclusive", storedShape: "mismatched" },
    announce: false,
    eventStored: true,
    callbackHold: "held",
  },
  cancelled: {
    commit: { status: "inconclusive" },
    announce: false,
    eventStored: true,
    callbackHold: "not_held",
  },
  missing: {
    commit: { status: "inconclusive" },
    announce: false,
    eventStored: false,
    callbackHold: "not_held",
  },
  unreachable: {
    commit: { status: "inconclusive" },
    announce: false,
    eventStored: false,
    callbackHold: "unknown",
  },
};

/** A pending or inconclusive appointment-ledger row recovery may settle. */
export interface UnresolvedRow {
  readonly status: "pending" | "inconclusive";
  readonly storedShape?: "mismatched";
}

/**
 * Whether restart recovery appends. `append` is the projection's `commit`
 * object when a row must be appended, and absent when nothing is appended.
 * "unresolved" is reported and never appended. It is not an
 * appointment-ledger status.
 */
export interface RecoverySettlement {
  readonly append?: LedgerCommit;
  readonly status: "booked" | "inconclusive" | "unresolved";
}

/**
 * One row of facts for a stored-event kind. A kind outside the five
 * throws, so nothing is recorded as booked because of that throw.
 */
export function projectStoredKind(kind: StoredEventKind): StoredKindProjection {
  if (!Object.hasOwn(STORED_KIND_PROJECTIONS, kind)) {
    throw new Error(`Unknown stored event kind: ${String(kind)}`);
  }
  return STORED_KIND_PROJECTIONS[kind];
}

/**
 * Decide whether restart recovery appends. This never sees the kind.
 *
 * Order: an unknown hold appends nothing and reports unresolved; an
 * announcement always appends and reports booked; a pending row appends
 * `commit`; a stored event that does not hold the callback number appends
 * `commit` when the previous row has a shape mark, which clears that mark.
 * Otherwise append nothing and report `commit.status`.
 *
 * A cancelled event therefore clears a mismatched mark. A missing event
 * on an already-inconclusive row does not, and a mismatched event on an
 * already-inconclusive row does not append, so a missing mark is not
 * backfilled. That asymmetry is the current rule.
 */
export function settleRecovery(
  projection: StoredKindProjection,
  previous: UnresolvedRow,
): RecoverySettlement {
  if (projection.callbackHold === "unknown") {
    return { status: "unresolved" };
  }
  if (projection.announce) {
    return { append: projection.commit, status: "booked" };
  }
  if (previous.status === "pending") {
    return { append: projection.commit, status: projection.commit.status };
  }
  if (
    projection.eventStored &&
    projection.callbackHold === "not_held" &&
    previous.storedShape === "mismatched"
  ) {
    return { append: projection.commit, status: projection.commit.status };
  }
  return { status: projection.commit.status };
}
