/** Plan quotas: what each plan grants, how the license caps it, and where the gate refuses.
 *  Pure-function level; the wiring through HTTP is covered by billing.e2e.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, PLAN_IDS, WARN_AT, isPlanId } from '../src/plans.ts';
import { canAddFamilyMember, canExportAnnual, planOf, quotaFor } from '../src/entitlements.ts';

test('plan ids are closed', () => {
  assert.deepEqual([...PLAN_IDS], ['free', 'standard', 'family']);
  for (const id of PLAN_IDS) assert.ok(isPlanId(id));
  // a stored value that is not a plan must not become one
  for (const junk of ['enterprise', '', 'FREE', null, 42, {}]) assert.equal(isPlanId(junk), false);
});

test('an unknown stored plan reads as free rather than failing', () => {
  // no license is loaded in a unit test, so grantablePlans() is all of them
  assert.equal(planOf({ plan: 'enterprise' as never }), 'free');
  assert.equal(planOf({ plan: 'standard' }), 'standard');
  assert.deepEqual(quotaFor({ plan: 'enterprise' as never }), PLANS.free);
});

test('quotas rise monotonically and only family is unmetered', () => {
  assert.ok(PLANS.free.monthlyAiCalls < PLANS.standard.monthlyAiCalls);
  assert.ok(PLANS.free.monthlyTokens < PLANS.standard.monthlyTokens);
  assert.ok(PLANS.free.familySeats < PLANS.standard.familySeats);
  assert.ok(PLANS.standard.familySeats < PLANS.family.familySeats);
  assert.equal(PLANS.family.monthlyAiCalls, -1);
  assert.equal(PLANS.family.monthlyTokens, -1);
  // seats are never unmetered — an unbounded family would defeat the seat gate entirely
  assert.ok(PLANS.family.familySeats > 0);
});

test('the annual book is a paid feature', () => {
  assert.equal(canExportAnnual({ plan: 'free' }).allowed, false);
  assert.equal(canExportAnnual({ plan: 'standard' }).allowed, true);
  assert.equal(canExportAnnual({ plan: 'family' }).allowed, true);
  const refusal = canExportAnnual({ plan: 'free' });
  assert.equal(refusal.allowed, false);
  if (!refusal.allowed) assert.equal(refusal.code, 'FORBIDDEN');
});

test('family seats are counted inclusively', () => {
  const owner = { plan: 'standard' as const };
  const seats = PLANS.standard.familySeats;
  assert.equal(canAddFamilyMember(owner, seats - 1).allowed, true, 'one short of the cap');
  assert.equal(canAddFamilyMember(owner, seats).allowed, false, 'at the cap');
  assert.equal(canAddFamilyMember(owner, seats + 5).allowed, false, 'over the cap');
  const refusal = canAddFamilyMember(owner, seats);
  if (!refusal.allowed) assert.equal(refusal.code, 'FORBIDDEN');
});

test('the warning threshold sits below the refusal', () => {
  assert.ok(WARN_AT > 0 && WARN_AT < 1);
});
