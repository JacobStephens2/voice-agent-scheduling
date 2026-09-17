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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  const save = (): void => {
    if (!options.dataDir) {
      return;
    }
    try {
      mkdirSync(options.dataDir, { recursive: true });
      writeFileSync(ledgerPath(options.dataDir), JSON.stringify(state));
    } catch {
      // Accounting stays in memory when the ledger cannot be persisted.
    }
  };

  const load = (): void => {
    if (!options.dataDir) {
      return;
    }
    try {
      const parsed = JSON.parse(
        readFileSync(ledgerPath(options.dataDir), "utf8"),
      ) as Partial<PersistedLedger>;
      if (
        typeof parsed.periodId === "string" &&
        typeof parsed.spentMicroUsd === "number" &&
        parsed.reservations &&
        typeof parsed.reservations === "object"
      ) {
        state = {
          periodId: parsed.periodId,
          fixedMicroUsd:
            typeof parsed.fixedMicroUsd === "number" ? parsed.fixedMicroUsd : fixedMicroUsd,
          spentMicroUsd: parsed.spentMicroUsd,
          reservations: { ...parsed.reservations },
        };
      }
    } catch {
      // Missing or unreadable ledger starts empty; reservations cannot be
      // bypassed because every spend below is re-derived from this state.
    }
    if (state.periodId !== billingPeriodId(now())) {
      state = freshState();
      save();
    }
  };

  const reservedTotal = (): number =>
    Object.values(state.reservations).reduce((sum, amount) => sum + amount, 0);

  const pauseReason = (): BudgetBlockReason | undefined => {
    if (!configured) {
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
  const staleOnLoad = Object.keys(state.reservations);
  if (staleOnLoad.length > 0) {
    for (const callId of staleOnLoad) {
      state.spentMicroUsd += state.reservations[callId] ?? 0;
      delete state.reservations[callId];
    }
    save();
  }

  return {
    tryReserve(callId: string): BudgetReserveResult {
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
