import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Session } from '../src/api/opencode-chat';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
const editorSettingsPatches: unknown[] = [];
const editorSettingsPatchHeaders: Array<Record<string, string>> = [];
let editorSettingsModel: { providerID: string; modelID: string } | null = null;
let providersShouldFail = false;
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { setClientWorkspace } = await import('../src/api/client');
const { resetOpencodeClient } = await import('../src/api/opencode-chat');
const { useChatStore } = await import('../src/store/chat-store');
const { useEditorSettingsStore } = await import('../src/store/editor-settings-store');

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    if (url === '/api/editor-settings' && method === 'GET') {
      return Promise.resolve(jsonResponse(makeEditorSettings(editorSettingsModel)));
    }
    if (url === '/api/editor-settings' && method === 'PATCH') {
      const patch = JSON.parse(String(init?.body ?? '{}'));
      editorSettingsPatches.push(patch);
      editorSettingsPatchHeaders.push((init?.headers as Record<string, string> | undefined) ?? {});
      editorSettingsModel = patch.opencodeChatModel ?? null;
      return Promise.resolve(
        jsonResponse({ ...makeEditorSettings(editorSettingsModel), revision: 1 }),
      );
    }
    if (url === '/api/opencode/chat/ensure') {
      return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
    }
    if (url === '/api/opencode/custom-providers') {
      return Promise.resolve(
        jsonResponse({ providers: [], paths: { global: null, workspace: null } }),
      );
    }
    if (url === 'http://opencode.test/config/providers') {
      if (providersShouldFail) {
        return Promise.reject(new Error('provider catalog unavailable'));
      }
      return Promise.resolve(
        jsonResponse({
          providers: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: {
                claude: modelDef('claude'),
              },
            },
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5': modelDef('gpt-5'),
              },
            },
          ],
          default: { anthropic: 'claude' },
        }),
      );
    }
    if (url === 'http://opencode.test/agent') {
      return Promise.resolve(jsonResponse([]));
    }
    if (url === 'http://opencode.test/session' && method === 'GET') {
      return Promise.resolve(jsonResponse([]));
    }
    if (url === 'http://opencode.test/provider') {
      return Promise.resolve(jsonResponse({ all: [], connected: [], default: {} }));
    }
    if (url === 'http://opencode.test/provider/auth') {
      return Promise.resolve(jsonResponse({}));
    }
    if (url === 'http://opencode.test/session' && method === 'POST') {
      return Promise.resolve(jsonResponse({ id: 'new-session' }));
    }
    if (url === 'http://opencode.test/session/existing/message') {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
});

function makeEditorSettings(opencodeChatModel: { providerID: string; modelID: string } | null) {
  return {
    autoInstallDeclaredPlugins: false,
    chatDirtyConflictPolicy: 'ask',
    autoSaveEnabled: true,
    autoSaveIntervalSec: 30,
    viewMode: 'production',
    pythonAgent: {
      enabled: false,
      interpreterCommand: null,
      interpreterArgs: [],
      interpreterVersion: null,
      venvPath: null,
      configuredAt: null,
    },
    opencodeChatModel,
  };
}

function modelDef(id: string) {
  return {
    id,
    name: id,
    status: 'active',
    limit: { context: 100_000, output: 8_192 },
    capabilities: { reasoning: false },
  };
}

afterEach(() => {
  storage.clear();
  editorSettingsPatches.length = 0;
  editorSettingsPatchHeaders.length = 0;
  editorSettingsModel = null;
  providersShouldFail = false;
  setClientWorkspace(null);
  resetOpencodeClient();
  useEditorSettingsStore.getState().updateLocal(null);
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    providers: [],
    agents: [],
    model: null,
    sessions: [],
    currentSessionId: null,
    messages: [],
    sending: false,
    reconciling: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    pendingPermissions: [],
  } as never);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('chat model persistence', () => {
  test('persists the selected model per workspace', () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    setClientWorkspace('C:/repo-b');
    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw ?? '{}') as {
      workspaces?: Record<string, { model?: { providerID: string; modelID: string } }>;
    };

    expect(persisted.workspaces?.['C:/repo-a']?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(persisted.workspaces?.['C:/repo-b']?.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
  });

  test('mirrors the selected model to workspace editor settings for desktop restarts', async () => {
    setClientWorkspace('C:/repo-a');

    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    await Promise.resolve();

    expect(editorSettingsPatches).toEqual([
      {
        opencodeChatModel: {
          providerID: 'anthropic',
          modelID: 'claude',
        },
      },
    ]);
    expect(editorSettingsPatchHeaders[0]?.['X-Tagma-Workspace']).toBe('C:/repo-a');
  });

  test('restores the selected model from workspace editor settings when browser storage is empty', async () => {
    editorSettingsModel = { providerID: 'openai', modelID: 'gpt-5' };
    setClientWorkspace('C:/repo-a');

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(storage.getItem('tagma.chat.v2')).toContain('"providerID":"openai"');
  });

  test('does not erase the persisted model when provider reconciliation fails', async () => {
    editorSettingsModel = { providerID: 'openai', modelID: 'gpt-5' };
    providersShouldFail = true;
    setClientWorkspace('C:/repo-a');

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(editorSettingsPatches).toEqual([]);
    expect(editorSettingsModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('keeps the selected model when switching or creating chat sessions', async () => {
    const model = { providerID: 'anthropic', modelID: 'claude' };
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      model,
      sessions: [{ id: 'existing' } as Session],
      currentSessionId: 'old',
    } as never);

    await useChatStore.getState().selectSession('existing');
    expect(useChatStore.getState().model).toEqual(model);

    await useChatStore.getState().newSession();
    expect(useChatStore.getState().model).toEqual(model);
  });
});
