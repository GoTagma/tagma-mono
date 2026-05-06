import { describe, expect, test } from 'bun:test';
import { redactLogText } from './logger';

describe('log redaction', () => {
  test('redacts common token and session fields', () => {
    const text =
      'Authorization: Bearer sk-live token=abc123 "apiKey":"secret-value" sessionId=sess_123';

    const redacted = redactLogText(text);

    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('sessionId=[REDACTED]');
    expect(redacted).not.toContain('sk-live');
    expect(redacted).not.toContain('secret-value');
    expect(redacted).not.toContain('sess_123');
  });

  test('redacts common secret flag forms in argv logs', () => {
    const text = 'spawn args: ["tool","--api-key","sk-live","--token=tok_123","--safe","ok"]';

    const redacted = redactLogText(text);

    expect(redacted).toContain('"--api-key","[REDACTED]"');
    expect(redacted).toContain('--token=[REDACTED]');
    expect(redacted).toContain('"--safe","ok"');
    expect(redacted).not.toContain('sk-live');
    expect(redacted).not.toContain('tok_123');
  });
});
