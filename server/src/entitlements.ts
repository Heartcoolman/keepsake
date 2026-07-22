/** Billing/entitlement stub — the single future integration point for paid plans
 *  (family subscriptions, per-token AI billing). Always allows today. */
import type { Account } from './accounts.ts';

export function canUseAi(_account: Account): { allowed: true } | { allowed: false; reason: string } {
  return { allowed: true };
}
