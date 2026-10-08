import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'app.js'),
  'utf-8',
);
const indexSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'index.html'),
  'utf-8',
);

describe('invocation modal lifecycle', () => {
  it('closes the invocation modal after a successful submit', () => {
    const submitStart = appSource.indexOf('async submitInvocation()');
    const catchStart = appSource.indexOf('} catch (error) {', submitStart);
    const successPath = appSource.slice(submitStart, catchStart);

    expect(successPath).toContain('this.invocationSuccess = `Sent to ${this.getInvocationRecipientLabel(recipientNpub)}.`;');
    expect(successPath).toContain('this.showInvocationModal = false;');
  });

  it('keeps invocation errors on the failed submit path', () => {
    const submitStart = appSource.indexOf('async submitInvocation()');
    const catchStart = appSource.indexOf('} catch (error) {', submitStart);
    const finallyStart = appSource.indexOf('} finally {', catchStart);
    const errorPath = appSource.slice(catchStart, finallyStart);

    expect(errorPath).toContain("this.invocationError = error?.message || 'Failed to create invocation.';");
    expect(errorPath).not.toContain('this.showInvocationModal = false;');
  });

  it('mounts invocation modals outside the docs-only template', () => {
    const docsTemplateStart = indexSource.search(/<template x-if="[^"]*navSection === 'docs'[^"]*chatDocModalOpen/);
    const filesTemplateStart = indexSource.indexOf('<template x-if="$store.chat.navSection === \'files\'">');
    const docsTemplateSource = indexSource.slice(docsTemplateStart, filesTemplateStart);

    expect(docsTemplateStart).toBeGreaterThan(-1);
    expect(filesTemplateStart).toBeGreaterThan(docsTemplateStart);
    expect(docsTemplateSource).not.toContain('x-show="$store.chat.showInvocationModal"');
    expect(docsTemplateSource).not.toContain('x-show="$store.chat.showInvocationHistoryModal"');
    expect(indexSource.match(/x-show="\$store\.chat\.showInvocationModal"/g)).toHaveLength(1);
    expect(indexSource.match(/x-show="\$store\.chat\.showInvocationHistoryModal"/g)).toHaveLength(1);
  });
});
