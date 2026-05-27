import { afterEach, describe, expect, test } from 'bun:test';
import { buildEditorContext } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { useRunStore } from '../src/store/run-store';
import { useYamlEditLockStore } from '../src/store/yaml-edit-lock-store';

describe('chat editor context', () => {
  afterEach(() => {
    usePipelineStore.setState({
      workDir: null,
      yamlPath: null,
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
