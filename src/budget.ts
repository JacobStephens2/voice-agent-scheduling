/**
 * Monthly provider-usage bounds for the direct-SIP scheduling route.
 *
 * Validated route rates (list prices checked 2026-09-07; account rates,
 * geography, taxes, and billing granularity can change the actual bill):
 *
 * - xAI Grok voice audio: $0.08/minute.
 *   https://docs.x.ai/developers/pricing
 * - Telnyx local inbound SIP: from $0.0032/minute; phone numbers
 *   advertised from $1/month (destination/account-dependent).
 *   https://telnyx.com/pricing/elastic-sip
 *
 * The $25 amount is an operating target, not a guarantee that no carrier
 * fee can arise after an application cutoff. Estimates below combine the
 * voice-model and carrier per-minute components; when a safe estimate
 * cannot be made (unconfigured or invalid rates), admissions pause with a
 * bounded unavailable outcome instead of guessing.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MICRO_USD_PER_USD = 1_000_000;

/** $25/month in additional provider charges, excluding the paid server. */
export const MONTHLY_TARGET_MICRO_USD_DEFAULT = 25 * MICRO_USD_PER_USD;

/** Default fixed monthly charges: one Telnyx number at ~$1/month. */
export const FIXED_MONTHLY_MICRO_USD_DEFAULT = 1 * MICRO_USD_PER_USD;

export const GROK_VOICE_MICRO_USD_PER_MINUTE = 80_000;
export const TELNYX_SIP_MICRO_USD_PER_MINUTE = 3_200;
export const DIRECT_SIP_MICRO_USD_PER_MINUTE =
  GROK_VOICE_MICRO_USD_PER_MINUTE + TELNYX_SIP_MICRO_USD_PER_MINUTE;

/** Margin over one full-length call held back for delayed billing. */
export const RESERVE_MARGIN_DEFAULT = 0.25;

export const MAX_CALL_DURATION_MS_DEFAULT = 10 * 60 * 1000;
export const DURATION_WARNING_LEAD_MS_DEFAULT = 60 * 1000;

const LEDGER_FILE = "budget-ledger.json";

export type BudgetBlockReason = "budget_exhausted" | "budget_unavailable";

export type BudgetReserveResult =
  | { readonly admitted: true; readonly reservationMicroUsd: number }
  | { readonly admitted: false; readonly reason: BudgetBlockReason; readonly detail: string };

export interface BudgetSnapshot {
  readonly periodId: string;
  readonly monthlyTargetMicroUsd: number;
  readonly fixedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly reservationForNewCallMicroUsd: number;
  readonly admissionsPaused: boolean;
  readonly pauseReason?: BudgetBlockReason;
}

export interface BudgetLedgerOptions {
  readonly dataDir?: string;
  readonly monthlyTargetMicroUsd?: number;
  readonly fixedMonthlyMicroUsd?: number;
  readonly perMinuteMicroUsd?: number;
  readonly reserveMargin?: number;
  readonly maxCallDurationMs?: number;
  readonly now?: () => Date;
}

export interface BudgetLedger {
  tryReserve(callId: string): BudgetReserveResult;
  settle(callId: string, durationMs: number): number;
  snapshot(): BudgetSnapshot;
}

interface PersistedLedger {
  periodId: string;
  fixedMicroUsd: number;
  spentMicroUsd: number;
  reservations: Record<string, number>;
}

/** Billing period: a UTC calendar month, resetting on the 1st at 00:00 UTC. */
export function billingPeriodId(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function estimateCallCostMicroUsd(
  durationMs: number,
  perMinuteMicroUsd: number = DIRECT_SIP_MICRO_USD_PER_MINUTE,
): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  return Math.round((durationMs * perMinuteMicroUsd) / 60_000);
}

/** Estimated allowance reserved when a call is admitted: one full-length call plus margin. */
export function fullCallReservationMicroUsd(
  maxDurationMs: number,
  perMinuteMicroUsd: number,
  reserveMargin: number,
): number {
  return Math.round(
    estimateCallCostMicroUsd(maxDurationMs, perMinuteMicroUsd) * (1 + reserveMargin),
  );
}

function ledgerPath(dataDir: string): string {
  return join(dataDir, LEDGER_FILE);
}

const PERIOD_ID = /^\d{4}-\d{2}$/;

function isAbsentFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface ParsedLedger {
  periodId: string;
  fixedMicroUsd?: number;
  spentMicroUsd: number;
  reservations: Record<string, number>;
}

function parsePersistedLedger(value: unknown): ParsedLedger | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  if (typeof value.periodId !== "string" || !PERIOD_ID.test(value.periodId)) {
    return undefined;
  }
  if (!isFiniteNonNegative(value.spentMicroUsd)) {
    return undefined;
  }
  if (!isPlainObject(value.reservations)) {
    return undefined;
  }
  const reservations: Record<string, number> = {};
  for (const [callId, amount] of Object.entries(value.reservations)) {
    if (!isFiniteNonNegative(amount)) {
      return undefined;
    }
    reservations[callId] = amount;
  }
  if ("fixedMicroUsd" in value && value.fixedMicroUsd !== undefined) {
    if (!isFiniteNonNegative(value.fixedMicroUsd)) {
      return undefined;
    }
    return {
      periodId: value.periodId,
      fixedMicroUsd: value.fixedMicroUsd,
      spentMicroUsd: value.spentMicroUsd,
      reservations,
    };
  }
  return {
    periodId: value.periodId,
    spentMicroUsd: value.spentMicroUsd,
    reservations,
  };
}

type BudgetLedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unusable" }
  | { readonly kind: "loaded"; readonly ledger: ParsedLedger };

/**
 * A missing file is an empty ledger. A present file that cannot be read, or
 * that is not a ledger, is unusable: it is not zero spend.
 */
function readPersistedBudgetLedger(dataDir: string): BudgetLedgerRead {
  let text: string;
  try {
    text = readFileSync(ledgerPath(dataDir), "utf8");
  } catch (error) {
    if (isAbsentFile(error)) {
      return { kind: "absent" };
    }
    return { kind: "unusable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const ledger = parsePersistedLedger(parsed);
    if (!ledger) {
      return { kind: "unusable" };
    }
    return { kind: "loaded", ledger };
  } catch {
    return { kind: "unusable" };
  }
}

/** Whether `budget-ledger.json` is missing, unreadable or out of shape, or usable. */
export function budgetLedgerFileState(dataDir: string): "absent" | "unusable" | "readable" {
  const read = readPersistedBudgetLedger(dataDir);
  return read.kind === "loaded" ? "readable" : read.kind;
}

export function createBudgetLedger(options: BudgetLedgerOptions = {}): BudgetLedger {
  const now = options.now ?? (() => new Date());
  const monthlyTargetMicroUsd =
    options.monthlyTargetMicroUsd ?? MONTHLY_TARGET_MICRO_USD_DEFAULT;
  const fixedMicroUsd = options.fixedMonthlyMicroUsd ?? FIXED_MONTHLY_MICRO_USD_DEFAULT;
  const perMinuteMicroUsd = options.perMinuteMicroUsd ?? DIRECT_SIP_MICRO_USD_PER_MINUTE;
  const reserveMargin = options.reserveMargin ?? RESERVE_MARGIN_DEFAULT;
  const maxCallDurationMs = options.maxCallDurationMs ?? MAX_CALL_DURATION_MS_DEFAULT;

  const configured =
    Number.isFinite(monthlyTargetMicroUsd) &&
    monthlyTargetMicroUsd > 0 &&
    Number.isFinite(fixedMicroUsd) &&
    fixedMicroUsd >= 0 &&
    Number.isFinite(perMinuteMicroUsd) &&
    perMinuteMicroUsd > 0 &&
    Number.isFinite(reserveMargin) &&
    reserveMargin >= 0 &&
    Number.isFinite(maxCallDurationMs) &&
    maxCallDurationMs > 0;

  const newCallReservation = configured
    ? fullCallReservationMicroUsd(maxCallDurationMs, perMinuteMicroUsd, reserveMargin)
    : 0;

  const freshState = (): PersistedLedger => ({
    periodId: billingPeriodId(now()),
    fixedMicroUsd,
    spentMicroUsd: 0,
    reservations: {},
  });

  let state: PersistedLedger = freshState();
  let ledgerUnusable = false;

  const save = (): void => {
    if (!options.dataDir || ledgerUnusable) {
      return;
    }
    try {
      mkdirSync(options.dataDir, { recursive: true });
      const path = ledgerPath(options.dataDir);
      writeFileSync(path, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Accounting stays in memory when the ledger cannot be persisted.
    }
  };

  const load = (): void => {
    if (!options.dataDir) {
      return;
    }
    const read = readPersistedBudgetLedger(options.dataDir);
    if (read.kind === "unusable") {
      // Do not adopt a zero total or write one over the file.
      ledgerUnusable = true;
      return;
    }
    if (read.kind === "loaded") {
      state = {
        periodId: read.ledger.periodId,
        fixedMicroUsd: read.ledger.fixedMicroUsd ?? fixedMicroUsd,
        spentMicroUsd: read.ledger.spentMicroUsd,
        reservations: { ...read.ledger.reservations },
      };
    }
    if (state.periodId !== billingPeriodId(now())) {
      state = freshState();
      save();
    }
  };

  const reservedTotal = (): number =>
    Object.values(state.reservations).reduce((sum, amount) => sum + amount, 0);

  const pauseReason = (): BudgetBlockReason | undefined => {
    if (!configured || ledgerUnusable) {
      return "budget_unavailable";
    }
    if (
      state.fixedMicroUsd + state.spentMicroUsd + reservedTotal() + newCallReservation >=
      monthlyTargetMicroUsd
    ) {
      return "budget_exhausted";
    }
    return undefined;
  };

  load();
  // A restart never carries live sessions: any reservation left on disk
  // belongs to a call that can no longer settle, so count it as spent
  // rather than freeing it. This keeps a restart from bypassing the limit.
  // Skip this when the file itself could not be trusted: converting an
  // unreadable ledger into spend would invent a total and then persist it.
  if (!ledgerUnusable) {
    const staleOnLoad = Object.keys(state.reservations);
    if (staleOnLoad.length > 0) {
      for (const callId of staleOnLoad) {
        state.spentMicroUsd += state.reservations[callId] ?? 0;
        delete state.reservations[callId];
      }
      save();
    }
  }

  return {
    tryReserve(callId: string): BudgetReserveResult {
      if (ledgerUnusable) {
        return {
          admitted: false,
          reason: "budget_unavailable",
          detail: "The monthly budget ledger cannot be read.",
        };
      }
      if (state.periodId !== billingPeriodId(now())) {
        state = freshState();
      }
      const blocked = pauseReason();
      if (blocked) {
        save();
        return {
          admitted: false,
          reason: blocked,
          detail:
            blocked === "budget_unavailable"
              ? "Provider rates are not configured; usage cannot be estimated."
              : "The estimated monthly allowance is exhausted.",
        };
      }
      state.reservations[callId] = newCallReservation;
      save();
      return { admitted: true, reservationMicroUsd: newCallReservation };
    },

    settle(callId: string, durationMs: number): number {
      if (ledgerUnusable) {
        return 0;
      }
      if (state.periodId !== billingPeriodId(now())) {
        state = freshState();
      }
      delete state.reservations[callId];
      const actual = configured
        ? estimateCallCostMicroUsd(durationMs, perMinuteMicroUsd)
        : 0;
      state.spentMicroUsd += actual;
      save();
      return actual;
    },

    snapshot(): BudgetSnapshot {
      const reason = pauseReason();
      return {
        periodId: state.periodId,
        monthlyTargetMicroUsd,
        fixedMicroUsd: state.fixedMicroUsd,
        spentMicroUsd: state.spentMicroUsd,
        reservedMicroUsd: reservedTotal(),
        reservationForNewCallMicroUsd: newCallReservation,
        admissionsPaused: reason !== undefined,
        ...(reason ? { pauseReason: reason } : {}),
      };
    },
  };
}
