import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DialogModal } from '../src/components/DialogModal';
import { ConfirmModal } from '../src/components/ConfirmModal';
import { UnsavedChangesModal } from '../src/components/AppOverlays';

describe('modal accessibility', () => {
  test('global modals expose dialog semantics to assistive tech', () => {
    const dialog = renderToStaticMarkup(
      <DialogModal
        info={{ type: 'error', title: 'Could not save', details: ['Disk rejected the write'] }}
        onClose={() => {}}
      />,
    );
    const confirm = renderToStaticMarkup(
      <ConfirmModal
        info={{
          title: 'Delete pipeline',
          details: ['This cannot be undone'],
          confirmLabel: 'Delete',
          onConfirm: () => {},
        }}
        onClose={() => {}}
      />,
    );
    const unsaved = renderToStaticMarkup(
      <UnsavedChangesModal
        action={{ title: 'Unsaved changes', details: ['Save before switching?'], run: () => {} }}
        onSave={() => {}}
        onDiscard={() => {}}
        onCancel={() => {}}
      />,
    );

    for (const html of [dialog, confirm, unsaved]) {
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('aria-labelledby=');
    }
  });
});
