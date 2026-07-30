import { describe, expect, test } from 'bun:test';

import { createAndEnterExplorerFolder } from '../src/components/FileExplorer';

describe('FileExplorer folder creation', () => {
  test('enters the server-reported directory after creating it', async () => {
    const calls: string[] = [];
    const createdPath = 'D:\\Projects\\New Workspace';

    const result = await createAndEnterExplorerFolder({
      currentPath: 'D:\\Projects',
      folderName: '  New Workspace  ',
      createFolder: async (requestedPath) => {
        calls.push(`create:${requestedPath}`);
        return { path: createdPath };
      },
      enterFolder: async (path) => {
        calls.push(`enter:${path}`);
      },
    });

    expect(result).toBe(createdPath);
    expect(calls).toEqual([
      'create:D:\\Projects\\New Workspace',
      'enter:D:\\Projects\\New Workspace',
    ]);
  });

  test('does not duplicate a root separator when creating a directory', async () => {
    let requestedPath = '';

    await createAndEnterExplorerFolder({
      currentPath: '/',
      folderName: 'workspace',
      createFolder: async (path) => {
        requestedPath = path;
        return { path };
      },
      enterFolder: async () => {},
    });

    expect(requestedPath).toBe('/workspace');
  });
});
