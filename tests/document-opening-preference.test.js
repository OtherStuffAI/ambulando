import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { getSettings, saveSettings, saveDocumentOpeningMode } from '../src/db.js';

describe('explicit user document opening preference', () => {
  it('persists across database reopening, isolates users, and retains other settings', async () => {
    await saveSettings({ documentOpeningModes: {}, docEditorMode: 'rich', unrelated: 'keep' });
    expect((await getSettings()).documentOpeningModes.alice).toBeUndefined();
    await Promise.all([saveDocumentOpeningMode('alice', 'edit'), saveDocumentOpeningMode('bob', 'view')]);
    const reopened = new Dexie('wingman-fd-shared');
    await reopened.open();
    const row = await reopened.table('app_settings').toCollection().first();
    expect(row.documentOpeningModes).toEqual({ alice: 'edit', bob: 'view' });
    expect(row.unrelated).toBe('keep');
    reopened.close();
    await saveDocumentOpeningMode('alice', 'view');
    expect((await getSettings()).documentOpeningModes).toEqual({ alice: 'view', bob: 'view' });
    await expect(saveDocumentOpeningMode('', 'edit')).rejects.toThrow('Sign in');
  });
});
