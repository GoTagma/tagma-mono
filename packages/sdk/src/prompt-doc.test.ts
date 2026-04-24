import { describe, expect, test } from 'bun:test';
import {
  appendContext,
  prependContext,
  promptDocumentFromString,
  renderInputsBlock,
  renderOutputSchemaBlock,
  serializePromptDocument,
} from './prompt-doc';
import type { PortDef, PromptContextBlock, PromptDocument } from './types';

// ─── renderInputsBlock ────────────────────────────────────────────────

describe('renderInputsBlock', () => {
  test('returns null when no inputs declared', () => {
    expect(renderInputsBlock(undefined, {})).toBeNull();
    expect(renderInputsBlock([], { any: 'x' })).toBeNull();
  });

  test('returns null when declared inputs have no resolved values', () => {
    const ports: PortDef[] = [{ name: 'city', type: 'string' }];
    // values missing entirely — block is noise, omit it
    expect(renderInputsBlock(ports, {})).toBeNull();
  });

  test('renders name: value per declared input', () => {
    const ports: PortDef[] = [
      { name: 'city', type: 'string' },
      { name: 'id', type: 'number' },
    ];
    const block = renderInputsBlock(ports, { city: 'Shanghai', id: 42 });
    expect(block).not.toBeNull();
    expect(block!.label).toBe('Inputs');
    expect(block!.content).toBe('city: "Shanghai"\nid: 42');
  });

  test('appends # description comment when provided', () => {
    const ports: PortDef[] = [
      { name: 'city', type: 'string', description: 'Target city' },
    ];
    const block = renderInputsBlock(ports, { city: 'Shanghai' })!;
    expect(block.content).toBe('city: "Shanghai"  # Target city');
  });

  test('preserves declaration order, not input-map iteration order', () => {
    const ports: PortDef[] = [
      { name: 'b', type: 'string' },
      { name: 'a', type: 'string' },
    ];
    // Values object has 'a' first, 'b' second — block should still emit 'b' first.
    const block = renderInputsBlock(ports, { a: 'x', b: 'y' })!;
    expect(block.content).toBe('b: "y"\na: "x"');
  });

  test('skips ports whose values were not resolved', () => {
    const ports: PortDef[] = [
      { name: 'a', type: 'string' },
      { name: 'b', type: 'string' },
    ];
    const block = renderInputsBlock(ports, { a: 'x' })!;
    expect(block.content).toBe('a: "x"');
  });

  test('JSON-encodes non-primitive values', () => {
    const ports: PortDef[] = [{ name: 'payload', type: 'json' }];
    const block = renderInputsBlock(ports, { payload: { a: 1, b: [2, 3] } })!;
    expect(block.content).toBe('payload: {"a":1,"b":[2,3]}');
  });

  test('booleans render verbatim, not quoted', () => {
    const ports: PortDef[] = [{ name: 'flag', type: 'boolean' }];
    const block = renderInputsBlock(ports, { flag: true })!;
    expect(block.content).toBe('flag: true');
  });
});

// ─── renderOutputSchemaBlock ──────────────────────────────────────────

describe('renderOutputSchemaBlock', () => {
  test('returns null when no outputs declared', () => {
    expect(renderOutputSchemaBlock(undefined)).toBeNull();
    expect(renderOutputSchemaBlock([])).toBeNull();
  });

  test('instructs the model to emit final-line JSON', () => {
    const ports: PortDef[] = [{ name: 'city', type: 'string' }];
    const block = renderOutputSchemaBlock(ports)!;
    expect(block.label).toBe('Output Format');
    expect(block.content).toMatch(/final line/i);
  });

  test('lists each port with its type', () => {
    const ports: PortDef[] = [
      { name: 'city', type: 'string', description: 'Target city' },
      { name: 'temp', type: 'number' },
    ];
    const block = renderOutputSchemaBlock(ports)!;
    expect(block.content).toContain('- city (string): Target city');
    expect(block.content).toContain('- temp (number)');
  });

  test('includes enum values in the type hint', () => {
    const ports: PortDef[] = [
      { name: 'color', type: 'enum', enum: ['red', 'green', 'blue'] },
    ];
    const block = renderOutputSchemaBlock(ports)!;
    expect(block.content).toContain('color (enum (one of: "red", "green", "blue"))');
  });

  test('example object uses declared defaults when present', () => {
    const ports: PortDef[] = [
      { name: 'score', type: 'number', default: 0.5 },
      { name: 'note', type: 'string', default: 'n/a' },
    ];
    const block = renderOutputSchemaBlock(ports)!;
    // The example line is `Example final line: {"score":0.5,"note":"n/a"}`.
    expect(block.content).toContain('"score":0.5');
    expect(block.content).toContain('"note":"n/a"');
  });

  test('example uses type-appropriate placeholders when no default', () => {
    const ports: PortDef[] = [
      { name: 's', type: 'string' },
      { name: 'n', type: 'number' },
      { name: 'b', type: 'boolean' },
      { name: 'j', type: 'json' },
    ];
    const block = renderOutputSchemaBlock(ports)!;
    expect(block.content).toContain('"s":"..."');
    expect(block.content).toContain('"n":0');
    expect(block.content).toContain('"b":false');
    expect(block.content).toContain('"j":null');
  });

  test('example uses first enum value when present', () => {
    const ports: PortDef[] = [
      { name: 'tier', type: 'enum', enum: ['low', 'high'] },
    ];
    const block = renderOutputSchemaBlock(ports)!;
    expect(block.content).toContain('"tier":"low"');
  });
});

// ─── prependContext / appendContext ──────────────────────────────────

describe('prependContext / appendContext', () => {
  const block: PromptContextBlock = { label: 'X', content: 'x' };

  test('prependContext puts block at front without mutating input', () => {
    const doc: PromptDocument = { contexts: [{ label: 'Y', content: 'y' }], task: 't' };
    const next = prependContext(doc, block);
    expect(next.contexts.map((c) => c.label)).toEqual(['X', 'Y']);
    // Original untouched — immutability is part of the contract for
    // middleware safety (the engine compares doc identity to detect
    // changes in some paths).
    expect(doc.contexts).toHaveLength(1);
    expect(doc.contexts[0]!.label).toBe('Y');
    expect(next.task).toBe('t');
  });

  test('appendContext puts block at end without mutating input', () => {
    const doc: PromptDocument = { contexts: [{ label: 'Y', content: 'y' }], task: 't' };
    const next = appendContext(doc, block);
    expect(next.contexts.map((c) => c.label)).toEqual(['Y', 'X']);
    expect(doc.contexts).toHaveLength(1);
  });

  test('prepend + serialize produces [X] block above the task', () => {
    const doc = promptDocumentFromString('do the thing');
    const next = prependContext(doc, { label: 'Inputs', content: 'city: "Shanghai"' });
    const text = serializePromptDocument(next);
    expect(text).toBe('[Inputs]\ncity: "Shanghai"\n\ndo the thing');
  });
});
