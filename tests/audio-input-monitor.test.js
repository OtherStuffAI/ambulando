import { afterEach, expect, it, vi } from 'vitest';
import { capturedInputLevel, observedAudioInput, observeCapturedInput } from '../src/audio-input-monitor.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('responds to nonzero captured samples and remains calm at silence/noise floor', () => {
  expect(capturedInputLevel(new Float32Array(512))).toBe(0);
  expect(capturedInputLevel(new Float32Array(512).fill(0.001))).toBe(0);
  expect(capturedInputLevel(Float32Array.from({ length: 512 }, (_, i) => Math.sin(i) * 0.1))).toBeGreaterThan(0.2);
});
it('never substitutes preference for unreported actual input', () => {
  expect(observedAudioInput({ readyState: 'live' }, [{ deviceId: 'preferred', label: 'Preferred USB' }], 'preferred'))
    .toEqual({ name: 'Unknown (browser did not report input)', detail: 'Browser did not report whether your preference is in use.' });
  expect(observedAudioInput({ getSettings: () => ({ deviceId: 'actual' }) }, [{ deviceId: 'actual', label: 'Observed device' }]).name).toBe('Observed device');
});
it('observes only the original stream and closes graph/timer without stopping capture', () => {
  vi.useFakeTimers();
  const stream = {};
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { disconnect: vi.fn(), getFloatTimeDomainData: samples => samples.fill(0.1) };
  const context = { state: 'running', createMediaStreamSource: vi.fn(() => source), createAnalyser: () => analyser,
    resume: vi.fn().mockResolvedValue(), close: vi.fn().mockResolvedValue() };
  vi.stubGlobal('AudioContext', function AudioContext() { return context; });
  const level = vi.fn();
  const cleanup = observeCapturedInput(stream, level);
  vi.advanceTimersByTime(100);
  expect(level).toHaveBeenLastCalledWith(expect.closeTo(0.4));
  context.state = 'suspended';
  vi.advanceTimersByTime(100);
  expect(level).toHaveBeenLastCalledWith(null);
  expect(context.createMediaStreamSource).toHaveBeenCalledExactlyOnceWith(stream);
  expect(source.connect).toHaveBeenCalledExactlyOnceWith(analyser);
  cleanup();
  expect(context.close).toHaveBeenCalledOnce();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
