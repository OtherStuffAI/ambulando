import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function recoveryScript() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script data-flightdeck-asset-recovery>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Asset recovery bootstrap is missing.');
  return match[1];
}

function makeHarness(sharedStorage = new Map(), options = {}) {
  const listeners = new Map();
  const replacements = [];
  const historyReplacements = [];
  const appended = [];
  const elements = new Map();
  const body = {
    removedAttributes: [],
    removeAttribute(name) { this.removedAttributes.push(name); },
    append(element) {
      appended.push(element);
      if (element.id) elements.set(element.id, element);
    },
  };
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    style: {},
    children: [],
    attributes: {},
    listeners: new Map(),
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    append(...children) { this.children.push(...children); },
  });
  const context = {
    URL,
    Date: { now: () => 12345 },
    location: {
      href: options.href || 'https://flightdeck.example/operator-a/deck?scope=one',
      replace(url) { replacements.push(url); },
      reload() {},
    },
    history: {
      state: null,
      replaceState(_state, _title, url) { historyReplacements.push(url); },
    },
    sessionStorage: {
      getItem(key) {
        if (options.storageThrows) throw new Error('storage unavailable');
        return sharedStorage.get(key) ?? null;
      },
      setItem(key, value) {
        if (options.storageThrows) throw new Error('storage unavailable');
        sharedStorage.set(key, value);
      },
      removeItem(key) {
        if (options.storageThrows) throw new Error('storage unavailable');
        sharedStorage.delete(key);
      },
    },
    document: {
      body,
      createElement,
      getElementById(id) { return elements.get(id) || null; },
    },
    window: {
      Alpine: options.store ? { store: () => options.store } : undefined,
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
  };
  vm.runInNewContext(recoveryScript(), context);
  return { appended, body, historyReplacements, listeners, replacements, sharedStorage };
}

describe('bootstrap stale-asset recovery', () => {
  it('cache-busts exactly once for a failed stylesheet and cannot reload-loop', () => {
    const sharedStorage = new Map();
    const first = makeHarness(sharedStorage);
    first.listeners.get('error')({
      target: { tagName: 'LINK', rel: 'stylesheet', href: 'https://flightdeck.example/assets/index-old.css' },
    });
    first.listeners.get('error')({
      target: { tagName: 'SCRIPT', src: 'https://flightdeck.example/assets/index-old.js' },
    });
    expect(first.replacements).toHaveLength(1);
    expect(new URL(first.replacements[0]).searchParams.has('flightdeck-asset-recovery')).toBe(true);

    const recoveryAttempt = makeHarness(sharedStorage);
    recoveryAttempt.listeners.get('error')({
      target: { tagName: 'SCRIPT', src: 'https://flightdeck.example/assets/still-missing.js' },
    });
    expect(recoveryAttempt.replacements).toHaveLength(0);
    expect(sharedStorage.get('flightdeck:asset-recovery-attempted')).toBe('1');
  });

  it('keeps the guard for the recovered document and surfaces a stable error on a delayed repeated failure', () => {
    const sharedStorage = new Map([['flightdeck:asset-recovery-attempted', '1']]);
    const harness = makeHarness(sharedStorage, {
      href: 'https://flightdeck.example/operator-a/deck?scope=one&flightdeck-asset-recovery=abc123',
    });
    harness.listeners.get('load')();
    harness.listeners.get('unhandledrejection')({
      reason: new Error('Failed to fetch dynamically imported module: https://flightdeck.example/assets/editor-old.js'),
    });

    expect(sharedStorage.get('flightdeck:asset-recovery-attempted')).toBe('1');
    expect(harness.replacements).toHaveLength(0);
    expect(harness.historyReplacements).toEqual(['/operator-a/deck?scope=one']);
    expect(harness.body.removedAttributes).toEqual(['x-cloak']);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0].id).toBe('flightdeck-asset-recovery-failed');
    expect(harness.appended[0].children.map((element) => element.textContent)).toEqual([
      'Ambulando Sol could not finish loading',
      'A required application file is still unavailable. Your local workspace data has not been cleared.',
      'Retry loading',
    ]);
  });

  it('clears an old guard after an ordinary successful document load', () => {
    const sharedStorage = new Map([['flightdeck:asset-recovery-attempted', '1']]);
    const harness = makeHarness(sharedStorage);
    harness.listeners.get('load')();
    expect(sharedStorage.has('flightdeck:asset-recovery-attempted')).toBe(false);
  });

  it('does not risk an automatic loop when session storage is unavailable', () => {
    const harness = makeHarness(new Map(), { storageThrows: true });
    harness.listeners.get('error')({
      target: { tagName: 'SCRIPT', src: 'https://flightdeck.example/assets/index-old.js' },
    });

    expect(harness.replacements).toHaveLength(0);
    expect(harness.appended[0].id).toBe('flightdeck-asset-recovery-failed');
  });
});

it('keeps a usable app intact through repeated lazy-module and stylesheet failures', () => {
  const store = { threadInput: 'unsent draft', selectedChannelId: 'ch1' };
  const harness = makeHarness(new Map(), { store });
  harness.listeners.get('load')();
  for (let attempt = 0; attempt < 4; attempt++) {
    harness.listeners.get('unhandledrejection')({ reason: new Error('Failed to fetch dynamically imported module: /assets/editor.js') });
    harness.listeners.get('error')({ target: { tagName: 'LINK', rel: 'stylesheet', href: '/assets/editor.css' } });
  }
  expect(harness.replacements).toEqual([]);
  expect(harness.appended).toEqual([]);
  expect(store.threadInput).toBe('unsent draft');
  expect(store.selectedChannelId).toBe('ch1');
  expect(store.applicationAssetError).toContain('save your drafts');
});
