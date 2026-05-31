import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'OPENCODE_CONFIG_CONTENT',
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

let tempRoot: string;
let tagmaCwd: string;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'tagma-opencode-isolation-'));
  tagmaCwd = join(tempRoot, '.tagma');
  mkdirSync(tagmaCwd, { recursive: true });
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
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

test('embedded opencode server env enables Basic Auth with generated credentials', () => {
  const auth = createOpencodeServerAuth();
  const env = buildOpencodeEnv(tagmaCwd, auth);

  expect(env.OPENCODE_SERVER_USERNAME).toBe(auth.username);
  expect(env.OPENCODE_SERVER_PASSWORD).toBe(auth.password);
  expect(auth.authorization).toBe(
    `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
  );
  expect(auth.password.length).toBeGreaterThanOrEqual(32);
});

test('embedded opencode env isolates config homes while reusing user login data', () => {
  const externalRoot = join(tempRoot, 'user-home');
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

  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  writeJson(paths.workspaceConfigPath, {
    provider: { workspaceLocal: providerDef },
  });
  const env = buildOpencodeEnv(tagmaCwd);

  expect(env.HOME).toBe(paths.home);
  expect(env.USERPROFILE).toBe(paths.home);
  expect(env.APPDATA).toBe(paths.appData);
  expect(env.LOCALAPPDATA).toBe(paths.localAppData);
  expect(env.XDG_CONFIG_HOME).toBe(paths.configHome);
  expect(env.OPENCODE_CONFIG_DIR).toBe(paths.configDir);
  expect(env.XDG_DATA_HOME).toBe(paths.dataHome);
  expect(env.XDG_STATE_HOME).toBe(paths.stateHome);
  expect(env.XDG_CACHE_HOME).toBe(paths.cacheHome);
  expect(env.HOME).not.toContain(externalRoot);
  expect(env.XDG_CONFIG_HOME).not.toContain(externalRoot);
  expect(env.XDG_DATA_HOME).toContain(externalRoot);
  expect(env.XDG_STATE_HOME).toContain(externalRoot);

  const injectedConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;
  expect(injectedConfig).toMatchObject({
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
    provider: { workspacelocal: providerDef },
  });
  expect(readJson(paths.globalConfigPath)).toMatchObject({ plugin: [] });
  expect(readJson(paths.workspaceConfigPath)).toMatchObject({ plugin: [] });
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
  const env = buildOpencodeEnv(tagmaCwd);
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
