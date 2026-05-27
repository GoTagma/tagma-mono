import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SaveAsDialog } from '../src/components/SaveAsDialog';

describe('SaveAsDialog', () => {
  test('allows callers to provide an input aria label', () => {
    const html = renderToStaticMarkup(
      <SaveAsDialog
        defaultValue="release-flow"
        inputAriaLabel="Workflow name"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Workflow name"');
    expect(html).not.toContain('aria-label="Pipeline name"');
  });
});
