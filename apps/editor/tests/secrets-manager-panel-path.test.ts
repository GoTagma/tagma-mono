import { describe, expect, test } from 'bun:test';
import { relative, resolve } from 'node:path';
import { toWorkspaceRelative } from '../src/components/panels/SecretsManagerPanel';

// Mirrors server/secrets.ts `workspaceRelativePath` — the canonical form the
// secrets backend stores and returns for pipeline bindings.
function serverWorkspaceRelative(workDir: string, absPath: string): string {
  return relative(resolve(workDir), resolve(absPath)).replace(/\\/g, '/');
}

describe('SecretsManagerPanel toWorkspaceRelative', () => {
  test('produces the server canonical relative path (posix)', () => {
    const workDir = '/home/u/ws';
    const abs = '/home/u/ws/.tagma/build/build.yaml';
    expect(toWorkspaceRelative(workDir, abs)).toBe('.tagma/build/build.yaml');
    expect(toWorkspaceRelative(workDir, abs)).toBe(serverWorkspaceRelative(workDir, abs));
  });

  test('normalizes Windows backslashes and tolerates drive-letter case', () => {
    // This is the exact failure surface: WorkspaceYamlEntry.path is absolute
    // with backslashes on win32; the binding key must still match the
    // server's forward-slash relative form.
    const workDir = 'D:\\tagma\\ws';
    const abs = 'd:\\tagma\\ws\\.tagma\\deploy\\deploy.yaml';
    expect(toWorkspaceRelative(workDir, abs)).toBe('.tagma/deploy/deploy.yaml');
  });

  test('tolerates a trailing separator on the workspace dir', () => {
    expect(toWorkspaceRelative('/ws/', '/ws/.tagma/a/a.yaml')).toBe('.tagma/a/a.yaml');
  });

  test('returns null for paths outside the workspace or missing inputs', () => {
    expect(toWorkspaceRelative('/ws', '/other/.tagma/a/a.yaml')).toBeNull();
    expect(toWorkspaceRelative('', '/ws/.tagma/a/a.yaml')).toBeNull();
    expect(toWorkspaceRelative('/ws', null)).toBeNull();
  });
});
