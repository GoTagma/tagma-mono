import { describe, expect, test } from 'bun:test';
import { renderInputsBlock, renderOutputSchemaBlock } from './prompt-doc';
import type { PortDef } from './types';

function recordWithProtoKey(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ['__proto__']: value })) as Record<string, unknown>;
}

describe('prompt document data records', () => {
  test('does not render inherited Object prototype fields as inputs', () => {
    const inputs: PortDef[] = [
      { name: 'constructor', type: 'json' },
      { name: 'toString', type: 'json' },
    ];

    expect(renderInputsBlock(inputs, {})).toBeNull();
  });

  test('renders an own __proto__ input value', () => {
    const inputs: PortDef[] = [{ name: '__proto__', type: 'json' }];

    expect(renderInputsBlock(inputs, recordWithProtoKey({ safe: true }))).toEqual({
      label: 'Inputs',
      content: '__proto__: {"safe":true}',
    });
  });

  test('keeps __proto__ in the generated output example', () => {
    const outputs: PortDef[] = [{ name: '__proto__', type: 'json' }];

    const block = renderOutputSchemaBlock(outputs);

    expect(block?.content).toContain('Example final line: {"__proto__":null}');
  });
});
