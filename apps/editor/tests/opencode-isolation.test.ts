import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OPENCODE_SCHEMA_URL,
  REDACTED_API_KEY,
  listCustomProviders,
  prepareEmbeddedOpencodeRuntime,
  redactProviderApiKey,
  resolveOpencodeRuntimePaths,
  upsertCustomProvider,
  validateCustomProvider,
} from '../server/opencode-config';
import { buildOpencodeEnv, createOpencodeServerAuth } from '../server/opencode-lifecycle';
import {
  prepareManagedOpencodeDatabase,
  releaseManagedOpencodeDatabaseInitialization,
  resolveManagedOpencodeDatabaseConfig,
  type PreparedManagedOpencodeDatabase,
} from '../server/opencode-database';

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_DB',
  'OPENCODE_CONFIG_CONTENT',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
] as const;

const providerDef = {
  name: 'Local test',
  npm: '@ai-sdk/openai-compatible',
  options: {
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: 'no-auth-required',
  },
  models: {
    'llama3.1:8b': { name: 'Llama 3.1 8B' },
  },
};

const unstableOpenAICompatibleProviderDef = {
  name: 'Proxy LLM',
  npm: '@ai-sdk/openai-compatible',
  options: {
    baseURL: 'https://proxy.example.test/v1',
    apiKey: '{env:PROXY_LLM_API_KEY}',
  },
  models: {
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro' },
    'safe-coder': { name: 'Safe Coder' },
  },
};

const deepseekAnthropicProviderDef = {
  name: 'DeepSeek Anthropic',
  npm: '@ai-sdk/anthropic',
  options: {
    baseURL: 'https://api.deepseek.com/anthropic',
    apiKey: '{env:DEEPSEEK_API_KEY}',
  },
  models: {
    'deepseek-v4-pro': { name: 'DeepSeek V4 Pro' },
  },
};

let tempRoot: string;
let tagmaCwd: string;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let preparedDatabases: PreparedManagedOpencodeDatabase[];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function prepareTestManagedDatabase(): PreparedManagedOpencodeDatabase {
  const runtime = prepareEmbeddedOpencodeRuntime(tagmaCwd);
  const prepared = prepareManagedOpencodeDatabase(
    resolveManagedOpencodeDatabaseConfig(runtime.root),
  );
  preparedDatabases.push(prepared);
  return prepared;
}

function buildTestOpencodeEnv(auth = createOpencodeServerAuth()): Record<string, string> {
  return buildOpencodeEnv(tagmaCwd, prepareTestManagedDatabase(), auth);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'tagma-opencode-isolation-'));
  tagmaCwd = join(tempRoot, '.tagma');
  mkdirSync(tagmaCwd, { recursive: true });
  preparedDatabases = [];
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const prepared of preparedDatabases) {
    releaseManagedOpencodeDatabaseInitialization(prepared);
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

test('embedded opencode runtime sanitizes configs to the safe Tagma subset', () => {
  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  writeJson(paths.globalConfigPath, {
    $schema: OPENCODE_SCHEMA_URL,
    plugin: ['oh-my-openagent'],
    mcp: { unsafe: {} },
    agent: { unsafe: {} },
    command: { unsafe: {} },
    provider: { local: providerDef },
    model: 'local/llama3.1:8b',
    small_model: 'local/llama3.1:8b',
  });
  writeJson(paths.workspaceConfigPath, {
    plugin: ['workspace-plugin'],
    hook: { unsafe: true },
    provider: { workspaceLocal: providerDef },
  });

  prepareEmbeddedOpencodeRuntime(tagmaCwd);

  expect(readFileSync(join(paths.root, '.gitignore'), 'utf-8')).toBe('*\n!.gitignore\n');

  const globalConfig = readJson(paths.globalConfigPath);
  expect(globalConfig).toMatchObject({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
    model: 'local/llama3.1:8b',
    small_model: 'local/llama3.1:8b',
    provider: { local: providerDef },
  });
  expect(globalConfig).not.toHaveProperty('mcp');
  expect(globalConfig).not.toHaveProperty('agent');
  expect(globalConfig).not.toHaveProperty('command');

  const workspaceConfig = readJson(paths.workspaceConfigPath);
  expect(workspaceConfig).toMatchObject({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
    provider: { workspacelocal: providerDef },
  });
  expect(workspaceConfig).not.toHaveProperty('hook');
});

test('custom provider ids are normalized to lowercase before persistence', () => {
  upsertCustomProvider('workspace', tempRoot, 'Alibaba', providerDef);

  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  const workspaceConfig = readJson(paths.workspaceConfigPath);
  expect(workspaceConfig).toMatchObject({
    provider: {
      alibaba: providerDef,
    },
  });
  expect(workspaceConfig.provider as Record<string, unknown>).not.toHaveProperty('Alibaba');

  const providers = listCustomProviders(tempRoot);
  expect(providers.map((p) => p.id)).toContain('alibaba');
});

test('custom provider validation accepts dotted ids and preserves advanced OpenCode config', () => {
  const advanced = validateCustomProvider(
    'llama.cpp',
    {
      ...providerDef,
      description: 'kept top-level metadata',
      options: {
        ...providerDef.options,
        timeout: false,
        chunkTimeout: 60_000,
        setCacheKey: true,
        customOption: { nested: true },
      },
      models: {
        'llama.cpp/qwen': {
          name: 'Qwen via llama.cpp',
          npm: '@ai-sdk/openai-compatible',
          options: { temperature: 0 },
          customModelFlag: true,
        },
      },
    },
    { scope: 'global' },
  );

  expect(advanced.description).toBe('kept top-level metadata');
  expect(advanced.options.timeout).toBe(false);
  expect(advanced.options.chunkTimeout).toBe(60_000);
  expect(advanced.options.setCacheKey).toBe(true);
  expect(advanced.options.customOption).toEqual({ nested: true });
  expect(advanced.models['llama.cpp/qwen']).toMatchObject({
    name: 'Qwen via llama.cpp',
    npm: '@ai-sdk/openai-compatible',
    options: { temperature: 0 },
    customModelFlag: true,
  });
});

test('custom provider validation uses model provider.npm and preserves opaque top-level npm', () => {
  const validated = validateCustomProvider(
    'mixed-sdk-local',
    {
      ...providerDef,
      models: {
        'anthropic-model': {
          name: 'Anthropic model',
          npm: 'ignored-top-level-marker',
          provider: {
            npm: '  @ai-sdk/anthropic  ',
            transport: { compatibility: 'strict' },
            customProviderFlag: true,
          },
        },
        'api-only-model': {
          provider: {
            api: 'https://local.example/v1',
            transport: { compatibility: 'strict' },
          },
        },
      },
    },
    { scope: 'global' },
  );

  upsertCustomProvider('global', tempRoot, 'mixed-sdk-local', validated);

  const listed = listCustomProviders(tempRoot).find(
    (provider) => provider.scope === 'global' && provider.id === 'mixed-sdk-local',
  );
  expect(listed?.def.models['anthropic-model']).toEqual({
    name: 'Anthropic model',
    npm: 'ignored-top-level-marker',
    provider: {
      npm: '@ai-sdk/anthropic',
      transport: { compatibility: 'strict' },
      customProviderFlag: true,
    },
  });
  expect(listed?.def.models['api-only-model']).toEqual({
    provider: {
      api: 'https://local.example/v1',
      transport: { compatibility: 'strict' },
    },
  });
});

test('custom provider validation rejects invalid model provider overrides', () => {
  const definitionWithProvider = (provider: unknown): unknown => ({
    ...providerDef,
    models: {
      'mixed-sdk-model': {
        name: 'Mixed SDK model',
        provider,
      },
    },
  });
  const invalidCases: Array<{ label: string; provider: unknown; message: RegExp }> = [
    {
      label: 'non-object provider',
      provider: '@ai-sdk/anthropic',
      message: /model .*provider.*object/i,
    },
    {
      label: 'non-string provider npm',
      provider: { npm: 42 },
      message: /provider\.npm.*non-empty string/i,
    },
    {
      label: 'unsupported provider npm',
      provider: { npm: '@untrusted/provider' },
      message: /provider\.npm.*not in the allowlist/i,
    },
    {
      label: 'non-string provider api',
      provider: { api: 42 },
      message: /provider\.api.*non-empty string/i,
    },
  ];

  for (const { label, provider, message } of invalidCases) {
    expect(
      () =>
        validateCustomProvider('mixed-sdk-local', definitionWithProvider(provider), {
          scope: 'global',
        }),
      label,
    ).toThrow(message);
  }
});

test('custom provider reasoning variants survive validation and persistence roundtrip', () => {
  const validated = validateCustomProvider(
    'reasoning-local',
    {
      ...providerDef,
      models: {
        'reasoning-model': {
          name: 'Reasoning model',
          reasoning: true,
          variants: {
            low: {
              reasoningEffort: 'low',
              providerOptions: {
                local: { budgetTokens: 2_048 },
              },
            },
            high: { reasoningEffort: 'high', disabled: true },
          },
        },
      },
    },
    { scope: 'global' },
  );

  upsertCustomProvider('global', tempRoot, 'reasoning-local', validated);

  const listed = listCustomProviders(tempRoot).find(
    (provider) => provider.scope === 'global' && provider.id === 'reasoning-local',
  );
  expect(listed?.def.models['reasoning-model']).toEqual({
    name: 'Reasoning model',
    reasoning: true,
    variants: {
      low: {
        reasoningEffort: 'low',
        providerOptions: {
          local: { budgetTokens: 2_048 },
        },
      },
      high: { reasoningEffort: 'high', disabled: true },
    },
  });
});

test('custom provider validation rejects malformed reasoning variants', () => {
  const definitionWithModel = (model: Record<string, unknown>): unknown => ({
    ...providerDef,
    models: {
      'reasoning-model': {
        name: 'Reasoning model',
        ...model,
      },
    },
  });
  const invalidCases: Array<{ label: string; model: Record<string, unknown>; message: RegExp }> = [
    {
      label: 'non-boolean reasoning',
      model: { reasoning: 'yes' },
      message: /reasoning.*boolean/i,
    },
    {
      label: 'non-object variants map',
      model: { variants: ['low'] },
      message: /variants.*object/i,
    },
    {
      label: 'non-object variant options',
      model: { variants: { low: 'reasoningEffort=low' } },
      message: /variant "low".*object/i,
    },
    {
      label: 'non-boolean disabled flag',
      model: { variants: { high: { disabled: 'yes' } } },
      message: /variant "high".*disabled.*boolean/i,
    },
    {
      label: 'oversized variant options',
      model: { variants: { high: { vendorPayload: 'x'.repeat(32_769) } } },
      message: /variant "high".*too large/i,
    },
    {
      label: 'too many variants',
      model: {
        variants: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`variant-${index}`, {}]),
        ),
      },
      message: /at most 32 variants/i,
    },
    {
      label: 'blank variant id',
      model: { variants: { '   ': {} } },
      message: /variant id.*non-empty/i,
    },
    {
      label: 'variant id with control characters',
      model: { variants: { 'bad\nvariant': {} } },
      message: /variant id.*control/i,
    },
    {
      label: 'overlong variant id',
      model: { variants: { ['v'.repeat(65)]: {} } },
      message: /variant id.*64 characters/i,
    },
    {
      label: 'unsafe variant id',
      model: { variants: JSON.parse('{"__proto__":{}}') as Record<string, unknown> },
      message: /variant id.*reserved/i,
    },
    {
      label: 'duplicate variant id after trimming',
      model: { variants: { low: {}, ' low ': {} } },
      message: /duplicate variant id "low".*trimming/i,
    },
    {
      label: 'unsafe variant option key',
      model: {
        variants: {
          low: JSON.parse('{"constructor":{}}') as Record<string, unknown>,
        },
      },
      message: /variant "low".*reserved option key "constructor"/i,
    },
  ];

  for (const { label, model, message } of invalidCases) {
    expect(
      () =>
        validateCustomProvider('reasoning-local', definitionWithModel(model), { scope: 'global' }),
      label,
    ).toThrow(message);
  }
});

test('workspace custom providers reject plaintext API keys', () => {
  expect(() =>
    validateCustomProvider(
      'secretprovider',
      {
        ...providerDef,
        options: {
          ...providerDef.options,
          apiKey: 'plain-provider-token',
        },
      },
      { scope: 'workspace' },
    ),
  ).toThrow(/plaintext API key/i);

  expect(() =>
    validateCustomProvider(
      'secretprovider',
      {
        ...providerDef,
        options: {
          ...providerDef.options,
          apiKey: '{env:TAGMA_TEST_PROVIDER_KEY}',
        },
      },
      { scope: 'workspace' },
    ),
  ).not.toThrow();
});

test('custom provider redaction hides API keys and sensitive headers', () => {
  const redacted = redactProviderApiKey({
    ...providerDef,
    options: {
      ...providerDef.options,
      apiKey: 'plain-provider-token',
      headers: {
        Authorization: 'Bearer plain-token',
        'X-Trace': 'trace-id',
      },
    },
  });

  expect(redacted.options.apiKey).toBe(REDACTED_API_KEY);
  expect(redacted.options.headers?.Authorization).toBe(REDACTED_API_KEY);
  expect(redacted.options.headers?.['X-Trace']).toBe('trace-id');
  expect(redacted.hasApiKey).toBe(true);
});

test('embedded opencode runtime normalizes existing uppercase provider ids', () => {
  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  expect(paths.managedToolsDir).toBe(join(paths.configDir, 'tools'));
  writeJson(paths.workspaceConfigPath, {
    provider: { Alibaba: providerDef },
  });

  prepareEmbeddedOpencodeRuntime(tagmaCwd);

  const workspaceConfig = readJson(paths.workspaceConfigPath);
  expect(workspaceConfig).toMatchObject({
    provider: {
      alibaba: providerDef,
    },
  });
  expect(workspaceConfig.provider as Record<string, unknown>).not.toHaveProperty('Alibaba');
});

test('embedded opencode runtime keeps OpenAI-compatible model paths', () => {
  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  writeJson(paths.workspaceConfigPath, {
    model: 'proxyllm/deepseek-v4-pro',
    small_model: 'proxyllm/safe-coder',
    provider: {
      proxyllm: unstableOpenAICompatibleProviderDef,
      deepseekanthropic: deepseekAnthropicProviderDef,
    },
  });

  const env = buildTestOpencodeEnv();
  const injectedConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
    model?: string;
    small_model?: string;
    provider?: Record<string, { models?: Record<string, unknown> }>;
  };

  expect(injectedConfig.model).toBe('proxyllm/deepseek-v4-pro');
  expect(injectedConfig.small_model).toBe('proxyllm/safe-coder');
  expect(Object.keys(injectedConfig.provider?.proxyllm?.models ?? {})).toEqual([
    'deepseek-v4-pro',
    'safe-coder',
  ]);
  expect(Object.keys(injectedConfig.provider?.deepseekanthropic?.models ?? {})).toEqual([
    'deepseek-v4-pro',
  ]);
});

test('preparing an unchanged embedded runtime does not rewrite workspace config', () => {
  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  writeJson(paths.workspaceConfigPath, {
    provider: { proxyllm: unstableOpenAICompatibleProviderDef },
  });
  prepareEmbeddedOpencodeRuntime(tagmaCwd);
  const stableTime = new Date('2001-02-03T04:05:06.000Z');
  utimesSync(paths.workspaceConfigPath, stableTime, stableTime);
  const before = readFileSync(paths.workspaceConfigPath, 'utf-8');

  prepareEmbeddedOpencodeRuntime(tagmaCwd);

  expect(readFileSync(paths.workspaceConfigPath, 'utf-8')).toBe(before);
  expect(statSync(paths.workspaceConfigPath).mtimeMs).toBe(stableTime.getTime());
});

test('embedded opencode server env enables Basic Auth with generated credentials', () => {
  const auth = createOpencodeServerAuth();
  const env = buildTestOpencodeEnv(auth);

  expect(env.OPENCODE_SERVER_USERNAME).toBe(auth.username);
  expect(env.OPENCODE_SERVER_PASSWORD).toBe(auth.password);
  expect(auth.authorization).toBe(
    `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
  );
  expect(auth.password.length).toBeGreaterThanOrEqual(32);
});

test('embedded opencode env isolates config homes while reusing user login data', () => {
  const externalRoot = join(tempRoot, 'user-home');
  const managedDatabaseState = join(tempRoot, 'tagma-user-data', 'opencode-state');
  process.env.HOME = join(externalRoot, 'home');
  process.env.USERPROFILE = join(externalRoot, 'profile');
  process.env.APPDATA = join(externalRoot, 'appdata');
  process.env.LOCALAPPDATA = join(externalRoot, 'localappdata');
  process.env.XDG_CONFIG_HOME = join(externalRoot, 'config');
  process.env.OPENCODE_CONFIG_DIR = join(externalRoot, 'opencode-config');
  process.env.XDG_DATA_HOME = join(externalRoot, 'data');
  process.env.XDG_STATE_HOME = join(externalRoot, 'state');
  process.env.XDG_CACHE_HOME = join(externalRoot, 'cache');
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: ['oh-my-openagent'] });
  process.env.TAGMA_OPENCODE_DB_STATE_DIR = managedDatabaseState;
  process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';

  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  writeJson(paths.workspaceConfigPath, {
    provider: { workspaceLocal: providerDef },
  });
  const env = buildTestOpencodeEnv();

  expect(env.HOME).toBe(paths.home);
  expect(env.USERPROFILE).toBe(paths.home);
  expect(env.APPDATA).toBe(paths.appData);
  expect(env.LOCALAPPDATA).toBe(paths.localAppData);
  expect(env.XDG_CONFIG_HOME).toBe(paths.configHome);
  expect(env.OPENCODE_CONFIG_DIR).toBe(paths.configDir);
  expect(env.XDG_DATA_HOME).toBe(paths.dataHome);
  expect(env.XDG_STATE_HOME).toBe(paths.stateHome);
  expect(env.XDG_CACHE_HOME).toBe(paths.cacheHome);
  expect(env.OPENCODE_DB?.startsWith(join(managedDatabaseState, 'databases', 'schema-v1-'))).toBe(
    true,
  );
  expect(env.OPENCODE_DB?.endsWith('opencode.db')).toBe(true);
  expect(env.HOME).not.toContain(externalRoot);
  expect(env.XDG_CONFIG_HOME).not.toContain(externalRoot);
  expect(env.XDG_DATA_HOME).toContain(externalRoot);
  expect(env.XDG_STATE_HOME).toContain(externalRoot);
  expect(env.OPENCODE_DB).not.toContain(externalRoot);

  const injectedConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;
  expect(injectedConfig).toMatchObject({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
    provider: { workspacelocal: providerDef },
  });
  expect(readJson(paths.globalConfigPath)).toMatchObject({ plugin: [] });
  expect(readJson(paths.workspaceConfigPath)).toMatchObject({ plugin: [] });
});

test('OpenCode env stays bound to the one prepared generation passed by its launcher', () => {
  const stateDir = join(tempRoot, 'opencode-state');
  process.env.TAGMA_OPENCODE_DB_STATE_DIR = stateDir;
  process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
  const prepared = prepareTestManagedDatabase();

  process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '2';
  const env = buildOpencodeEnv(tagmaCwd, prepared, createOpencodeServerAuth());

  expect(env.OPENCODE_DB).toBe(prepared.databasePath);
  expect(env.OPENCODE_DB.includes('schema-v1-')).toBe(true);
  expect(env.OPENCODE_DB.includes('schema-v2-')).toBe(false);
});

test('user-global plugin declarations are outside the embedded opencode search path', () => {
  const externalRoot = join(tempRoot, 'user-home');
  const userConfigHome = join(externalRoot, 'config');
  writeJson(join(userConfigHome, 'opencode', 'opencode.json'), {
    plugin: ['evil-plugin'],
    provider: { evil: providerDef },
  });
  process.env.HOME = join(externalRoot, 'home');
  process.env.USERPROFILE = join(externalRoot, 'profile');
  process.env.APPDATA = join(externalRoot, 'appdata');
  process.env.LOCALAPPDATA = join(externalRoot, 'localappdata');
  process.env.XDG_CONFIG_HOME = userConfigHome;

  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  const env = buildTestOpencodeEnv();
  const injectedConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;

  expect(env.HOME).toBe(paths.home);
  expect(env.USERPROFILE).toBe(paths.home);
  expect(env.APPDATA).toBe(paths.appData);
  expect(env.LOCALAPPDATA).toBe(paths.localAppData);
  expect(env.XDG_CONFIG_HOME).toBe(paths.configHome);
  expect(env.OPENCODE_CONFIG_DIR).toBe(paths.configDir);
  expect(env.XDG_CONFIG_HOME).not.toContain(externalRoot);
  expect(readJson(paths.globalConfigPath)).toEqual({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
  });
  expect(injectedConfig).toEqual({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
  });
});
