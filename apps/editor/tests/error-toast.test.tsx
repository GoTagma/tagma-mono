import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorToast } from '../src/components/ErrorToast';
import { usePipelineStore } from '../src/store/pipeline-store';
import { YAML_EDIT_LOCK_MESSAGE } from '../src/store/yaml-edit-lock-store';

const serverSnapshot = usePipelineStore.getInitialState();

function renderToast(message: string, contained = false): string {
  usePipelineStore.setState({ errorMessage: message });
  serverSnapshot.errorMessage = message;
  return renderToStaticMarkup(<ErrorToast contained={contained} />);
}

afterEach(() => {
  usePipelineStore.setState({ errorMessage: null });
  serverSnapshot.errorMessage = null;
});

describe('ErrorToast', () => {
  test('renders the YAML edit lock protection as a neutral status', () => {
    const html = renderToast(YAML_EDIT_LOCK_MESSAGE, true);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('border-tagma-border');
    expect(html).toContain('aria-label="Dismiss status"');
    expect(html).not.toContain('tagma-error');
  });

  test('keeps arbitrary failures as red alerts', () => {
    const html = renderToast('Something broke');

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('border-tagma-error');
    expect(html).toContain('text-tagma-error');
    expect(html).toContain('aria-label="Dismiss error"');
    expect(html).not.toContain('role="status"');
  });
});
