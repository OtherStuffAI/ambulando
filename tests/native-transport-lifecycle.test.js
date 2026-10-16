import { describe, expect, it, vi } from 'vitest';
import { installNativeTransportLifecycle } from '../src/native-transport-lifecycle.js';

function harness() {
  const windowObject = new EventTarget();
  windowObject.fipsTransport = { version: 2 };
  const pending = [];
  const initialize = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const suspend = vi.fn();
  const refreshWorker = vi.fn();
  const focus = vi.fn();
  windowObject.addEventListener('focus', focus);
  const dispose = installNativeTransportLifecycle({ windowObject, hasFips: () => true,
    initialize, suspend, refreshWorker });
  const replace = () => {
    windowObject.fipsTransport = { version: 2 };
    windowObject.dispatchEvent(new Event('wingman-fips-transport-ready'));
  };
  return { windowObject, initialize, suspend, refreshWorker, focus, pending, dispose, replace };
}

describe('native document transport recovery', () => {
  it('re-pairs a new provider before replacing the existing worker binding and waking sync', async () => {
    const h = harness();
    h.windowObject.dispatchEvent(new Event('wingman-fips-transport-ready'));
    expect(h.initialize).not.toHaveBeenCalled();
    h.replace();
    expect(h.suspend).toHaveBeenCalledTimes(1);
    expect(h.initialize).toHaveBeenCalledWith({ transport: h.windowObject.fipsTransport });
    expect(h.refreshWorker).not.toHaveBeenCalled();
    h.pending[0]();
    await vi.waitFor(() => expect(h.refreshWorker).toHaveBeenCalledTimes(1));
    expect(h.focus).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('never binds or wakes sync from a pairing completed after suspension', async () => {
    const h = harness();
    h.replace();
    h.windowObject.dispatchEvent(new Event('wingman-fips-transport-revoked'));
    h.pending[0]();
    await Promise.resolve();
    expect(h.suspend).toHaveBeenCalledTimes(2);
    expect(h.refreshWorker).not.toHaveBeenCalled();
    expect(h.focus).not.toHaveBeenCalled();
    h.dispose();
  });

  it('ignores a late previous provider and removes its listeners on disposal', async () => {
    const h = harness();
    h.replace();
    h.replace();
    h.pending[0]();
    await Promise.resolve();
    expect(h.refreshWorker).not.toHaveBeenCalled();
    h.pending[1]();
    await vi.waitFor(() => expect(h.refreshWorker).toHaveBeenCalledTimes(1));
    h.dispose();
    h.replace();
    expect(h.initialize).toHaveBeenCalledTimes(2);
  });

  it('leaves ordinary HTTPS alone when a native provider appears', () => {
    const windowObject = new EventTarget();
    const initialize = vi.fn();
    const dispose = installNativeTransportLifecycle({ windowObject, hasFips: () => false, initialize });
    windowObject.fipsTransport = { version: 2 };
    windowObject.dispatchEvent(new Event('wingman-fips-transport-ready'));
    expect(initialize).not.toHaveBeenCalled();
    dispose();
  });
});
