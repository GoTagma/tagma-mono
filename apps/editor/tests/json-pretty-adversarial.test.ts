/**
 * Adversarial / edge-case probes for the display-only JSON prettifier.
 * The single most important safety property is the highlightJson round-trip
 * invariant: concatenated token text MUST equal the formatted input, on every
 * input, or the formatted view would silently corrupt what the user sees.
 */
import { describe, expect, test } from 'bun:test';
import {
  tryParseJsonish,
  formatJson,
  highlightJson,
  JSON_PRETTY_MAX_BYTES,
} from '../src/utils/json-pretty';

const roundTrips = (value: unknown) => {
  const pretty = formatJson(value);
  expect(
    highlightJson(pretty)
      .map((t) => t.text)
      .join(''),
  ).toBe(pretty);
};

describe('highlightJson round-trip — adversarial values', () => {
  test('strings with backslashes, quotes, slashes, control chars', () => {
    roundTrips({
      bs: 'a\\b',
      q: 'he said "hi"',
      slash: 'http://x/y',
      nl: 'line1\nline2\ttab',
      ctrl: ' \b\f',
      colonish: 'key: value, [x]: {y}',
    });
  });

  test('keys that need escaping and look like punctuation/numbers', () => {
    roundTrips({ 'a"b': 1, 'c:d': 2, '123': 3, '-x': 4, true: 5, '': 6 });
  });

  test('unicode, emoji, surrogate pairs and a lone surrogate', () => {
    roundTrips({ e: '😀🚀', cjk: '中文字符', lone: '\ud800', combine: 'é' });
  });

  test('number shapes: negative, exponent, fraction, zero variants', () => {
    roundTrips({ a: -1.5e-10, b: 1e3, c: -0, d: 0.0, e: 1.0, f: Number.MAX_SAFE_INTEGER });
  });

  test('deeply nested structures and mixed arrays', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { lvl: i, child: deep, list: [i, 'x', null, true] };
    roundTrips(deep);
  });

  test('arrays of objects (keys vs string values both present)', () => {
    roundTrips([
      { name: 'a', tags: ['x', 'y'], ok: true, n: null },
      { name: 'b', tags: [], ok: false, n: 3 },
    ]);
  });

  test('a value string immediately preceding a closing brace', () => {
    roundTrips({ only: 'value' });
    roundTrips({ a: { b: 'c' } });
  });

  test('NDJSON records each round-trip independently', () => {
    const r = tryParseJsonish('{"type":"a","x":1}\n{"type":"b","y":[1,2]}');
    expect(r.kind).toBe('ndjson');
    if (r.kind === 'ndjson') r.values.forEach(roundTrips);
  });

  test('empty object / empty array / scalars', () => {
    roundTrips({});
    roundTrips([]);
    roundTrips('plain');
    roundTrips(0);
    roundTrips(false);
    roundTrips(null);
  });
});

describe('tryParseJsonish — edge classification', () => {
  test('scalars and quoted strings are kind "json"', () => {
    expect(tryParseJsonish('  42  ').kind).toBe('json');
    expect(tryParseJsonish('"hello"').kind).toBe('json');
    expect(tryParseJsonish('null').kind).toBe('json');
    expect(tryParseJsonish('true').kind).toBe('json');
    expect(tryParseJsonish('false').kind).toBe('json');
  });

  test('NDJSON with trailing junk after a valid object on a line → none', () => {
    expect(tryParseJsonish('{"a":1}\n{"b":2} oops').kind).toBe('none');
  });

  test('NDJSON tolerates CRLF line endings', () => {
    const r = tryParseJsonish('{"a":1}\r\n{"b":2}\r\n');
    expect(r.kind).toBe('ndjson');
    if (r.kind === 'ndjson') expect(r.values).toHaveLength(2);
  });

  test('a multi-line single JSON document is "json", not "ndjson"', () => {
    expect(tryParseJsonish('{\n  "a": 1,\n  "b": 2\n}').kind).toBe('json');
  });

  test('prose that merely contains JSON-looking fragments → none', () => {
    expect(tryParseJsonish('The result is {"a":1} and more text').kind).toBe('none');
    expect(tryParseJsonish('[done]').kind).toBe('none');
  });

  test('size guard boundary: at limit allowed, one over rejected', () => {
    const fill = (n: number) => '"' + 'a'.repeat(n) + '"';
    const atLimit = fill(JSON_PRETTY_MAX_BYTES - 2); // total length === limit
    expect(atLimit.length).toBe(JSON_PRETTY_MAX_BYTES);
    expect(tryParseJsonish(atLimit).kind).toBe('json');
    const over = fill(JSON_PRETTY_MAX_BYTES - 1); // length === limit + 1
    expect(over.length).toBe(JSON_PRETTY_MAX_BYTES + 1);
    expect(tryParseJsonish(over).kind).toBe('none');
  });
});

describe('formatJson — known, intentional reformatting (Raw stays lossless)', () => {
  test('numbers are canonicalized (1.0→1, 1e3→1000) — expected for a formatted view', () => {
    const parsed = tryParseJsonish('{"a":1.0,"b":1e3,"c":-0}');
    expect(parsed.kind).toBe('json');
    if (parsed.kind === 'json') {
      expect(formatJson(parsed.value)).toBe('{\n  "a": 1,\n  "b": 1000,\n  "c": 0\n}');
    }
  });

  test('duplicate keys collapse on parse — surfaced only in the formatted view', () => {
    const parsed = tryParseJsonish('{"k":1,"k":2}');
    expect(parsed.kind).toBe('json');
    if (parsed.kind === 'json') expect(formatJson(parsed.value)).toBe('{\n  "k": 2\n}');
  });
});
