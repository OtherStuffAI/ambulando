import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

describe('document recovery UI', () => {
  it('keeps ordinary save state compact beside Save', () => {
    expect(app).toContain("if (this.docAutosaveState === 'pending') return 'Unsaved changes';");
    expect(app).toContain("if (this.docAutosaveState === 'saving') return 'Saving…';");
    expect(app).toContain("return 'Saved';");
    expect(html).toContain('class="doc-edit-status"');
    expect(html).toContain("x-show=\"['blocked', 'conflict', 'recovery', 'recovery_available'].includes($store.chat.docEditAccessState)\"");
    expect(html).not.toContain("x-show=\"['pending', 'saving', 'saved'].includes($store.chat.docAutosaveState)\"");
  });

  it('offers editable recovery actions instead of clipboard-only escape', () => {
    expect(html).toContain('Continue recovery');
    expect(html).toContain('promoteSelectedDocRecovery()');
    expect(html).toContain('discardSelectedDocRecovery()');
    expect(html).toContain(':disabled="$store.chat.docRecoveryActionState || $store.chat.docEditDraftDirty"');
    expect(html).toContain('Copy draft');
    expect(html).toContain("['editing', 'recovery'].includes($store.chat.docEditAccessState)");
    expect(html).toContain('Draft starting version v');
    expect(html).toContain('Saved version v');
  });
});
