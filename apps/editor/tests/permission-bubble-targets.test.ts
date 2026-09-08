import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PermissionBubble } from '../src/components/chat/PermissionBubble';
import type { PendingPermission } from '../src/utils/permission-store-helpers';

const permission: PendingPermission = {
  workspaceKey: '/workspace',
  id: 'permission-1',
  sessionID: 'operation-1',
  tool: 'read',
  title: 'read: workspace_resource',
  protocol: 'current',
  createdAt: 1,
  metadata: { chatOperationProtocol: 'v2' },
};

test('shows bounded draft-relative targets and omission without changing approval choices', () => {
  const html = renderToStaticMarkup(
    createElement(PermissionBubble, {
      permission: {
        ...permission,
        targetSummary: { targets: ['data/current.yaml', 'assets/<sample>.json'], omitted: 2 },
      },
    }),
  );
  expect(html).toContain('Read files');
  expect(html).toContain('Targets in this draft');
  expect(html).toContain('data/current.yaml');
  expect(html).toContain('assets/&lt;sample&gt;.json');
  expect(html).toContain('2 additional target(s) hidden');
  expect(html).toContain('Allow once');
  expect(html).toContain('Always for this chat');
  expect(html).toContain('Reject');
});

test('keeps old permission records usable with explicit missing target detail', () => {
  expect(renderToStaticMarkup(createElement(PermissionBubble, { permission }))).toContain(
    'Details unavailable',
  );
});
