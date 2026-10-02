import { describe, expect, it } from 'vitest';
import { isContextAccessDenied } from '../src/context-tree-errors.js';

describe('Context Tree live route and access failures', () => {
  it('keeps permission denials and concealed missing contexts neutral', () => {
    expect(isContextAccessDenied({ status: 403 })).toBe(true);
    expect(isContextAccessDenied({ status: 404, code: 'context_not_found' })).toBe(true);
    expect(isContextAccessDenied({ status: 404, payload: { error: { code: 'context_not_found' } } })).toBe(true);
  });
  it('does not label a stale Tower route or network failure as denied access', () => {
    expect(isContextAccessDenied({ status: 404, responseText: '404 Not Found' })).toBe(false);
    expect(isContextAccessDenied({ status: 404, code: 'not_found' })).toBe(false);
    expect(isContextAccessDenied({ status: 500 })).toBe(false);
  });
});
