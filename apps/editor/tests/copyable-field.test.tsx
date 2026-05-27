import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyableField, copyableTextValue } from '../src/components/panels/CopyableField';

describe('copyable inspector fields', () => {
  test('normalizes field values before copying', () => {
    expect(copyableTextValue('abc')).toBe('abc');
    expect(copyableTextValue(42)).toBe('42');
    expect(copyableTextValue(null)).toBe('');
    expect(copyableTextValue(undefined)).toBe('');
  });

  test('renders a copy button with an explicit accessible label', () => {
    const el = (
      <CopyableField value="abc" label="Copy task name">
        <input value="abc" readOnly />
      </CopyableField>
    );

    const serialized = renderToStaticMarkup(el);
    expect(serialized).toContain('Copy task name');
    expect(serialized).toContain('button');
  });
});
