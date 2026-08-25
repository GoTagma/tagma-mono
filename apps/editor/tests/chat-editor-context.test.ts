import { afterEach, describe, expect, test } from 'bun:test';
import { buildEditorContext } from '../src/store/chat-store';
import { useEditorSettingsStore } from '../src/store/editor-settings-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { useRunStore } from '../src/store/run-store';
import { useYamlEditLockStore } from '../src/store/yaml-edit-lock-store';

describe('chat editor context', () => {
  afterEach(() => {
    usePipelineStore.setState({
      config: { name: 'Loading...', tracks: [] },
      workDir: null,
      yamlPath: null,
      manualNewPipelineYamlPath: null,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useRunStore.setState({ status: 'idle', yamlPath: null } as never);
    useYamlEditLockStore.setState({
      active: false,
      yamlPath: null,
    } as never);
    useEditorSettingsStore.getState().updateLocal(null);
  });

  test('marks current pipeline protected while its run is still active', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      yamlRunVersion: 7,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useRunStore.setState({
      status: 'running',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
    } as never);

    expect(buildEditorContext()).toContain(
      '<pipeline-availability protected="true" reason="running">',
    );
    expect(buildEditorContext()).toContain('<yaml-run-version>7</yaml-run-version>');
  });

  test('does not mark current pipeline protected for the chat edit lock', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      yamlRunVersion: 7,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useYamlEditLockStore.setState({
      active: true,
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      expiresAt: Date.now() + 60_000,
    } as never);

    expect(buildEditorContext()).toContain('<current-file>.tagma/build/build.yaml</current-file>');
    expect(buildEditorContext()).not.toContain('protected="true"');
  });

  test('marks Python agent unavailable when it is not configured', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext();

    expect(context).toContain('<python-agent enabled="false" reason="not-configured">');
    expect(context).toContain('Enable Python AI Agent in Editor Settings');
  });

  test('renders a structured create action and makes an empty pipeline inventory explicit', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: null,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      requestedAction: 'create-new-pipeline',
      workspaceYamlFilePaths: [],
    });

    expect(context).toContain('<requested-action kind="create-new-pipeline">');
    expect(context).toContain('<workspace-yaml-folders empty="true" />');
  });

  test('exposes the selected OpenCode Chat model only with a structured new-pipeline action', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/deploy/deploy.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    const chatModel = { providerID: 'deepseek', modelID: 'deepseek-v4-flash' };

    const createContext = buildEditorContext({
      requestedAction: 'create-new-pipeline',
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
      chatModel,
    });
    const editContext = buildEditorContext({
      requestedAction: null,
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
      chatModel,
    });

    expect(createContext).toContain('<requested-action kind="create-new-pipeline">');
    expect(createContext).toContain(
      '<opencode-chat-model provider-id="deepseek" model-id="deepseek-v4-flash" />',
    );
    expect(editContext).not.toContain('<requested-action kind="create-new-pipeline">');
    expect(editContext).not.toContain('<opencode-chat-model');
  });

  test('includes configured Python agent interpreter and venv', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useEditorSettingsStore.getState().updateLocal({
      autoInstallDeclaredPlugins: false,
      chatDirtyConflictPolicy: 'ask',
      autoSaveEnabled: true,
      autoSaveIntervalSec: 30,
      viewMode: 'production',
      pythonAgent: {
        enabled: true,
        interpreterCommand: 'py',
        interpreterArgs: ['-3.13'],
        interpreterVersion: '3.13.7',
        venvPath: '.tagma/.python-agent/venv',
        configuredAt: '2026-06-18T00:00:00.000Z',
      },
      opencodeChatModel: null,
      opencodeChatReasoningEffort: 'medium',
      chatContextLimitEnabled: false,
      chatContextRounds: 0,
    } as never);

    const context = buildEditorContext();

    expect(context).toContain('<python-agent enabled="true">');
    expect(context).toContain('<interpreter>py -3.13</interpreter>');
    expect(context).toContain('<version>3.13.7</version>');
    expect(context).toContain('<venv>.tagma/.python-agent/venv</venv>');
    expect(context).not.toContain('enabled="false"');
  });

  test('includes workspace yaml folder entries with concrete yaml paths beyond the open file', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      workspaceYamlFilePaths: [
        'C:/repo/.tagma/build/build.yaml',
        'C:/repo/.tagma/deploy/deploy.yaml',
        'C:/repo/.tagma/pipeline-9giapbf6.yaml',
        'C:/outside/ignored.yaml',
      ],
    });

    expect(context).toContain('<workspace>C:/repo</workspace>');
    expect(context).toContain('<current-file>.tagma/build/build.yaml</current-file>');
    expect(context).toContain('<workspace-yaml-folders>');
    expect(context).toContain('<folder>.tagma/build</folder>');
    expect(context).toContain('<yaml>.tagma/build/build.yaml</yaml>');
    expect(context).toContain('<manifest>.tagma/build/build.manifest.json</manifest>');
    expect(context).toContain('<folder>.tagma/deploy</folder>');
    expect(context).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
    expect(context).toContain('<manifest>.tagma/deploy/deploy.manifest.json</manifest>');
    expect(context).toContain('<pipeline legacy="flat">');
    expect(context).toContain('<folder>.tagma</folder>');
    expect(context).toContain('<yaml>.tagma/pipeline-9giapbf6.yaml</yaml>');
    expect(context).toContain('<manifest>.tagma/pipeline-9giapbf6.manifest.json</manifest>');
    expect(context).not.toContain('ignored.yaml');
  });

  test('uses absolute staged targets so a delegated child cwd cannot redirect them to live YAML', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    const agentRoot =
      'C:/repo/.tagma/.chat-staging/00000000-0000-4000-8000-000000000001/agent-workspace/.tagma';
    const stagedYaml = `${agentRoot}/build/build.yaml`;

    const context = buildEditorContext({
      currentYamlPath: stagedYaml,
      workspaceYamlFilePaths: [stagedYaml],
      chatYamlStage: {
        id: '00000000-0000-4000-8000-000000000001',
        agentTagmaDir: agentRoot,
      },
    });

    expect(context).toContain('<chat-staging id="00000000-0000-4000-8000-000000000001">');
    expect(context).toContain(
      '<agent-root>C:/repo/.tagma/.chat-staging/00000000-0000-4000-8000-000000000001/agent-workspace/.tagma</agent-root>',
    );
    expect(context).toContain(
      '<write-policy>Agent-root is the sole filesystem read/write boundary for this staged turn. Do not inspect or access live workspace paths outside agent-root.</write-policy>',
    );
    expect(context).toContain(`<current-file>${stagedYaml}</current-file>`);
    expect(context).toContain(`<folder>${agentRoot}/build</folder>`);
    expect(context).toContain(`<yaml>${stagedYaml}</yaml>`);
    expect(context).toContain(`<manifest>${agentRoot}/build/build.manifest.json</manifest>`);
    expect(context).not.toContain('<current-file>build/build.yaml</current-file>');
    expect(context).not.toContain('<current-file>.tagma/build/build.yaml</current-file>');
  });

  test('escapes workspace and staged target paths before embedding them in editor context', () => {
    const workDir = 'C:/repo&<team>';
    const agentRoot = `${workDir}/.tagma/.chat-staging/stage&<1>/agent-workspace/.tagma`;
    const stagedYaml = `${agentRoot}/build&<one>/build&<one>.yaml`;
    usePipelineStore.setState({
      workDir,
      yamlPath: `${workDir}/.tagma/build/build.yaml`,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      currentYamlPath: stagedYaml,
      workspaceYamlFilePaths: [stagedYaml],
      chatYamlStage: {
        id: 'stage&<1>',
        agentTagmaDir: agentRoot,
      },
    });

    expect(context).toContain('<workspace>C:/repo&amp;&lt;team&gt;</workspace>');
    expect(context).toContain('stage&amp;&lt;1&gt;');
    expect(context).toContain(
      '<agent-root>C:/repo&amp;&lt;team&gt;/.tagma/.chat-staging/stage&amp;&lt;1&gt;/agent-workspace/.tagma</agent-root>',
    );
    expect(context).toContain(
      '<current-file>C:/repo&amp;&lt;team&gt;/.tagma/.chat-staging/stage&amp;&lt;1&gt;/agent-workspace/.tagma/build&amp;&lt;one&gt;/build&amp;&lt;one&gt;.yaml</current-file>',
    );
    expect(context).not.toContain(workDir);
    expect(context).not.toContain(stagedYaml);
  });

  test('renders a Host-owned session branch without making its publish target writable', () => {
    const agentRoot = 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma';
    const stagedSource = `${agentRoot}/orders/orders.yaml`;
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/orders/orders.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      currentYamlPath: stagedSource,
      workspaceYamlFilePaths: [stagedSource],
      chatYamlStage: {
        id: 'stage-1',
        agentTagmaDir: agentRoot,
        pipelineBinding: {
          id: 'binding-1',
          intent: 'edit',
          originRelativePath: 'orders/orders.yaml',
          targetRelativePath: 'pipeline-branch/pipeline-branch.yaml',
        },
      },
    });

    expect(context).toContain('<pipeline-binding id="binding-1" intent="edit">');
    expect(context).toContain('<origin>orders/orders.yaml</origin>');
    expect(context).toContain(
      '<host-publication-coordinate writable="false">pipeline-branch/pipeline-branch.yaml</host-publication-coordinate>',
    );
    expect(context).toContain('Edit only current-file for edit intent');
    expect(context).toContain(`<current-file>${stagedSource}</current-file>`);
  });

  test('includes the previous host YAML reconcile result and escapes its values', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      previousChatYamlReconcile: {
        outcome: 'forked',
        conflicts: ['source-changed-on-disk', 'future<&conflict'] as never,
        localBranchPersisted: true,
        resultPath: 'C:/repo/.tagma/build-<copy&1>/build-<copy&1>.yaml',
        compileSuccess: false,
        trialRunSuccess: false,
        trialVerification: 'prerequisite-unavailable',
      },
    });

    expect(context).toContain('<previous-chat-yaml-reconcile>');
    expect(context).toContain('<outcome>forked</outcome>');
    expect(context).toContain('<conflict>source-changed-on-disk</conflict>');
    expect(context).toContain('<conflict>future&lt;&amp;conflict</conflict>');
    expect(context).toContain('<local-branch-persisted>true</local-branch-persisted>');
    expect(context).toContain(
      '<result-path>C:/repo/.tagma/build-&lt;copy&amp;1&gt;/build-&lt;copy&amp;1&gt;.yaml</result-path>',
    );
    expect(context).toContain('<compile-success>false</compile-success>');
    expect(context).toContain('<trial-run-success>false</trial-run-success>');
    expect(context).toContain('<trial-verification>prerequisite-unavailable</trial-verification>');
    expect(context).toContain('</previous-chat-yaml-reconcile>');
  });

  test('omits previous reconcile context when no compatible result is available', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    expect(buildEditorContext({ previousChatYamlReconcile: null })).not.toContain(
      '<previous-chat-yaml-reconcile>',
    );
    expect(buildEditorContext()).not.toContain('<previous-chat-yaml-reconcile>');
  });

  test('renders create intent only from the frozen structured action', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/deploy/deploy.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      requestedAction: 'create-new-pipeline',
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
    });

    expect(context).toContain('<requested-action kind="create-new-pipeline">');
    expect(context).toContain(
      '<collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
    );
    expect(context).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
  });

  test('renders fill intent only from the frozen structured action', () => {
    const yamlPath = 'C:/repo/.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml';
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath,
      manualNewPipelineYamlPath: yamlPath,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      requestedAction: 'fill-manual-new-pipeline',
      workspaceYamlFilePaths: [yamlPath],
    });

    expect(context).toContain('<requested-action kind="fill-manual-new-pipeline">');
    expect(context).toContain('<target>current-file</target>');
    expect(context).not.toContain('<requested-action kind="create-new-pipeline">');
  });

  test('uses the send-time requested action instead of mutable pipeline selection or message wording', () => {
    const liveYamlPath = 'C:/repo/.tagma/pipeline-new/pipeline-new.yaml';
    const stagedYamlPath =
      'C:/repo/.tagma/.chat-staging/stage/agent-workspace/.tagma/pipeline-old/pipeline-old.yaml';
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: liveYamlPath,
      manualNewPipelineYamlPath: liveYamlPath,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const frozenNoAction = buildEditorContext({
      currentYamlPath: stagedYamlPath,
      requestedAction: null,
    });
    const frozenCreate = buildEditorContext({
      currentYamlPath: stagedYamlPath,
      requestedAction: 'create-new-pipeline',
      chatModel: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
    });

    expect(frozenNoAction).not.toContain('<requested-action');
    expect(frozenNoAction).not.toContain('<opencode-chat-model');
    expect(frozenCreate).toContain('<requested-action kind="create-new-pipeline">');
    expect(frozenCreate).toContain(
      '<opencode-chat-model provider-id="deepseek" model-id="deepseek-v4-flash" />',
    );
    expect(frozenCreate).not.toContain('<requested-action kind="fill-manual-new-pipeline">');
  });

  test('does not protect a switched pipeline while another path is running', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/other/other.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useRunStore.setState({
      status: 'running',
      yamlPath: 'C:/repo/.tagma/build/build.yaml',
    } as never);

    expect(buildEditorContext()).not.toContain('protected="true"');
  });
});
