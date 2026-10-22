import type { StoredEventKind } from "./client.js";

/**
 * One appended appointment-ledger row for a stored-event kind.
 * `storedShape` is present only for a shape miss. Omitting the key
 * clears a previous mark; callers must not copy a mark forward.
 * A commit status is only booked or inconclusive. `unavailable` is
 * never a commit.
 */
export interface LedgerCommit {
  readonly status: "booked" | "inconclusive";
  readonly storedShape?: "mismatched";
}

/** A pending or inconclusive appointment-ledger row recovery may settle. */
export interface UnresolvedRow {
  readonly status: "pending" | "inconclusive";
  readonly storedShape?: "mismatched";
}

/**
 * After-insert confirmation. Always a commit. The speech key names the
 * sentence appointment confirmation speaks. `tellCaller` is safe to say
 * the appointment is booked, and is true only for a matching event.
 */
export interface Confirmation {
  readonly commit: LedgerCommit;
  readonly speechKey: "booked" | "mismatched" | "interrupted";
  readonly tellCaller: boolean;
}

/**
 * Closed-start confirmation. `unavailable` appends no commit. Every
 * other kind is `commit` plus the confirmation `confirm` would return.
 */
export type ClosedStartConfirmation =
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "commit"; readonly confirmation: Confirmation };

/**
 * Whether restart recovery appends. `append` is absent when nothing is
 * appended. "unresolved" is reported and never appended. `eventStored`
 * means a stored event was read, including a cancelled event. It is not
 * the tell-the-caller flag.
 */
export interface RecoveryDecision {
  readonly append?: LedgerCommit;
  readonly status: "booked" | "inconclusive" | "unresolved";
  readonly eventStored: boolean;
}

/** One stored-event kind, closed over its private row. The kind is not a result. */
export interface StoredEventProjection {
  /** Held blocks the callback number, not held does not, unknown stops the scan. */
  hold(): "held" | "not_held" | "unknown";
  confirm(): Confirmation;
  confirmClosedStart(): ClosedStartConfirmation;
  recover(previous: UnresolvedRow): RecoveryDecision;
}

interface KindRow {
  readonly commit: LedgerCommit;
  readonly speechKey: Confirmation["speechKey"];
  readonly tellCaller: boolean;
  /** A stored event was read: matching, mismatched, or cancelled. */
  readonly eventStored: boolean;
  readonly callbackHold: "held" | "not_held" | "unknown";
  /**
   * Explicit closed-start fact. Only `missing` is unavailable. Not derived
   * from "event not stored" and "hold not held": unreachable is also not
   * stored and stays an interrupted commit.
   */
  readonly closedStart: "unavailable" | "commit";
}

/**
 * The one kind table. A kind that must settle differently needs a new
 * fact here, not a private switch in a caller.
 */
const ROWS: { readonly [kind in StoredEventKind]: KindRow } = {
  matching: {
    commit: { status: "booked" },
    speechKey: "booked",
    tellCaller: true,
    eventStored: true,
    callbackHold: "held",
    closedStart: "commit",
  },
  mismatched: {
    commit: { status: "inconclusive", storedShape: "mismatched" },
    speechKey: "mismatched",
    tellCaller: false,
    eventStored: true,
    callbackHold: "held",
    closedStart: "commit",
  },
  cancelled: {
    commit: { status: "inconclusive" },
    speechKey: "interrupted",
    tellCaller: false,
    eventStored: true,
    callbackHold: "not_held",
    closedStart: "commit",
  },
  missing: {
    commit: { status: "inconclusive" },
    speechKey: "interrupted",
    tellCaller: false,
    eventStored: false,
    callbackHold: "not_held",
    closedStart: "unavailable",
  },
  unreachable: {
    commit: { status: "inconclusive" },
    speechKey: "interrupted",
    tellCaller: false,
    eventStored: false,
    callbackHold: "unknown",
    closedStart: "commit",
  },
};

/**
 * Project one stored-event kind. A kind outside the five throws here,
 * before confirm or recovery, so nothing is recorded as booked.
 */
export function project(kind: StoredEventKind): StoredEventProjection {
  if (!Object.hasOwn(ROWS, kind)) {
    throw new Error(`Unknown stored event kind: ${String(kind)}`);
  }
  const row = ROWS[kind];
  return {
    hold() {
      return row.callbackHold;
    },
    confirm() {
      return confirmationFrom(row);
    },
    confirmClosedStart() {
      if (row.closedStart === "unavailable") {
        return { outcome: "unavailable" };
      }
      return { outcome: "commit", confirmation: confirmationFrom(row) };
    },
    recover(previous) {
      return recoverRow(row, previous);
    },
  };
}

function confirmationFrom(row: KindRow): Confirmation {
  return {
    commit: row.commit,
    speechKey: row.speechKey,
    tellCaller: row.tellCaller,
  };
}

/**
 * Decide whether restart recovery appends. This never sees the kind.
 *
 * Order: an unknown hold appends nothing and reports unresolved; a
 * tell-the-caller row appends the booked commit; a pending row appends
 * the commit; a stored event that does not hold the callback number
 * appends the commit when the previous row has a shape mark, which
 * clears that mark. Otherwise append nothing and report the commit status.
 *
 * A cancelled event therefore clears a mismatched mark. A missing event
 * on an already-inconclusive row does not, and a mismatched event on an
 * already-inconclusive row does not append, so a missing mark is not
 * backfilled.
 */
function recoverRow(row: KindRow, previous: UnresolvedRow): RecoveryDecision {
  if (row.callbackHold === "unknown") {
    return { status: "unresolved", eventStored: row.eventStored };
  }
  if (row.tellCaller) {
    return { append: row.commit, status: "booked", eventStored: row.eventStored };
  }
  if (previous.status === "pending") {
    return { append: row.commit, status: row.commit.status, eventStored: row.eventStored };
  }
  if (
    row.eventStored &&
    row.callbackHold === "not_held" &&
    previous.storedShape === "mismatched"
  ) {
    return { append: row.commit, status: row.commit.status, eventStored: row.eventStored };
  }
  return { status: row.commit.status, eventStored: row.eventStored };
}
