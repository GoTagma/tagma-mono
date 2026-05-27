import { describe, expect, test } from 'bun:test';
import {
  tryParseJsonish,
  formatJson,
  highlightJson,
  JSON_PRETTY_MAX_BYTES,
} from '../src/utils/json-pretty';
import { normalizeJsonViewMode } from '../src/components/run/useJsonViewMode';

describe('tryParseJsonish', () => {
  test('parses a single JSON object as kind "json"', () => {
    const r = tryParseJsonish('{"a":1,"b":"x"}');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(r.value).toEqual({ a: 1, b: 'x' });
  });

  test('parses a JSON array', () => {
    const r = tryParseJsonish('[1,2,3]');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(r.value).toEqual([1, 2, 3]);
  });

  test('parses a JSON scalar', () => {
    const r = tryParseJsonish('42');
    expect(r.kind).toBe('json');
    if (r.kind === 'json') expect(r.value).toBe(42);
  });

  test('tolerates surrounding whitespace / trailing newline', () => {
    const r = tryParseJsonish('\n  {"ok":true}\n');
    expect(r.kind).toBe('json');
  });

  test('parses the claude-code result envelope shape', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Done.',
      session_id: 'abc-123',
      total_cost_usd: 0.0123,
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const r = tryParseJsonish(envelope);
    expect(r.kind).toBe('json');
  });

  test('parses the opencode NDJSON event stream as kind "ndjson"', () => {
    const stream = [
      '{"type":"step_start"}',
      '{"type":"text","part":{"text":"hello"}}',
      '{"type":"step_finish","sessionID":"s1"}',
    ].join('\n');
    const r = tryParseJsonish(stream);
    expect(r.kind).toBe('ndjson');
    if (r.kind === 'ndjson') expect(r.values).toHaveLength(3);
  });

  test('tolerates blank lines between NDJSON records', () => {
    const r = tryParseJsonish('{"a":1}\n\n{"b":2}\n');
    expect(r.kind).toBe('ndjson');
    if (r.kind === 'ndjson') expect(r.values).toHaveLength(2);
  });

  test('plain prose is kind "none"', () => {
    expect(tryParseJsonish('All done — refactored the auth module.').kind).toBe('none');
  });

  test('truncated / invalid JSON is kind "none"', () => {
    expect(tryParseJsonish('{"a":1,"b":').kind).toBe('none');
  });

  test('empty / whitespace-only is kind "none"', () => {
    expect(tryParseJsonish('').kind).toBe('none');
    expect(tryParseJsonish('   \n  ').kind).toBe('none');
  });

  test('a single valid JSON line is "json", not "ndjson"', () => {
    expect(tryParseJsonish('{"only":1}').kind).toBe('json');
  });

  test('mixed valid+invalid lines is "none" (not partial ndjson)', () => {
    expect(tryParseJsonish('{"a":1}\nnot json\n{"b":2}').kind).toBe('none');
  });

  test('input larger than the size guard is kind "none"', () => {
    const big = '{"x":"' + 'a'.repeat(JSON_PRETTY_MAX_BYTES + 10) + '"}';
    expect(tryParseJsonish(big).kind).toBe('none');
  });
});

describe('formatJson', () => {
  test('pretty-prints with 2-space indentation', () => {
    expect(formatJson({ a: 1, b: [2] })).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  });
});

describe('highlightJson', () => {
  test('round-trips: concatenated token text equals the input', () => {
    const pretty = formatJson({
      title: 'Refactor auth',
      steps: ['extract', 'test'],
      risk: 'low',
      confidence: 0.82,
      done: true,
      note: null,
    });
    const tokens = highlightJson(pretty);
    expect(tokens.map((t) => t.text).join('')).toBe(pretty);
  });

  test('classifies keys, strings, numbers and literals distinctly', () => {
    const tokens = highlightJson(formatJson({ k: 'v', n: 7, b: false, z: null }));
    const classed = (needle: string) => tokens.find((t) => t.text.includes(needle))?.cls ?? null;
    expect(classed('"k"')).toBe('text-tagma-accent'); // key
    expect(classed('"v"')).toBe('text-tagma-success'); // string value
    expect(classed('7')).toBe('text-tagma-warning'); // number
    expect(classed('false')).toBe('text-tagma-info'); // boolean
    expect(classed('null')).toBe('text-tagma-info'); // null
  });

  test('never throws on malformed input — falls back to a single plain token', () => {
    const tokens = highlightJson('{ this is not "valid json at all ');
    expect(tokens.map((t) => t.text).join('')).toBe('{ this is not "valid json at all ');
  });

  test('handles strings containing escaped quotes and colons', () => {
    const pretty = formatJson({ msg: 'he said "hi": ok', url: 'http://x' });
    const tokens = highlightJson(pretty);
    expect(tokens.map((t) => t.text).join('')).toBe(pretty);
  });
});

describe('normalizeJsonViewMode', () => {
  test('defaults to "formatted" for null / unknown', () => {
    expect(normalizeJsonViewMode(null)).toBe('formatted');
    expect(normalizeJsonViewMode(undefined)).toBe('formatted');
    expect(normalizeJsonViewMode('garbage')).toBe('formatted');
  });

  test('honours an explicit "raw" preference', () => {
    expect(normalizeJsonViewMode('raw')).toBe('raw');
  });

  test('honours an explicit "formatted" preference', () => {
    expect(normalizeJsonViewMode('formatted')).toBe('formatted');
  });
});
