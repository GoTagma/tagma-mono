import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const editorRoot = join(import.meta.dir, '..');

test('sidecar wires the opt-in Chat Operation V2 Host surface and closes its authority store', () => {
  const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf8');

  expect(source).toContain(
    "import { registerChatOperationV2Routes } from './routes/chat-operations.js';",
  );
  expect(source).toContain('createChatOperationV2ShadowService');
  expect(source).toContain('const chatOperationV2Service = createChatOperationV2ShadowService({');
  expect(source).toContain('createManagedOpenCodeReadonlyInvocationRunner');
  expect(source).toContain('ensureRealTagmaDirectory(canonicalWorkspaceRoot)');
  expect(source).toContain('registerChatOperationV2Routes(');
  expect(source).toContain('registerChatOperationV2LegacyStageFence(app);');
  expect(source).not.toContain('registerChatYamlStagingRoutes(app);');
  expect(source.indexOf('registerChatOperationV2LegacyStageFence(app);')).toBeGreaterThan(
    source.indexOf('app.use(resolveWorkspace);'),
  );
  expect(source.indexOf('registerChatOperationV2LegacyStageFence(app);')).toBeLessThan(
    source.indexOf('if (!isYamlEditLockProtectedMutation(req.path)) return next();'),
  );
  expect(source).toContain('enabled: true,');
  expect(source).toContain('mutationsEnabled: true,');
  expect(source).toContain(
    '{ enabled: true, mutationsEnabled: false, service: chatOperationV2Service }',
  );
  expect(source).toContain('service: chatOperationV2Service,');
  expect(source).toContain('createInputResolver: async (workDir, request) =>');
  expect(source).toContain('readManagedOpenCodeSelectedModelAuthority(');
  expect(source).toContain('selectedModel,');
  expect(source).toContain('clarificationInputResolver: (workDir, request) =>');
  expect(source).toContain('chatOperationV2HostInventoryFor(workDir)');
  expect(source).toContain('buildChatOperationV2HostInventory({');
  expect(source).toContain('resolveChatOperationV2CreateAdmission(request, {');
  expect(source).toContain(
    "mutationMode: chatOperationV2ProductionCutover ? 'production' : 'internal'",
  );
  expect(source).toContain('productionCutover: chatOperationV2ProductionCutover');
  expect(source).toContain('authoringResultPersistenceFactory: ({ store }) =>');
  expect(source).toContain('authoringTargetResolverFactory: ({ canonicalWorkspaceRoot }) =>');
  expect(source).toContain('authoringCommitCoordinatorFactory: (input) =>');
  expect(source).toContain('authoringRuntimeFactory: (input) =>');
  expect(source).toContain('createManagedChatOperationV2AuthoringRuntime({');
  expect(source).toContain('createManagedChatOperationV2CommitCoordinatorFactory()');
  expect(source).toContain(
    'commitPreparer: (prepareInput) => coordinator.prepareCommit(prepareInput)',
  );
  expect(source).toContain('{ enabled: false }');
  expect(source).toContain("'/api/chat/operations',");
  expect(source).toContain('const chatOperationV2Close = chatOperationV2Service?.close();');
  expect(source).toContain('await chatOperationV2Close;');
});

test('sidecar wires migration/reset through the always-on V2 Host authority', () => {
  const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf8');

  expect(source).toContain('createChatOperationV2MigrationService({');
  expect(source).toContain('const chatOperationV2MigrationService = chatOperationV2Service');
  expect(source).toContain('enabled: true,');
  expect(source).not.toContain('isChatOperationV2MigrationServiceEnabled');
  expect(source).toContain(
    'getTrustedStore: () => chatOperationV2Service.getTrustedMigrationStore()',
  );
  expect(source).toContain('closeTrustedStoreForOfflineMigration()');
  expect(source).not.toContain('ensureChatOperationV2StartupMigration');
  expect(source).toContain('deriveChatOperationV2ResetRequestIdentity(clientRequestId)');
  expect(source).toContain('registerChatOperationV2ControlRoutes(');
  expect(source).not.toMatch(/resetControlData\([\s\S]{0,300}(?:databasePath|keyPath|rawKey)/);
});

test('sidecar gives only the exact V2 subtree its declared JSON budget and typed parse errors', () => {
  const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf8');
  const scopedParser = source.indexOf(
    'registerChatOperationV2BodyParser(app, chatOperationV2MutationsEnabled);',
  );
  const legacyParser = source.indexOf("app.use(express.json({ limit: '5mb' }));");

  expect(scopedParser).toBeGreaterThan(-1);
  expect(legacyParser).toBeGreaterThan(scopedParser);
  expect(source).toContain('registerChatOperationV2BodyParser,');
  expect(source).toContain('registerChatOperationV2MutationFence(');
});

test('sidecar diagnostics remain lazy and content-minimized for Chat Operation V2', () => {
  const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf8');

  expect(source).toContain('registerServerDiagnosticsContributor');
  expect(source).toContain("'chatOperationV2'");
  expect(source).toContain('chatOperationV2Service?.getDiagnosticsSnapshot(workspaceKey)');
  expect(source).not.toMatch(/chatOperationV2[^\n]*(?:databasePath|controlDir|keyId|\.key)/);
});

test('Chat Operation V2 SSE participates in the existing EventSource auth fallback', () => {
  const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf8');

  expect(source).toContain("req.path === '/api/chat/operations/events'");
});
