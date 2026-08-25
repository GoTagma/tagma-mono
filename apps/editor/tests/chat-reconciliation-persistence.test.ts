import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

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
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { setClientWorkspace } = await import('../src/api/client');
const { resetOpencodeClient } = await import('../src/api/opencode-chat');
const {
  loadPersistedChatYamlReconciliationQueue,
  loadPersistedChatYamlResults,
  savePersistedChatYamlReconciliationQueue,
  savePersistedChatYamlResults,
} = await import('../src/store/chat-persist');
const { applySseEvent, useChatStore } = await import('../src/store/chat-store');
type ChatState = ReturnType<typeof useChatStore.getState>;
type ChatFinishedTurn = ChatState['finishedTurnQueue'][number];
type ChatYamlSessionResult = ChatState['sessionYamlResults'][string];

function stagedTurn(id = 'finished-stage-1', workspace = 'C:/repo'): ChatFinishedTurn {
  return {
    id,
    sessionId: 'session-1',
    endedAt: 1_000,
    hidden: false,
    termination: 'completed',
    yamlSnapshotBeforeSend: {
      workDir: workspace,
      activePath: `${workspace}/.tagma/build/build.yaml`,
      localEditRevision: 7,
      yamlEditLockId: 'yaml-lock-stage-1',
      staging: {
        id: 'stage-1',
        agentTagmaDir: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma`,
        activeRelativePath: 'build/build.yaml',
        activeStagedPath: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/build/build.yaml`,
        entries: [
          {
            name: 'build.yaml',
            stagedPath: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/build/build.yaml`,
            relativePath: 'build/build.yaml',
            sourcePath: `${workspace}/.tagma/build/build.yaml`,
            pipelineName: 'Build',
            contentHash: 'content-before',
            layoutHash: null,
            requirementsHash: 'requirements-before',
            trialPlanHash: null,
          },
        ],
      },
    },
  };
}

function failedStagedTurn(id: string, workspace: string): ChatFinishedTurn {
  return {
    ...stagedTurn(id, workspace),
    reconcileFailure: {
      message: 'Finalize failed before commit.',
      attempt: 1,
      failedAt: 2_000,
    },
  };
}

function hiddenRuntime(turn: ChatFinishedTurn): ChatState['sessionStates'][string] {
  return {
    model: null,
    reasoningEffort: null,
    messages: [],
    sending: true,
    pendingUserText: 'Background pipeline update.',
    queuedMessages: [],
    queuedDispatchMode: null,
    flushing: false,
    pendingPermissions: [],
    turnStartedAt: 900,
    turnAssistantMessageIds: [],
    lastActivityAt: 950,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [],
    yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
    skipYamlReconciliation: false,
    postChatYamlAction: null,
  };
}

function pipelineResult(input: {
  resultId: string;
  turnId: string;
  messageId: string;
  sessionId?: string;
  workspace?: string;
  path?: string;
  finalYamlContentHash?: string;
  finalYamlMtimeMs?: number;
  completedAt?: number;
}): ChatYamlSessionResult {
  const workspace = input.workspace ?? 'C:/repo';
  const path = input.path ?? workspace + '/.tagma/build/build.yaml';
  return {
    resultId: input.resultId,
    turnId: input.turnId,
    messageId: input.messageId,
    sessionId: input.sessionId ?? 'session-1',
    workspaceKey: workspace,
    kind: 'refresh-current',
    path,
    name: 'build.yaml',
    pipelineName: 'Build',
    status: 'ready',
    compile: {
      success: true,
      summary: 'Compiled.',
      validation: { errors: [], warnings: [] },
    },
    reconcile: {
      outcome: 'adopted',
      conflicts: [],
      localBranchPersisted: false,
      resultPath: path,
      compileSuccess: true,
    },
    ...(input.finalYamlContentHash === undefined
      ? {}
      : { finalYamlContentHash: input.finalYamlContentHash }),
    ...(input.finalYamlMtimeMs === undefined ? {} : { finalYamlMtimeMs: input.finalYamlMtimeMs }),
    completedAt: input.completedAt ?? 2_000,
  };
}

function resetChatState(): void {
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    currentSessionId: null,
    sessions: [],
    sessionStates: {},
    messages: [],
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
    reconciling: false,
    flushing: false,
    turnStartedAt: null,
    lastFinishedTurn: null,
    finishedTurnQueue: [],
    sessionYamlResults: {},
    turnYamlResults: {},
    yamlSnapshotBeforeSend: null,
    completionWarning: null,
  } as Partial<ChatState>);
}

beforeEach(() => {
  storage.clear();
  setClientWorkspace(null);
  resetChatState();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  const workspace = 'C:/repo';
  setClientWorkspace(workspace);
  resetOpencodeClient();
  setClientWorkspace(null);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('unfinished Chat YAML reconciliation persistence', () => {
  test('round-trips a versioned message result ledger and rejects staging or malformed targets', () => {
    const valid = pipelineResult({
      resultId: 'result-1',
      turnId: 'turn-1',
      messageId: 'assistant-1',
    });
    const staging = pipelineResult({
      resultId: 'result-staging',
      turnId: 'turn-staging',
      messageId: 'assistant-staging',
      path: 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/build/build.yaml',
    });
    const outside = pipelineResult({
      resultId: 'result-outside',
      turnId: 'turn-outside',
      messageId: 'assistant-outside',
      path: 'C:/other/.tagma/build/build.yaml',
    });
    const mismatchedReconcile = {
      ...pipelineResult({
        resultId: 'result-mismatch',
        turnId: 'turn-mismatch',
        messageId: 'assistant-mismatch',
      }),
      reconcile: {
        ...valid.reconcile!,
        resultPath: 'C:/repo/.tagma/other/other.yaml',
      },
    };
    const malformed = { ...valid, resultId: '', messageId: 'assistant-malformed' };

    savePersistedChatYamlResults('C:/repo', {
      'assistant-1': [valid],
      'assistant-staging': [staging],
      'assistant-outside': [outside],
      'assistant-mismatch': [mismatchedReconcile],
      'assistant-malformed': [malformed],
    });

    expect(loadPersistedChatYamlResults('C:/repo')).toMatchObject({
      'assistant-1': [valid],
    });
    expect(storage.getItem('tagma.chat.v2')).toContain('pipelineResults');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('.chat-staging');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('result-outside');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('result-mismatch');
  });

  test('round-trips an unchanged reconcile result instead of dropping it', () => {
    const unchanged = {
      ...pipelineResult({
        resultId: 'result-unchanged',
        turnId: 'turn-unchanged',
        messageId: 'assistant-unchanged',
      }),
      reconcile: {
        outcome: 'unchanged' as const,
        conflicts: [],
        localBranchPersisted: false,
        resultPath: 'C:/repo/.tagma/build/build.yaml',
        compileSuccess: true,
      },
    };

    savePersistedChatYamlResults('C:/repo', {
      'assistant-unchanged': [unchanged],
    });

    expect(loadPersistedChatYamlResults('C:/repo')).toMatchObject({
      'assistant-unchanged': [unchanged],
    });
  });

  test('hydrates a legacy message-anchored result by assigning stable identities', () => {
    const legacy = pipelineResult({
      resultId: 'discarded',
      turnId: 'discarded',
      messageId: 'assistant-legacy',
    }) as Record<string, unknown>;
    delete legacy.resultId;
    delete legacy.turnId;
    delete legacy.workspaceKey;
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': {
            pipelineResults: { version: 1, results: [legacy] },
          },
        },
      }),
    );

    const first = loadPersistedChatYamlResults('C:/repo')['assistant-legacy']?.[0];
    const second = loadPersistedChatYamlResults('C:/repo')['assistant-legacy']?.[0];
    expect(first).toMatchObject({
      turnId: 'assistant-legacy',
      messageId: 'assistant-legacy',
      workspaceKey: 'C:/repo',
    });
    expect(first?.resultId).toMatch(/^legacy_/);
    expect(second?.resultId).toBe(first?.resultId);
  });

  test('drops an unanchored legacy result with an actionable compatibility diagnostic', () => {
    const legacy = pipelineResult({
      resultId: 'legacy-result',
      turnId: 'legacy-turn',
      messageId: 'assistant-legacy',
    }) as Record<string, unknown>;
    delete legacy.messageId;
    delete legacy.turnId;
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': { pipelineResults: { version: 1, results: [legacy] } },
        },
      }),
    );
    const issues: Array<{ kind: string; message: string }> = [];

    const loaded = loadPersistedChatYamlResults('C:/repo', (issue) => issues.push(issue));

    expect(loaded).toEqual({});
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('legacy-unanchored-result');
    expect(issues[0]?.message).toContain('cannot be restored safely');
    expect(issues[0]?.message).toContain('workspace pipeline list');
    expect(issues[0]?.message).toContain('assistant text');
  });

  test('keeps the newest 500 results and records a durable truncation diagnostic', () => {
    const results: Record<string, ChatYamlSessionResult[]> = {};
    for (let index = 0; index <= 500; index += 1) {
      const messageId = `assistant-${index}`;
      results[messageId] = [
        pipelineResult({
          resultId: `result-${index}`,
          turnId: `turn-${index}`,
          messageId,
          completedAt: index,
        }),
      ];
    }
    const issues: Array<{ kind: string; message: string }> = [];

    savePersistedChatYamlResults('C:/repo', results, (issue) => issues.push(issue));

    const loaded = loadPersistedChatYamlResults('C:/repo');
    expect(Object.values(loaded).flat()).toHaveLength(500);
    expect(loaded['assistant-0']).toBeUndefined();
    expect(loaded['assistant-500']?.[0]?.resultId).toBe('result-500');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('ledger-truncated');
    expect(issues[0]?.message).toContain('newest 500');
    expect(issues[0]?.message).toContain('pipeline files were not deleted');
    const raw = JSON.parse(storage.getItem('tagma.chat.v2')!);
    expect(raw.workspaces['C:/repo'].pipelineResults.truncated).toBe(true);
    const reloadIssues: Array<{ kind: string; message: string }> = [];
    loadPersistedChatYamlResults('C:/repo', (issue) => reloadIssues.push(issue));
    expect(reloadIssues.map((issue) => issue.kind)).toEqual(['ledger-truncated']);

    setClientWorkspace('C:/repo');
    const firstFiveHundred = Object.fromEntries(Object.entries(results).slice(0, 500));
    useChatStore.setState({
      turnYamlResults: firstFiveHundred,
      completionWarning: null,
    } as Partial<ChatState>);
    useChatStore.getState().setTurnYamlResult(results['assistant-500']![0]!);
    expect(useChatStore.getState().completionWarning).toContain('newest 500');
  });

  test('appends and deduplicates results per assistant message while keeping the latest session projection', () => {
    setClientWorkspace('C:/repo');
    const first = pipelineResult({
      resultId: 'result-1',
      turnId: 'turn-1',
      messageId: 'assistant-1',
      finalYamlMtimeMs: 1_234,
      completedAt: 1_000,
    });
    const second = pipelineResult({
      resultId: 'result-2',
      turnId: 'turn-2',
      messageId: 'assistant-2',
      completedAt: 2_000,
      path: 'C:/repo/.tagma/release/release.yaml',
    });
    const sibling = pipelineResult({
      resultId: 'result-3',
      turnId: 'turn-2',
      messageId: 'assistant-2',
      completedAt: 2_001,
      path: 'C:/repo/.tagma/verify/verify.yaml',
    });

    useChatStore.getState().setTurnYamlResult(first);
    useChatStore.getState().setTurnYamlResult(second);
    useChatStore.getState().setTurnYamlResult(sibling);
    useChatStore.getState().setTurnYamlResult({ ...second, status: 'blocked' });

    expect(useChatStore.getState().turnYamlResults).toEqual({
      'assistant-1': [first],
      'assistant-2': [{ ...second, status: 'blocked' }, sibling],
    });
    expect(useChatStore.getState().sessionYamlResults['session-1']).toMatchObject({
      resultId: 'result-3',
      messageId: 'assistant-2',
    });
    expect(loadPersistedChatYamlResults('C:/repo')).toMatchObject(
      useChatStore.getState().turnYamlResults,
    );
  });

  test('relocates every matching durable branch result and its session metadata after a concurrent fork', async () => {
    setClientWorkspace('C:/repo');
    const sourcePath = 'C:/repo/.tagma/build/build.yaml';
    const copyPath = 'C:/repo/.tagma/build-copy-1/build-copy-1.yaml';
    const matching = pipelineResult({
      resultId: 'result-matching',
      turnId: 'turn-matching',
      messageId: 'assistant-matching',
      sessionId: 'session-matching',
      path: sourcePath,
      finalYamlContentHash: 'a'.repeat(40),
      finalYamlMtimeMs: 1_234,
    });
    const legacy = pipelineResult({
      resultId: 'result-legacy',
      turnId: 'turn-legacy',
      messageId: 'assistant-legacy',
      sessionId: 'session-legacy',
      path: sourcePath,
    });
    const stale = pipelineResult({
      resultId: 'result-stale',
      turnId: 'turn-stale',
      messageId: 'assistant-stale',
      sessionId: 'session-stale',
      path: sourcePath,
      finalYamlContentHash: 'b'.repeat(40),
      finalYamlMtimeMs: 1_234,
    });
    useChatStore.getState().setTurnYamlResult(matching);
    useChatStore.getState().setTurnYamlResult(legacy);
    useChatStore.getState().setTurnYamlResult(stale);
    useChatStore.setState({
      sessions: [
        {
          id: 'session-metadata-only',
          metadata: {
            tagma: {
              schema: 1,
              source: 'desktop-chat',
              workspacePath: 'C:/repo',
              yamlPath: sourcePath,
            },
          },
        },
      ],
    } as never);

    const synced: Array<{ sessionId: string; path: string; reason?: string }> = [];
    const originalSync = useChatStore.getState().syncSessionYamlTarget;
    useChatStore.setState({
      syncSessionYamlTarget: async (sessionId, _workspaceKey, path, reason) => {
        synced.push({ sessionId, path, reason });
      },
    } as Partial<ChatState>);
    try {
      await useChatStore.getState().relocateChatYamlResults('C:/repo', [
        {
          fromPath: sourcePath,
          fromContentHash: 'a'.repeat(40),
          fromMtimeMs: 1_234,
          entry: {
            path: copyPath,
            name: 'build-copy-1.yaml',
            pipelineName: 'Build Copy 1',
            contentHash: 'c'.repeat(40),
            mtimeMs: 2_345,
          } as never,
        },
      ]);
    } finally {
      useChatStore.setState({ syncSessionYamlTarget: originalSync } as Partial<ChatState>);
    }

    for (const messageId of ['assistant-matching', 'assistant-legacy']) {
      expect(useChatStore.getState().turnYamlResults[messageId]?.[0]).toMatchObject({
        kind: 'open-created',
        path: copyPath,
        name: 'build-copy-1.yaml',
        pipelineName: 'Build Copy 1',
        finalYamlContentHash: 'c'.repeat(40),
        finalYamlMtimeMs: 2_345,
        reconcile: { outcome: 'forked', resultPath: copyPath },
      });
    }
    expect(useChatStore.getState().turnYamlResults['assistant-stale']?.[0]).toMatchObject({
      path: sourcePath,
      finalYamlContentHash: 'b'.repeat(40),
      finalYamlMtimeMs: 1_234,
    });
    expect(loadPersistedChatYamlResults('C:/repo')['assistant-matching']?.[0]?.path).toBe(copyPath);
    expect(synced).toEqual([
      { sessionId: 'session-matching', path: copyPath, reason: 'branch-relocated' },
      { sessionId: 'session-legacy', path: copyPath, reason: 'branch-relocated' },
      { sessionId: 'session-metadata-only', path: copyPath, reason: 'branch-relocated' },
    ]);
  });

  test('keeps relocation retryable when OpenCode metadata cannot be updated', async () => {
    setClientWorkspace('C:/repo');
    const sourcePath = 'C:/repo/.tagma/build/build.yaml';
    const result = pipelineResult({
      resultId: 'result-retryable',
      turnId: 'turn-retryable',
      messageId: 'assistant-retryable',
      sessionId: 'session-retryable',
      path: sourcePath,
      finalYamlMtimeMs: 1_234,
    });
    useChatStore.getState().setTurnYamlResult(result);
    const originalSync = useChatStore.getState().syncSessionYamlTarget;
    useChatStore.setState({
      syncSessionYamlTarget: async () => {
        throw new Error('metadata unavailable');
      },
    } as Partial<ChatState>);
    try {
      await expect(
        useChatStore.getState().relocateChatYamlResults('C:/repo', [
          {
            fromPath: sourcePath,
            fromContentHash: 'a'.repeat(40),
            fromMtimeMs: 1_234,
            entry: {
              path: 'C:/repo/.tagma/build-copy-1/build-copy-1.yaml',
              name: 'build-copy-1.yaml',
              pipelineName: 'Build Copy 1',
              contentHash: 'c'.repeat(40),
              mtimeMs: 2_345,
            } as never,
          },
        ]),
      ).rejects.toThrow('metadata unavailable');
    } finally {
      useChatStore.setState({ syncSessionYamlTarget: originalSync } as Partial<ChatState>);
    }

    expect(useChatStore.getState().turnYamlResults['assistant-retryable']?.[0]?.path).toBe(
      sourcePath,
    );
    expect(loadPersistedChatYamlResults('C:/repo')['assistant-retryable']?.[0]?.path).toBe(
      sourcePath,
    );
  });

  test('records a verified live YAML mtime by exact result id without touching a same-path sibling', () => {
    setClientWorkspace('C:/repo');
    const older = pipelineResult({
      resultId: 'result-older',
      turnId: 'turn-older',
      messageId: 'assistant-older',
      completedAt: 1_000,
    });
    const latest = pipelineResult({
      resultId: 'result-latest',
      turnId: 'turn-latest',
      messageId: 'assistant-latest',
      completedAt: 2_000,
      // Deliberately the same path: updates must never match by path.
      path: older.path,
    });
    useChatStore.getState().setTurnYamlResult(older);
    useChatStore.getState().setTurnYamlResult(latest);

    useChatStore.getState().recordTurnYamlResultFinalMtime('result-older', 4_321);

    expect(useChatStore.getState().turnYamlResults['assistant-older']?.[0]).toMatchObject({
      resultId: 'result-older',
      finalYamlMtimeMs: 4_321,
    });
    expect(
      useChatStore.getState().turnYamlResults['assistant-latest']?.[0]?.finalYamlMtimeMs,
    ).toBeUndefined();
    expect(
      useChatStore.getState().sessionYamlResults['session-1']?.finalYamlMtimeMs,
    ).toBeUndefined();
    expect(loadPersistedChatYamlResults('C:/repo')['assistant-older']?.[0]?.finalYamlMtimeMs).toBe(
      4_321,
    );
    expect(
      loadPersistedChatYamlResults('C:/repo')['assistant-latest']?.[0]?.finalYamlMtimeMs,
    ).toBeUndefined();

    useChatStore.getState().recordTurnYamlResultFinalMtime('result-latest', 5_678);
    expect(useChatStore.getState().sessionYamlResults['session-1']).toMatchObject({
      resultId: 'result-latest',
      finalYamlMtimeMs: 5_678,
    });
  });

  test('does not enqueue YAML reconciliation for a classified discussion turn', () => {
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: 'session-discussion',
      sending: true,
      pendingUserText: 'Explain the product concept.',
      messages: [
        {
          info: {
            id: 'assistant-discussion',
            sessionID: 'session-discussion',
            role: 'assistant',
          },
          parts: [],
        },
      ],
      yamlSnapshotBeforeSend: null,
      skipYamlReconciliation: true,
      finishedTurnQueue: [],
    } as never);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: 'session-discussion',
          error: { name: 'ProviderError', data: { message: 'The answer stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(useChatStore.getState().skipYamlReconciliation).toBe(false);
  });

  test('captures the final assistant message as the durable result anchor', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: turn.sessionId,
      sending: true,
      pendingUserText: 'Update the pipeline.',
      turnStartedAt: 900,
      turnAssistantMessageIds: ['assistant-tool', 'assistant-final'],
      messages: [
        {
          info: { id: 'assistant-tool', sessionID: turn.sessionId, role: 'assistant' },
          parts: [],
        },
        {
          info: { id: 'assistant-final', sessionID: turn.sessionId, role: 'assistant' },
          parts: [],
        },
      ],
      yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
      finishedTurnQueue: [],
    } as never);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: turn.sessionId,
          error: { name: 'ProviderError', data: { message: 'The model stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    const finished = useChatStore.getState().finishedTurnQueue[0];
    expect(finished?.assistantMessageId).toBe('assistant-final');
    expect(finished?.yamlSnapshotBeforeSend?.resultMessageId).toBe('assistant-final');
    expect(finished?.yamlSnapshotBeforeSend?.resultTurnId).toBe(finished?.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]).toMatchObject({
      assistantMessageId: 'assistant-final',
      yamlSnapshotBeforeSend: {
        resultMessageId: 'assistant-final',
        resultTurnId: finished?.id,
      },
    });
  });

  test('keeps the visible result anchor when a hidden repair continuation finishes', () => {
    const turn = stagedTurn();
    const inheritedSnapshot = {
      ...turn.yamlSnapshotBeforeSend!,
      resultTurnId: 'visible-turn',
      resultMessageId: 'assistant-visible',
    };
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: 'visible-session',
      sessionStates: {
        [turn.sessionId!]: {
          ...hiddenRuntime({ ...turn, yamlSnapshotBeforeSend: inheritedSnapshot }),
          messages: [
            {
              info: { id: 'assistant-repair', sessionID: turn.sessionId, role: 'assistant' },
              parts: [],
            },
          ],
          turnAssistantMessageIds: ['assistant-repair'],
        },
      },
      finishedTurnQueue: [],
    } as never);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: turn.sessionId,
          error: { name: 'ProviderError', data: { message: 'The repair stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue[0]).toMatchObject({
      assistantMessageId: 'assistant-visible',
      yamlSnapshotBeforeSend: {
        resultTurnId: 'visible-turn',
        resultMessageId: 'assistant-visible',
      },
    });
  });

  test('persists completed staged targets without dropping the unfinished turn', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({ finishedTurnQueue: [turn], lastFinishedTurn: turn } as never);
    savePersistedChatYamlReconciliationQueue('C:/repo', [turn]);

    useChatStore.getState().markFinishedTurnYamlTargetCompleted(turn.id, 'Build\\Build.yaml');
    useChatStore.getState().markFinishedTurnYamlTargetCompleted(turn.id, 'build/build.yaml');

    expect(useChatStore.getState().finishedTurnQueue[0]?.completedYamlRelativePaths).toEqual([
      'Build/Build.yaml',
    ]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]).toMatchObject({
      id: turn.id,
      completedYamlRelativePaths: ['Build/Build.yaml'],
    });
  });

  test('keeps relative-path case distinct for POSIX workspaces', () => {
    const turn = stagedTurn('posix-turn', '/repo');
    setClientWorkspace('/repo');
    useChatStore.setState({ finishedTurnQueue: [turn], lastFinishedTurn: turn } as never);

    useChatStore.getState().markFinishedTurnYamlTargetCompleted(turn.id, 'Build/Build.yaml');
    useChatStore.getState().markFinishedTurnYamlTargetCompleted(turn.id, 'build/build.yaml');

    expect(useChatStore.getState().finishedTurnQueue[0]?.completedYamlRelativePaths).toEqual([
      'Build/Build.yaml',
      'build/build.yaml',
    ]);
  });

  test('round-trips only valid stage-backed turns for the matching workspace', () => {
    const baseTurn = stagedTurn();
    const turn: ChatFinishedTurn = {
      ...baseTurn,
      independentRecoveryRequestId: 'recovery-finished-stage-1',
      reconcileFailure: {
        message: 'Missing route provenance.',
        attempt: 1,
        failedAt: 2_000,
        kind: 'route-unresolved',
        retryable: false,
      },
      yamlSnapshotBeforeSend: {
        ...baseTurn.yamlSnapshotBeforeSend!,
        independentRecoveryRequestId: 'recovery-finished-stage-1',
        staging: {
          ...baseTurn.yamlSnapshotBeforeSend!.staging,
          pipelineBinding: {
            version: 1,
            id: 'binding-1',
            sessionId: 'session-1',
            bindingRequestId: 'binding-request-1',
            intent: 'edit',
            originRelativePath: 'build/build.yaml',
            targetRelativePath: 'pipeline-branch/pipeline-branch.yaml',
            createdAt: 1,
          },
        },
      },
    };
    savePersistedChatYamlReconciliationQueue('C:/repo', [
      turn,
      { ...stagedTurn('wrong-workspace', 'C:/other') },
      { ...turn, id: 'snapshotless', yamlSnapshotBeforeSend: null },
    ]);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({
        id: turn.id,
        independentRecoveryRequestId: 'recovery-finished-stage-1',
        reconcileFailure: expect.objectContaining({
          kind: 'route-unresolved',
          retryable: false,
        }),
        yamlSnapshotBeforeSend: expect.objectContaining({
          independentRecoveryRequestId: 'recovery-finished-stage-1',
          staging: expect.objectContaining({
            pipelineBinding: expect.objectContaining({ id: 'binding-1' }),
          }),
        }),
      }),
    ]);

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toContain('"version":1');
    expect(raw).not.toContain('wrong-workspace');
    expect(raw).not.toContain('snapshotless');
  });

  test('rejects malformed and unsupported persisted queues during hydration', () => {
    const turn = stagedTurn();
    const malformed = {
      ...turn,
      id: 'malformed',
      yamlSnapshotBeforeSend: {
        ...turn.yamlSnapshotBeforeSend!,
        yamlEditLockId: '',
      },
    };
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': {
            unfinishedYamlReconciliations: { version: 1, turns: [turn, malformed] },
          },
        },
      }),
    );
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({ id: turn.id }),
    ]);

    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': {
            unfinishedYamlReconciliations: { version: 2, turns: [turn] },
          },
        },
      }),
    );
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('persists a newly finished staged turn before reconciliation starts', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: turn.sessionId,
      sending: true,
      pendingUserText: 'Update the pipeline.',
      turnStartedAt: 900,
      yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
      finishedTurnQueue: [],
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: turn.sessionId,
          error: { name: 'ProviderError', data: { message: 'The model stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    const persisted = loadPersistedChatYamlReconciliationQueue('C:/repo');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.yamlSnapshotBeforeSend?.staging.id).toBe('stage-1');
    expect(persisted[0]?.yamlSnapshotBeforeSend?.yamlEditLockId).toBe('yaml-lock-stage-1');
  });

  test('persists a staged turn that finishes in a hidden conversation', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: 'visible-session',
      sessionStates: {
        [turn.sessionId!]: hiddenRuntime(turn),
      },
      finishedTurnQueue: [],
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: turn.sessionId,
          error: { name: 'ProviderError', data: { message: 'The model stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    const persisted = loadPersistedChatYamlReconciliationQueue('C:/repo');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionId: turn.sessionId,
      hidden: true,
      yamlSnapshotBeforeSend: { yamlEditLockId: 'yaml-lock-stage-1' },
    });
  });

  test('session deletion removes its staged turn from persisted reconciliation', () => {
    const turn = stagedTurn();
    const result = pipelineResult({
      resultId: 'result-deleted',
      turnId: turn.id,
      messageId: 'assistant-deleted',
    });
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [turn]);
    savePersistedChatYamlResults('C:/repo', { 'assistant-deleted': [result] });
    useChatStore.setState({
      sessions: [{ id: turn.sessionId, title: 'Deleted chat' }] as never,
      sessionParentById: {},
      sessionYamlResults: { [turn.sessionId!]: result },
      turnYamlResults: { 'assistant-deleted': [result] },
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: turn.sessionId } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
    expect(useChatStore.getState().turnYamlResults).toEqual({});
    expect(loadPersistedChatYamlResults('C:/repo')).toEqual({});
  });

  test('session deletion invalidates an abandoned reconciliation claim', () => {
    const failed = failedStagedTurn('claimed-deleted', 'C:/repo');
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [failed]);
    useChatStore.setState({
      sessions: [{ id: failed.sessionId, title: 'Deleted chat' }],
      sessionParentById: {},
      finishedTurnQueue: [failed],
      lastFinishedTurn: failed,
    } as Partial<ChatState>);

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(failed.id)).toBe(failed);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({ id: failed.id }),
    ]);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: failed.sessionId } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(failed, 'Cleanup was not confirmed.'),
    ).toBe(false);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('keeps a claimed discard recoverable until server cleanup is acknowledged', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [turn]);
    useChatStore.setState({
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);
    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(turn.id, 'Finalize failed before commit.');

    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.reconcileFailure).toMatchObject({
      message: 'Finalize failed before commit.',
      attempt: 1,
    });

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(turn.id)).toBe(failed);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.id).toBe(turn.id);

    useChatStore
      .getState()
      .restoreAbandonedFinishedTurnReconciliation(failed, 'The server did not confirm cleanup.');
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.reconcileFailure?.message).toBe(
      'The server did not confirm cleanup.',
    );

    useChatStore.getState().acknowledgeFinishedTurn(turn.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('clears only the confirmed claimed discard from persistence', () => {
    const claimed = failedStagedTurn('claimed', 'C:/repo');
    const queued = stagedTurn('still-queued');
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [claimed, queued]);
    useChatStore.setState({
      finishedTurnQueue: [claimed, queued],
      lastFinishedTurn: queued,
    } as Partial<ChatState>);

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimed.id)).toEqual(claimed);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo').map((turn) => turn.id)).toEqual([
      claimed.id,
      queued.id,
    ]);

    useChatStore.getState().acknowledgeFinishedTurn(claimed.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo').map((turn) => turn.id)).toEqual([
      queued.id,
    ]);
    expect(useChatStore.getState().finishedTurnQueue.map((turn) => turn.id)).toEqual([queued.id]);
  });

  test('acknowledges a claimed workspace A turn without rewriting workspace B state', () => {
    const claimedA = failedStagedTurn('claimed-a', 'C:/repo-a');
    const siblingA = stagedTurn('sibling-a', 'C:/repo-a');
    const liveB = stagedTurn('live-b', 'C:/repo-b');
    savePersistedChatYamlReconciliationQueue('C:/repo-a', [claimedA, siblingA]);
    savePersistedChatYamlReconciliationQueue('C:/repo-b', [liveB]);
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      finishedTurnQueue: [claimedA, siblingA],
      lastFinishedTurn: siblingA,
    } as Partial<ChatState>);
    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimedA.id)).toEqual(
      claimedA,
    );

    setClientWorkspace('C:/repo-b');
    useChatStore.setState({
      finishedTurnQueue: [liveB],
      lastFinishedTurn: liveB,
    } as Partial<ChatState>);
    useChatStore.getState().acknowledgeFinishedTurn(claimedA.id);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-a').map((turn) => turn.id)).toEqual([
      siblingA.id,
    ]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-b')).toEqual([
      expect.objectContaining({ id: liveB.id }),
    ]);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([liveB]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(liveB);
  });

  test('restores a claimed workspace A turn without injecting it into workspace B state', () => {
    const claimedA = failedStagedTurn('claimed-a', 'C:/repo-a');
    const siblingA = stagedTurn('sibling-a', 'C:/repo-a');
    const liveB = stagedTurn('live-b', 'C:/repo-b');
    savePersistedChatYamlReconciliationQueue('C:/repo-a', [claimedA, siblingA]);
    savePersistedChatYamlReconciliationQueue('C:/repo-b', [liveB]);
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      finishedTurnQueue: [claimedA, siblingA],
      lastFinishedTurn: siblingA,
    } as Partial<ChatState>);
    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimedA.id)).toEqual(
      claimedA,
    );

    setClientWorkspace('C:/repo-b');
    useChatStore.setState({
      finishedTurnQueue: [liveB],
      lastFinishedTurn: liveB,
    } as Partial<ChatState>);
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(claimedA, 'Cleanup was not confirmed.'),
    ).toBe(true);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-a')).toEqual([
      expect.objectContaining({
        id: claimedA.id,
        reconcileFailure: expect.objectContaining({ message: 'Cleanup was not confirmed.' }),
      }),
      expect.objectContaining({ id: siblingA.id }),
    ]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-b')).toEqual([
      expect.objectContaining({ id: liveB.id }),
    ]);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([liveB]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(liveB);
  });

  test('hydrates the failed queue on workspace bootstrap even when OpenCode bootstrap fails', async () => {
    const failedTurn = {
      ...stagedTurn(),
      reconcileFailure: {
        message: 'The merge could not be completed.',
        attempt: 2,
        failedAt: 2_000,
      },
    };
    const result = pipelineResult({
      resultId: 'result-reloaded',
      turnId: failedTurn.id,
      messageId: 'assistant-reloaded',
    });
    savePersistedChatYamlReconciliationQueue('C:/repo', [failedTurn]);
    savePersistedChatYamlResults('C:/repo', { 'assistant-reloaded': [result] });
    setClientWorkspace('C:/repo');
    globalThis.fetch = (() =>
      Promise.reject(
        new Error('OpenCode is unavailable during reload'),
      )) as unknown as typeof fetch;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    expect(useChatStore.getState().finishedTurnQueue).toEqual([failedTurn]);
    expect(useChatStore.getState().lastFinishedTurn).toEqual(failedTurn);
    expect(useChatStore.getState().turnYamlResults).toEqual({
      'assistant-reloaded': [result],
    });
    expect(useChatStore.getState().sessionYamlResults['session-1']).toEqual(result);
  });

  test('surfaces an unanchored legacy result diagnostic during workspace bootstrap', async () => {
    const workspace = 'C:/legacy-repo';
    const legacy = pipelineResult({
      resultId: 'legacy-result',
      turnId: 'legacy-turn',
      messageId: 'assistant-legacy',
      workspace,
    }) as Record<string, unknown>;
    delete legacy.messageId;
    delete legacy.turnId;
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          [workspace]: { pipelineResults: { version: 1, results: [legacy] } },
        },
      }),
    );
    setClientWorkspace(workspace);
    globalThis.fetch = (() =>
      Promise.reject(
        new Error('OpenCode is unavailable during reload'),
      )) as unknown as typeof fetch;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    expect(useChatStore.getState().completionWarning).toContain('cannot be restored safely');
  });
});
