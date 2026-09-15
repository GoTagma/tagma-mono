import { afterEach, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DesktopChatIdentityStore,
  executeDesktopChatIdentityRequest,
} from '../src/chat-identities';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'tagma-chat-identities-')))
      throw new Error('Unexpected fixture');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-identities-'));
  roots.push(root);
  const directory = join(root, 'identities');
  return {
    directory,
    workspace: join(root, 'workspace'),
    otherWorkspace: join(root, 'other'),
    store: new DesktopChatIdentityStore(directory),
  };
}

test('a fresh desktop process recovers its exact renderer, selected conversation and original credential', () => {
  const { directory, workspace, store } = fixture();
  const renderer = store.rendererId(workspace);
  store.selectConversation(workspace, renderer, 'conversation-one');
  const key = store.conversationKey(workspace, renderer, 'conversation-one', true);
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  const restarted = new DesktopChatIdentityStore(directory);
  expect(restarted.rendererId(workspace)).toBe(renderer);
  expect(restarted.selectedConversation(workspace)).toBe('conversation-one');
  expect(restarted.conversationKey(workspace, renderer, 'conversation-one', false)).toBe(key);
  expect(restarted.conversationKey(workspace, renderer, 'conversation-one', true)).toBe(key);
});

test('reading legacy history cannot create credentials and workspace/renderer mismatches fail closed', () => {
  const { workspace, otherWorkspace, store } = fixture();
  const renderer = store.rendererId(workspace);
  expect(store.conversationKey(workspace, renderer, 'missing-history', false)).toBeNull();
  expect(store.selectedConversation(workspace)).toBeNull();
  const key = store.conversationKey(workspace, renderer, 'conversation-one', true);
  const otherRenderer = store.rendererId(otherWorkspace);
  expect(otherRenderer).not.toBe(renderer);
  expect(() => store.conversationKey(otherWorkspace, renderer, 'conversation-one', false)).toThrow(
    'identity_mismatch',
  );
  expect(() => store.selectConversation(workspace, otherRenderer, 'conversation-one')).toThrow(
    'identity_mismatch',
  );
  expect(store.conversationKey(otherWorkspace, otherRenderer, 'conversation-one', true)).not.toBe(
    key,
  );
});

test('a corrupt existing identity file is never regenerated or overwritten', () => {
  const { directory, workspace, store } = fixture();
  store.rendererId(workspace);
  const file = join(directory, readdirSync(directory)[0]!);
  writeFileSync(file, '{ broken');
  expect(() => new DesktopChatIdentityStore(directory).rendererId(workspace)).toThrow(
    'identity_invalid',
  );
  expect(readFileSync(file, 'utf8')).toBe('{ broken');
});

test('a dangling identity link is rejected instead of replaced with a fresh identity', () => {
  const { directory, workspace, store } = fixture();
  store.rendererId(workspace);
  const file = join(directory, readdirSync(directory)[0]!);
  unlinkSync(file);
  symlinkSync(join(directory, 'missing-target'), file, 'junction');
  expect(() => new DesktopChatIdentityStore(directory).rendererId(workspace)).toThrow(
    'identity_invalid',
  );
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
});

test('IPC identity requests are restricted to the bound workspace and fixed fields', () => {
  const { workspace, otherWorkspace, store } = fixture();
  const rendererId = executeDesktopChatIdentityRequest(store, workspace, {
    method: 'renderer',
    workspace,
  });
  expect(rendererId).toBe(store.rendererId(workspace));
  expect(() =>
    executeDesktopChatIdentityRequest(store, workspace, {
      method: 'renderer',
      workspace: otherWorkspace,
    }),
  ).toThrow('identity_mismatch');
  expect(() =>
    executeDesktopChatIdentityRequest(store, null, { method: 'renderer', workspace }),
  ).toThrow('identity_mismatch');
  expect(() =>
    executeDesktopChatIdentityRequest(store, workspace, {
      method: 'credential',
      workspace,
      rendererId,
      conversationId: 'conversation',
      create: true,
      script: 'unexpected',
    }),
  ).toThrow('identity_invalid');
  expect(
    executeDesktopChatIdentityRequest(store, workspace, {
      method: 'credential',
      workspace,
      rendererId,
      conversationId: 'conversation',
      create: false,
    }),
  ).toBeNull();
});
