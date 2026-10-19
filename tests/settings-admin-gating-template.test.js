import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX_PATH = resolve(process.cwd(), 'index.html');

describe('settings admin gating template', () => {
  it('gates workspace administration separately from scope management', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('x-show="$store.chat.canAdminWorkspace" class="settings-tab" :class="{ active: $store.chat.settingsTab === \'workspace\' }"');
    expect(html).toContain('x-show="false" x-cloak class="settings-tab" :class="{ active: $store.chat.settingsTab === \'schedules\' }"');
    expect(html).toContain('x-show="$store.chat.canAccessScopeSettings" class="settings-tab" :class="{ active: $store.chat.settingsTab === \'scopes\' }"');
    expect(html).toContain('x-show="$store.chat.canAdminWorkspace" class="settings-tab" :class="{ active: $store.chat.settingsTab === \'sharing\' }"');
    expect(html).toContain('Groups &amp; Members');
    expect(html).toContain('<div class="settings-tab-content" x-show="$store.chat.canAdminWorkspace && $store.chat.settingsTab === \'workspace\'">');
    expect(html).toContain('<div class="settings-tab-content" x-show="false">');
    expect(html).toContain('<div class="settings-tab-content" x-show="$store.chat.canAccessScopeSettings && $store.chat.settingsTab === \'scopes\'">');
    expect(html).toContain('<div class="settings-tab-content" x-show="$store.chat.canAdminWorkspace && $store.chat.settingsTab === \'sharing\'">');
  });

  it('labels the connection tab NStack and lists it first, before Workspace', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const tabsStart = html.indexOf('<div class="settings-tabs">');
    const tabsEnd = html.indexOf('</div>', tabsStart);
    const tabs = [...html.slice(tabsStart, tabsEnd).matchAll(/<button[^>]*settingsTab === '([a-z]+)'[^>]*>([^<]*)<\/button>/g)]
      .map(([, key, label]) => ({ key, label }));

    expect(tabs[0]).toEqual({ key: 'connection', label: 'NStack' });
    expect(tabs[1]).toEqual({ key: 'workspace', label: 'Workspace' });
    expect(tabs.some(({ label }) => label === 'Connection')).toBe(false);
    expect(html).toContain('<button class="settings-tab" :class="{ active: $store.chat.settingsTab === \'connection\' }" @click="$store.chat.settingsTab = \'connection\'">NStack</button>');
  });

  it('hides advanced settings tabs behind the workspace advanced checkbox', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('x-show="$store.chat.workspaceAdvancedOptionsEnabled && !$store.chat.isTowerPgMode" class="settings-tab" :class="{ active: $store.chat.settingsTab === \'data\' }"');
    expect(html).toContain('>Sync</button>');
    expect(html).toContain('<div class="settings-tab-content" x-show="false">');
    expect(html).toContain('<div class="settings-tab-content" x-show="$store.chat.workspaceAdvancedOptionsEnabled && !$store.chat.isTowerPgMode && $store.chat.settingsTab === \'data\'">');
    expect(html).toContain('id="workspace-advanced-options-input"');
  });

  it('hides scope management controls behind canAdminWorkspace', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');

    expect(html).toContain('<div class="scope-create-bar" x-show="$store.chat.canAdminWorkspace">');
    expect(html).toContain('<div class="scope-card-actions" x-show="$store.chat.canAdminWorkspace && !$store.chat.isTowerPgMode">');
  });

  it('keeps preset connect panel expressions null-safe', () => {
    const html = readFileSync(INDEX_PATH, 'utf8');
    const panelStart = html.indexOf('class="preset-connect-panel"');
    const panelEnd = html.indexOf('<form class="auth-form"', panelStart);
    const panel = html.slice(panelStart, panelEnd);

    expect(panel).toContain('$store.chat.presetConnectHost?.url');
    expect(panel).toContain('$store.chat.presetConnectHost?.towerName');
    expect(panel).not.toMatch(/presetConnectHost\.(url|towerName|label)/);
  });
});
