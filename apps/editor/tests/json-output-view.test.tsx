import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsonOutputView } from '../src/components/run/JsonOutputView';

const PRE = 'select-text text-[10px] font-mono text-tagma-text';

describe('JsonOutputView — non-JSON passthrough (zero regression)', () => {
  const html = renderToStaticMarkup(
    <JsonOutputView label="Output" raw="All done — refactored auth." preClassName={PRE} />,
  );

  test('renders the raw text verbatim', () => {
    expect(html).toContain('All done');
    expect(html).toContain('refactored auth.');
  });

  test('shows no Formatted/Raw toggle and no copy control', () => {
    expect(html).not.toContain('>Formatted<');
    expect(html).not.toContain('>Raw<');
    expect(html).not.toContain('Copy Output');
  });

  test('keeps the section label', () => {
    expect(html).toContain('Output');
  });
});

describe('JsonOutputView — JSON gets the toggle + highlight', () => {
  const raw = JSON.stringify({ title: 'Refactor', count: 3, ok: true, note: null });
  const html = renderToStaticMarkup(<JsonOutputView label="Output" raw={raw} preClassName={PRE} />);

  test('renders both toggle buttons', () => {
    expect(html).toContain('>Formatted<');
    expect(html).toContain('>Raw<');
  });

  test('renders a copy control for the section', () => {
    expect(html).toContain('Copy Output');
  });

  test('defaults to the formatted (highlighted) view', () => {
    // key color class proves the highlighter ran, not a raw <pre> dump
    expect(html).toContain('text-tagma-accent');
    expect(html).toContain('text-tagma-warning'); // the number 3
    expect(html).toContain('text-tagma-info'); // true / null
    expect(html).toContain('title');
  });
});

describe('JsonOutputView — NDJSON', () => {
  const raw = ['{"type":"step_start"}', '{"type":"text","part":{"text":"hi"}}'].join('\n');
  const html = renderToStaticMarkup(
    <JsonOutputView label="Normalized Output" raw={raw} preClassName={PRE} />,
  );

  test('shows the toggle', () => {
    expect(html).toContain('>Formatted<');
    expect(html).toContain('>Raw<');
  });

  test('renders every record with a separating divider', () => {
    expect(html).toContain('step_start');
    expect(html).toContain('border-t');
  });
});
