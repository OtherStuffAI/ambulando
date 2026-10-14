import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { connectSettingsManagerMixin } from '../src/connect-settings-manager.js';
import content from '../src/hosting-legal-content.json';

describe('Nstack onboarding and draft policies', () => {
  it('requires authentication without changing connection drafts or claiming provisioning', async () => {
    const store = { connectManualUrl: 'https://my-tower.example', connectStep: 1, connectHostedNotice: '' };
    await connectSettingsManagerMixin.connectRequestHostedTower.call(store);
    expect(store.connectManualUrl).toBe('https://my-tower.example');
    expect(store.connectStep).toBe(1);
    expect(store.connectHostedNotice).toMatch(/Sign in with your Nostr identity/);
  });
  it('offers public base-aware legal links in separate tabs and keeps BYO submit', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html.indexOf('<h3>Host My Tower</h3>')).toBeLessThan(html.indexOf('>BYO Tower</summary>'));
    for (const page of ['privacy', 'terms']) {
      expect(html).toContain(`href="%BASE_URL%legal/${page}.html" target="_blank" rel="noopener"`);
      expect(readFileSync(`legal/${page}.html`, 'utf8')).toContain(`data-legal-page="${page}"`);
    }
    expect(html).toContain('@submit.prevent="$store.chat.connectByo()"');
  });
  it('clearly distinguishes the proposed credit and preserves non-excludable duties', () => {
    const terms = JSON.stringify(content.terms);
    expect(content.draftNotice).toMatch(/Draft for owner review/);
    expect(terms).toContain('USD $5 credit');
    expect(terms).toContain('credit is not recurring free storage');
    expect(terms).toContain('paused if the amount due is unpaid');
    expect(terms).toContain('do not authorize or assume automatic charges');
    expect(terms).toContain('cannot lawfully be excluded');
    expect(terms).toContain('counter-notice');
    expect(terms).toContain('child sexual abuse material');
    expect(JSON.stringify(content.privacy)).toContain('IndexedDB through Dexie');
    expect(JSON.stringify(content.privacy)).toContain('actual hosting/support locations');
  });
});
