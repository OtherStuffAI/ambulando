// Host latency is observed during packaging; worker correctness stays mandatory.
export function assessWorkerLatency(delayMs, mode = 'strict') {
  if (!Number.isFinite(delayMs) || delayMs < 0 || !['strict', 'report'].includes(mode)) {
    throw new Error('Invalid worker latency measurement or policy');
  }
  const overBudget = delayMs >= 50;
  if (overBudget && mode === 'strict') throw new Error(`Worker event-loop delay ${delayMs} ms exceeds 50 ms`);
  return { delayMs, budgetMs: 50, overBudget, mode };
}
