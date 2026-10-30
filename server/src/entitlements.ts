/** Paid plans: what a plan grants, and whether this account may still spend.
 *
 *  Two layers stack. The account's `plan` selects a quota row; the deployment's license
 *  token caps what the deployment may grant at all (`plans`) and how many accounts it may
 *  hold (`seats`). An account whose plan the license does not cover falls back to `free`
 *  rather than being locked out — a lapsed or downgraded token must not strand a library.
 *
 *  Accuracy limit, by design: `recordUsage` is fire-and-forget on the AI path (xai.ts calls
 *  it with `void`), so the gate compares against the last counter that reached disk. Real
 *  spend can therefore exceed a quota by roughly one call. Quotas are ceilings on order of
 *  magnitude, not a ledger; per-token billing would need the metering made synchronous first.
 */
import type { Account } from './accounts.ts';
import { license } from './licenseBoot.ts';
import { currentUsage } from './usage.ts';
import { isPlanId, PLAN_IDS, PLANS, WARN_AT, type PlanId, type PlanQuota } from './plans.ts';

export { PLAN_IDS, PLANS, WARN_AT, isPlanId, type PlanId, type PlanQuota } from './plans.ts';

/** Plans this deployment may grant. An absent `plans` claim means "all of them", which is
 *  what every token issued before the claim existed says. */
export function grantablePlans(): readonly PlanId[] {
  const allowed = license?.plans;
  if (!allowed?.length) return PLAN_IDS;
  const valid = allowed.filter(isPlanId);
  // a token listing only unknown plan names would otherwise grant nothing
  return valid.length ? valid : PLAN_IDS;
}

/** Accounts this deployment may hold; null = unmetered. */
export function seatLimit(): number | null {
  const seats = license?.seats;
  return typeof seats === 'number' && Number.isFinite(seats) && seats > 0 ? Math.floor(seats) : null;
}

/**
 * Plan a newly created account starts on.
 *
 * On a licensed deployment this is the most generous plan the token grants. The license IS
 * the purchase for a self-hosted install, so a deployer who has paid for one must not land
 * on the free tier in their own server; metering an individual account down is the
 * operator's call, not the default. An unlicensed (demo) deployment starts on `free`,
 * which doubles as the trial tier.
 */
export function defaultPlanForNewAccount(): PlanId {
  if (!license) return 'free';
  const grantable = new Set(grantablePlans());
  // PLAN_IDS runs least → most generous; take the most generous the token allows
  for (let i = PLAN_IDS.length - 1; i >= 0; i--) {
    const id = PLAN_IDS[i]!;
    if (grantable.has(id)) return id;
  }
  return 'free';
}

/** The plan actually in force: the stored one when the license covers it, else `free`. */
export function planOf(account: Pick<Account, 'plan'>): PlanId {
  const stored = isPlanId(account.plan) ? account.plan : 'free';
  return grantablePlans().includes(stored) ? stored : 'free';
}

export function quotaFor(account: Pick<Account, 'plan'>): PlanQuota {
  return PLANS[planOf(account)];
}

export type Gate =
  /** `warnPercent`: whole-number share of the tightest metered dimension already spent,
   *  set only past WARN_AT. A number rather than a sentence — the clients are Chinese and
   *  own their own wording; the header must not carry English prose. */
  | { allowed: true; warnPercent: number | null }
  | { allowed: false; code: 'QUOTA_EXCEEDED' | 'FORBIDDEN'; reason: string };

const pct = (used: number, limit: number): number => (limit <= 0 ? 0 : used / limit);

/** Quota gate for the AI routes. Unmetered plans short-circuit without touching disk. */
export async function canUseAi(account: Pick<Account, 'id' | 'plan'>): Promise<Gate> {
  const quota = quotaFor(account);
  if (quota.monthlyAiCalls < 0 && quota.monthlyTokens < 0) return { allowed: true, warnPercent: null };

  const used = await currentUsage(account.id);
  const calls = used?.calls ?? 0;
  const tokens = (used?.promptTokens ?? 0) + (used?.completionTokens ?? 0);

  if (quota.monthlyAiCalls >= 0 && calls >= quota.monthlyAiCalls)
    return {
      allowed: false,
      code: 'QUOTA_EXCEEDED',
      reason: `monthly AI call quota reached (${calls}/${quota.monthlyAiCalls})`,
    };
  if (quota.monthlyTokens >= 0 && tokens >= quota.monthlyTokens)
    return {
      allowed: false,
      code: 'QUOTA_EXCEEDED',
      reason: `monthly AI token quota reached (${tokens}/${quota.monthlyTokens})`,
    };

  const worst = Math.max(pct(calls, quota.monthlyAiCalls), pct(tokens, quota.monthlyTokens));
  return { allowed: true, warnPercent: worst >= WARN_AT ? Math.round(worst * 100) : null };
}

/** Feature gate for the year-in-review PDF (a single request costs ~1s of render plus a
 *  full-year AI pass, so it is the one export that is plan-gated rather than metered). */
export function canExportAnnual(account: Pick<Account, 'plan'>): Gate {
  return quotaFor(account).annualExport
    ? { allowed: true, warnPercent: null }
    : {
        allowed: false,
        code: 'FORBIDDEN',
        reason: `the ${planOf(account)} plan does not include the annual book`,
      };
}

/** Seat gate for a family invitation / member add. `current` counts existing members. */
export function canAddFamilyMember(owner: Pick<Account, 'plan'>, current: number): Gate {
  const seats = quotaFor(owner).familySeats;
  if (seats < 0 || current < seats) return { allowed: true, warnPercent: null };
  return {
    allowed: false,
    code: 'FORBIDDEN',
    reason: `the ${planOf(owner)} plan holds ${seats} family member(s)`,
  };
}

/** What the ops console and /auth/me report. */
export interface PlanStatus {
  plan: PlanId;
  quota: PlanQuota;
  usage: { calls: number; tokens: number; estimatedCalls: number };
  /** 0-1 of the tightest metered dimension; 0 when the plan is unmetered */
  used: number;
}

export async function planStatus(account: Pick<Account, 'id' | 'plan'>): Promise<PlanStatus> {
  const quota = quotaFor(account);
  const used = await currentUsage(account.id);
  const calls = used?.calls ?? 0;
  const tokens = (used?.promptTokens ?? 0) + (used?.completionTokens ?? 0);
  return {
    plan: planOf(account),
    quota,
    usage: { calls, tokens, estimatedCalls: used?.estimatedCalls ?? 0 },
    used: Math.min(1, Math.max(pct(calls, quota.monthlyAiCalls), pct(tokens, quota.monthlyTokens))),
  };
}
