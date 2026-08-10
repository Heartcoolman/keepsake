/** Rolling perf stats: the ops 模型 panel is only as honest as this ring buffer. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LABELS, record, reset, snapshot } from '../src/perf.ts';

const rowFor = (label: string) => snapshot().find((r) => r.label === label)!;

test('every canonical label is present even with no samples', () => {
  reset();
  const rows = snapshot();
  for (const label of Object.values(LABELS))
    assert.ok(rows.some((r) => r.label === label), `missing ${label}`);
  const idle = rowFor(LABELS.depthSidecar);
  assert.equal(idle.count, 0);
  assert.equal(idle.p50, null);
  assert.equal(idle.lastAt, null);
});

test('percentiles come from the last 128 samples only', () => {
  reset();
  // 1..200ms: the window keeps 73..200, so p50 lands near the middle of that tail
  for (let ms = 1; ms <= 200; ms++) record(LABELS.depthLocal, ms);
  const row = rowFor(LABELS.depthLocal);
  assert.equal(row.count, 200);
  assert.equal(row.failures, 0);
  assert.equal(row.lastMs, 200);
  assert.ok(row.p50! >= 73 && row.p50! <= 200, `p50 outside the window: ${row.p50}`);
  assert.ok(row.p95! > row.p50!);
  assert.equal(row.p95! <= 200, true);
});

test('failures are counted but never enter the percentile window', () => {
  reset();
  for (let i = 0; i < 10; i++) record(LABELS.faceDetect, 100);
  record(LABELS.faceDetect, 120_000, false); // a timeout must not become the p95
  const row = rowFor(LABELS.faceDetect);
  assert.equal(row.count, 11);
  assert.equal(row.failures, 1);
  assert.equal(row.p50, 100);
  assert.equal(row.p95, 100);
  assert.equal(row.lastOk, false);
  assert.equal(row.lastMs, 120_000);
});

test('reset clears everything', () => {
  reset();
  record(LABELS.llmBlocking, 42);
  assert.equal(rowFor(LABELS.llmBlocking).count, 1);
  reset();
  assert.equal(rowFor(LABELS.llmBlocking).count, 0);
});
