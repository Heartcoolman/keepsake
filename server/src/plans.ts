/** Plan definitions — pure data, no dependencies. Kept separate from entitlements.ts so
 *  accounts.ts can type its `plan` field without pulling in the license boot path. */

export const PLAN_IDS = ['free', 'standard', 'family'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanQuota {
  /** AI calls per calendar month; -1 = unmetered */
  monthlyAiCalls: number;
  /** prompt+completion tokens per calendar month; -1 = unmetered */
  monthlyTokens: number;
  /** members a family may hold, owner included; ignored for personal accounts */
  familySeats: number;
  /** year-in-review PDF export */
  annualExport: boolean;
}

/** Ceilings, not prices. Sized against observed spend: one full session (open + a dozen
 *  turns + diary) runs ~15 calls and ~40k tokens on Kimi K3, so `free` covers roughly two
 *  memories a month, `standard` about thirty, and `family` drops the metering entirely. */
export const PLANS: Record<PlanId, PlanQuota> = {
  free: { monthlyAiCalls: 30, monthlyTokens: 100_000, familySeats: 2, annualExport: false },
  standard: { monthlyAiCalls: 500, monthlyTokens: 2_000_000, familySeats: 4, annualExport: true },
  family: { monthlyAiCalls: -1, monthlyTokens: -1, familySeats: 8, annualExport: true },
};

/** Fraction of a quota at which a response starts carrying a warning. */
export const WARN_AT = 0.8;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}
