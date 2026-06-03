import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Provider } from '../src/api/opencode-chat';
import type { RawPipelineConfig, RawTaskConfig, RawTrackConfig } from '../src/api/client';
import { PipelineConfigPanel } from '../src/components/panels/PipelineConfigPanel';
import { TaskConfigPanel } from '../src/components/panels/TaskConfigPanel';
import { TrackConfigPanel } from '../src/components/panels/TrackConfigPanel';
import {
  buildModelPickerGroups,
  ModelPickerDropdown,
  modelPickerLabel,
} from '../src/components/chat/ModelPickerDropdown';
import { useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';

const MODEL_VALUE = 'anthropic/claude-sonnet-4-5';

const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        status: 'active',
        capabilities: { reasoning: true },
        limit: { context: 200_000 },
      },
    },
  },
] as unknown as Provider[];

function promptTask(patch: Partial<RawTaskConfig> = {}): RawTaskConfig {
  return {
    id: 'task',
    name: 'Task',
    prompt: 'Do the thing',
    ...patch,
  };
}

function track(patch: Partial<RawTrackConfig> = {}): RawTrackConfig {
  return {
    id: 'main',
    name: 'Main',
    tasks: [promptTask()],
    ...patch,
  };
}

function pipeline(patch: Partial<RawPipelineConfig> = {}): RawPipelineConfig {
  const tracks = patch.tracks ?? [track()];
  return {
    name: 'Pipe',
    tracks,
    ...patch,
  };
}

function seedStores(config: RawPipelineConfig): void {
  useChatStore.setState({ providers });
  usePipelineStore.setState({
    config,
    savedConfig: config,
    registry: { drivers: ['codex'], triggers: [], completions: [], middlewares: [] },
  });
}

afterEach(() => {
  useChatStore.setState({ providers: [] });
  usePipelineStore.setState({
    config: { name: 'Loading...', tracks: [] },
    savedConfig: null,
    registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
  });
});

describe('Inspector model picker', () => {
  test('pipeline model field offers opencode provider/model options for the default driver', () => {
    const config = pipeline();
    seedStores(config);

    const groups = buildModelPickerGroups(providers, '');
    expect(groups[0]?.provider.id).toBe('anthropic');
    expect(groups[0]?.models[0]?.value).toBe(MODEL_VALUE);
    expect(groups[0]?.models[0]?.label).toBe('Claude Sonnet 4.5');

    const html = renderToStaticMarkup(
      <PipelineConfigPanel
        config={config}
        drivers={['codex']}
        errors={[]}
        onUpdate={() => {}}
        isPinned={false}
        onTogglePin={() => {}}
      />,
    );

    expect(html).not.toContain('<datalist');
    expect(html).toContain('aria-label="Open model picker"');
  });

  test('model picker tolerates provider entries before models are available', () => {
    const reconcilingProvider = {
      id: 'custom-provider',
      name: 'Custom Provider',
    } as unknown as Provider;

    expect(buildModelPickerGroups([reconcilingProvider], '')).toEqual([]);
    expect(
      modelPickerLabel(
        [reconcilingProvider],
        { providerID: 'custom-provider', modelID: 'missing-model' },
        'Pick model',
      ),
    ).toBe('Custom Provider / missing-model');
    expect(() =>
      renderToStaticMarkup(
        <ModelPickerDropdown providers={[reconcilingProvider]} value={null} onSelect={() => {}} />,
      ),
    ).not.toThrow();
  });

  test('model picker tolerates custom models without SDK metadata', () => {
    const providersWithMinimalModel = [
      {
        id: 'local',
        name: 'Local Models',
        models: {
          'llama3.1': {
            id: 'llama3.1',
            name: 'Llama 3.1',
          },
        },
      },
    ] as unknown as Provider[];

    const groups = buildModelPickerGroups(providersWithMinimalModel, '');
    expect(groups[0]?.models[0]).toMatchObject({
      id: 'llama3.1',
      label: 'Llama 3.1',
      status: 'active',
      context: 0,
      reasoning: false,
    });
    expect(() =>
      renderToStaticMarkup(
        <ModelPickerDropdown
          providers={providersWithMinimalModel}
          value={{ providerID: 'local', modelID: 'llama3.1' }}
          onSelect={() => {}}
        />,
      ),
    ).not.toThrow();
  });

  test('opencode model field renders a chat-style dropdown trigger', () => {
    const config = pipeline();
    seedStores(config);

    const html = renderToStaticMarkup(
      <PipelineConfigPanel
        config={config}
        drivers={['codex']}
        errors={[]}
        onUpdate={() => {}}
        isPinned={false}
        onTogglePin={() => {}}
      />,
    );

    expect(html).toContain('Pick model');
    expect(html).toContain('lucide-chevron-down');
  });

  test('track model field stays manual-only when the resolved driver is not opencode', () => {
    const main = track({ driver: 'codex' });
    const config = pipeline({ tracks: [main] });
    seedStores(config);

    const html = renderToStaticMarkup(
      <TrackConfigPanel
        track={main}
        drivers={['codex', 'opencode']}
        errors={[]}
        onUpdateTrack={() => {}}
        onDeleteTrack={() => {}}
        isPinned={false}
        onTogglePin={() => {}}
      />,
    );

    expect(html).not.toContain('<datalist');
    expect(html).not.toContain(MODEL_VALUE);
  });

  test('task model field offers opencode options when the task overrides another inherited driver', () => {
    const task = promptTask({ driver: 'opencode' });
    const main = track({ driver: 'codex', tasks: [task] });
    const config = pipeline({ tracks: [main] });
    seedStores(config);

    const html = renderToStaticMarkup(
      <TaskConfigPanel
        task={task}
        trackId="main"
        qualifiedId="main.task"
        pipelineConfig={config}
        dependencies={[]}
        drivers={['codex', 'opencode']}
        errors={[]}
        onUpdateTask={() => {}}
        onDeleteTask={() => {}}
        onRemoveDependency={() => {}}
        isPinned={false}
        onTogglePin={() => {}}
      />,
    );

    expect(html).not.toContain('<datalist');
    expect(html).toContain('aria-label="Open model picker"');
  });
});
