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
  test('renders the YAML edit lock protection as a neutral status in both layouts', () => {
    const viewportHtml = renderToast(YAML_EDIT_LOCK_MESSAGE);
    const containedHtml = renderToast(YAML_EDIT_LOCK_MESSAGE, true);

    for (const html of [viewportHtml, containedHtml]) {
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('border-tagma-border');
      expect(html).toContain('aria-label="Dismiss status"');
      expect(html).not.toContain('tagma-error');
    }

    expect(viewportHtml).toContain('max-h-[calc(100dvh-1rem)]');
    expect(viewportHtml).toContain('sm:w-[420px]');
    expect(viewportHtml).toContain('sm:max-h-[calc(100dvh-2rem)]');

    expect(containedHtml).toContain('pointer-events-auto');
    expect(containedHtml).toContain('max-h-[min(18rem,45dvh)]');
    expect(containedHtml).toContain('w-full');
    expect(containedHtml).toContain('shrink-0');
    expect(containedHtml).not.toContain('sm:w-[420px]');
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
