import { describe, expect, test } from 'bun:test';
import { buildSlackTokenSubmission } from '../src/components/chat/bot-bridge-status-logic';

// Module 1 (C): Slack needs TWO tokens. The UI shows two labelled fields and
// composes the combined "<xapp-…>|<xoxb-…>" string the existing keychain/
// transport already expect — with inline validation so the user gets the
// error here, not buried at connect time.
describe('buildSlackTokenSubmission', () => {
  test('composes canonical app|bot from valid tokens (trims whitespace)', () => {
    const r = buildSlackTokenSubmission('  xapp-abc ', ' xoxb-def ');
    expect(r).toEqual({ ok: true, combined: 'xapp-abc|xoxb-def' });
  });

  test('rejects when either field is empty', () => {
    expect(buildSlackTokenSubmission('', 'xoxb-def').ok).toBe(false);
    expect(buildSlackTokenSubmission('xapp-abc', '   ').ok).toBe(false);
  });

  test('rejects wrong prefixes with an actionable message', () => {
    const r = buildSlackTokenSubmission('xoxb-oops', 'xapp-oops');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('xapp-');
      expect(r.error).toContain('xoxb-');
    }
  });

  test('valid result never carries an error; invalid never carries combined', () => {
    const ok = buildSlackTokenSubmission('xapp-1', 'xoxb-2');
    const bad = buildSlackTokenSubmission('nope', 'nope');
    expect('error' in ok).toBe(false);
    expect('combined' in bad).toBe(false);
  });
});
