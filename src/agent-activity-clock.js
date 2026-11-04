// Server-time calibration for agent activity leases.
//
// Tower states lease deadlines in its own clock. A calibration anchors a fresh
// server_time (from a GET response or the SSE connected frame, never from a
// replayed event) to both local clocks. Elapsed time is the larger of the
// monotonic and wall-clock elapsed: a wall clock set backwards cannot extend a
// lease, and a monotonic clock frozen by OS sleep cannot hold an expired turn
// as live after wake. Either error only expires early, never late; a fresh
// response recalibrates. Without a calibration the local wall clock is used
// and the client grace absorbs ordinary skew.

const calibrations = new Map();

const text = (value) => String(value ?? '').trim().replace(/\/+$/, '');

function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// receivedAtEpochMs is the local wall-clock time at which the response that
// carried serverTime was received (workers report it across threads).
export function recordAgentActivityServerTime(backendUrl, serverTime, { receivedAtEpochMs = Date.now() } = {}) {
  const serverMs = Date.parse(String(serverTime || ''));
  if (!Number.isFinite(serverMs)) return false;
  const elapsed = Math.max(0, Date.now() - Number(receivedAtEpochMs || Date.now()));
  calibrations.set(text(backendUrl), {
    serverMs,
    monotonicMs: monotonicNow() - elapsed,
    wallMs: Date.now() - elapsed,
  });
  return true;
}

export function agentActivityServerNow(backendUrl, fallbackNowMs = Date.now()) {
  const calibration = calibrations.get(text(backendUrl));
  if (!calibration) return fallbackNowMs;
  const elapsed = Math.max(monotonicNow() - calibration.monotonicMs, Date.now() - calibration.wallMs);
  return calibration.serverMs + elapsed;
}

export function resetAgentActivityServerTime(backendUrl) {
  if (backendUrl === undefined) calibrations.clear();
  else calibrations.delete(text(backendUrl));
}
