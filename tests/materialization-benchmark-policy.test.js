import { expect, it } from 'vitest';
import { assessWorkerLatency } from './helpers/materialization-benchmark-policy.js';

it('reports the prior noisy release measurement without changing its value', () => {
  expect(assessWorkerLatency(53.736791, 'report')).toEqual({ delayMs: 53.736791, budgetMs: 50, overBudget: true, mode: 'report' });
});
it('retains the strict performance investigation gate', () => {
  expect(() => assessWorkerLatency(53.736791)).toThrow('exceeds 50 ms');
  expect(assessWorkerLatency(3.4).overBudget).toBe(false);
});
it('rejects absent, fabricated and unknown-policy measurements in release mode', () => {
  for (const value of [NaN, Infinity, -1, undefined]) expect(() => assessWorkerLatency(value, 'report')).toThrow();
  expect(() => assessWorkerLatency(53.7, 'ignore')).toThrow();
});
