import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { api } from '../src/api/client';
import { useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import {
  registerChatContextNavigation,
  openChatContextCandidate,
  openChatContextPath,
} from '../src/chat-actions/context';
const chat = useChatStore.getState();
const pipeline = usePipelineStore.getState();
const workspace = 'D:/context-actions';
const path = `${workspace}/.tagma/test/pipeline.yaml`;
let detach: () => void;
const opened: string[] = [];
let listing: ReturnType<typeof spyOn<typeof api, 'listWorkspaceYamls'>>;
beforeEach(() => {
  opened.length = 0;
  usePipelineStore.setState({ workDir: workspace, isDirty: false, layoutDirty: false });
  useChatStore.setState({
    ...chat,
    chatOperationV2Inventory: {
      schemaVersion: 2,
      revision: 1,
      digest: 'a'.repeat(64),
      candidates: [
        {
          candidateId: 'candidate',
          relativeCoordinate: 'test/pipeline.yaml',
          name: 'Test',
          currentCanvas: false,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    },
  });
  detach = registerChatContextNavigation(workspace, async (value) => {
    opened.push(value);
    usePipelineStore.setState({ yamlPath: value });
  });
  listing = spyOn(api, 'listWorkspaceYamls').mockResolvedValue({
    entries: [
      {
        path,
        name: 'Test',
        pipelineName: 'Test',
        contentHash: 'a'.repeat(64),
        layoutHash: null,
        layoutMtimeMs: null,
        layoutSize: null,
        mtimeMs: 1,
        size: 10,
      },
    ],
  });
});
afterEach(() => {
  detach();
  listing.mockRestore();
  useChatStore.setState(chat);
  usePipelineStore.setState(pipeline);
});

test('UI path and Host candidate resolution enter the same mounted editor navigation', async () => {
  expect(await openChatContextPath(path)).toBe(null);
  expect(await openChatContextCandidate('candidate', false)).toBe(null);
  expect(opened).toEqual([path, path]);
  expect(listing).toHaveBeenCalledWith(workspace);
});
test('both entry points preserve unsaved changes unless explicitly discarded', async () => {
  usePipelineStore.setState({ isDirty: true });
  expect(await openChatContextPath(path)).toBe('unsaved_changes');
  expect(await openChatContextCandidate('candidate', false)).toBe('unsaved_changes');
  expect(opened).toEqual([]);
  expect(await openChatContextCandidate('candidate', true)).toBe(null);
  expect(opened).toEqual([path]);
});
test('unknown candidates, renderer detach and changed workspace cannot navigate', async () => {
  expect(await openChatContextCandidate('unknown', true)).toBe('candidate_unavailable');
  detach();
  expect(await openChatContextPath(path, true)).toBe('editor_unavailable');
  detach = registerChatContextNavigation(workspace, async (value) => {
    opened.push(value);
  });
  usePipelineStore.setState({ workDir: 'D:/another' });
  expect(await openChatContextPath(path, true)).toBe('editor_unavailable');
  expect(opened).toEqual([]);
});
