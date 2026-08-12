import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PipelinePicker } from '../src/components/PipelinePicker';
import { openPipelineFromPicker } from '../src/components/pipeline-picker-transition';

test('shows the opening pipeline and blocks conflicting picker actions', () => {
  const noop = () => undefined;
  const openingPath = '/workspace/.tagma/build/build.yaml';
  const html = renderToStaticMarkup(
    <PipelinePicker
      workDir="/workspace"
      workspaceYamls={
        [
          {
            name: 'build.yaml',
            path: openingPath,
            pipelineName: 'Build',
            mtimeMs: 2,
          },
          {
            name: 'deploy.yaml',
            path: '/workspace/.tagma/deploy/deploy.yaml',
            pipelineName: 'Deploy',
            mtimeMs: 1,
          },
        ] as never
      }
      yamlEditLocked={false}
      openingPath={openingPath}
      onPickPipeline={noop}
      onCreateNew={noop}
      onSwitchWorkspace={noop}
      onDeletePipeline={noop}
    />,
  );

  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('Opening');
  expect(html).toContain('Opening pipeline Build');
  expect(html).toContain('animate-spin');
  expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
  for (const label of [
    'Switch workspace',
    'Opening pipeline Build',
    'Open pipeline Deploy',
    'Remove build.yaml',
    'Remove deploy.yaml',
    'Create new pipeline',
  ]) {
    const labelIndex = html.indexOf(`aria-label="${label}"`);
    const buttonStart = html.lastIndexOf('<button', labelIndex);
    const openingTag = html.slice(buttonStart, html.indexOf('>', labelIndex) + 1);
    expect(labelIndex).toBeGreaterThan(-1);
    expect(openingTag).toContain('disabled=""');
  }
});

test('suppresses duplicate opens and keeps the picker visible after failure', async () => {
  const path = 'D:/Workspace/.tagma/Build/build.yaml';
  const canonicalPath = 'd:\\workspace\\.tagma\\build\\build.yaml';
  let resolveOpen!: () => void;
  const openPending = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  const pendingPathRef = { current: null as string | null };
  const pendingUpdates: Array<string | null> = [];
  let openCalls = 0;
  let closeCalls = 0;
  let state = { errorMessage: 'old error' as string | null, yamlPath: null as string | null };
  const args = {
    path,
    pendingPathRef,
    setPendingPath: (next: string | null) => pendingUpdates.push(next),
    clearError: () => {
      state = { ...state, errorMessage: null };
    },
    clearWorkflowReturnPath: () => undefined,
    openFile: async () => {
      openCalls += 1;
      await openPending;
      state = { errorMessage: null, yamlPath: canonicalPath };
    },
    readPipelineState: () => state,
    closePicker: () => {
      closeCalls += 1;
    },
  };

  const firstOpen = openPipelineFromPicker(args);
  const duplicateOpen = openPipelineFromPicker(args);

  expect(pendingPathRef.current).toBe(path);
  expect(pendingUpdates).toEqual([path]);
  expect(openCalls).toBe(1);
  expect(await duplicateOpen).toBe(false);

  resolveOpen();
  expect(await firstOpen).toBe(true);
  expect(closeCalls).toBe(1);
  expect(pendingPathRef.current).toBeNull();
  expect(pendingUpdates).toEqual([path, null]);

  state = { errorMessage: 'old error', yamlPath: null };
  expect(
    await openPipelineFromPicker({
      ...args,
      pendingPathRef: { current: null },
      setPendingPath: () => undefined,
      openFile: async () => {
        state = { errorMessage: 'Failed to open file', yamlPath: null };
      },
    }),
  ).toBe(false);
  expect(closeCalls).toBe(1);
});
