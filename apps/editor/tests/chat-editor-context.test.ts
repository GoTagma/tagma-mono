import { afterEach, describe, expect, test } from 'bun:test';
import { buildEditorContext } from '../src/store/chat-store';
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
      rawLock: null,
    } as never);
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

  test('marks explicit create-pipeline requests so existing yaml names are collision context only', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/deploy/deploy.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      userText: '请创建一个新的 deploy pipeline，功能类似现有部署流程',
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
    });

    expect(context).toContain('<requested-action kind="create-new-pipeline">');
    expect(context).toContain(
      '<collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
    );
    expect(context).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
  });

  test('fills the editor-created manual-new draft instead of creating a sibling', () => {
    const yamlPath = 'C:/repo/.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml';
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath,
      manualNewPipelineYamlPath: yamlPath,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      userText: '请创建一个新的 deploy pipeline，负责发布',
      workspaceYamlFilePaths: ['C:/repo/.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml'],
    });

    expect(context).toContain('<requested-action kind="fill-manual-new-pipeline">');
    expect(context).toContain('<target>current-file</target>');
    expect(context).not.toContain('<requested-action kind="create-new-pipeline">');
    expect(context).toContain(
      '<current-file>.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml</current-file>',
    );
  });

  test('keeps create-new marker for separate requests against a manual-new draft', () => {
    const yamlPath = 'C:/repo/.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml';
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath,
      manualNewPipelineYamlPath: yamlPath,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      userText: '请另外创建一个新的 deploy pipeline',
      workspaceYamlFilePaths: ['C:/repo/.tagma/pipeline-abc123xy/pipeline-abc123xy.yaml'],
    });

    expect(context).toContain('<requested-action kind="create-new-pipeline">');
    expect(context).not.toContain('<requested-action kind="fill-manual-new-pipeline">');
  });

  test('does not mark ordinary task creation inside an existing pipeline as new-pipeline creation', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/deploy/deploy.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      userText: '在当前 pipeline 里新建一个测试 task',
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
    });

    expect(context).not.toContain('<requested-action kind="create-new-pipeline">');
  });

  test('does not mark ordinary task creation inside a named existing pipeline as new-pipeline creation', () => {
    usePipelineStore.setState({
      workDir: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/deploy/deploy.yaml',
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);

    const context = buildEditorContext({
      userText: 'create a new smoke test task in the deploy pipeline',
      workspaceYamlFilePaths: ['C:/repo/.tagma/deploy/deploy.yaml'],
    });

    expect(context).not.toContain('<requested-action kind="create-new-pipeline">');
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
