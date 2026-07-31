import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('diagnostics normal-path isolation', () => {
  test('does not wrap sidecar stdout or stderr during normal server startup', () => {
    const indexSource = readFileSync(join(root, 'server/index.ts'), 'utf8');
    const diagnosticsSource = readFileSync(join(root, 'server/diagnostics.ts'), 'utf8');

    expect(indexSource).not.toContain('installProcessDiagnosticsCapture');
    expect(diagnosticsSource).not.toContain('processCaptureInstalled');
    expect(diagnosticsSource).not.toContain('stream.write =');
  });

  test('installs renderer console capture only for an active diagnostics session', () => {
    const source = readFileSync(
      join(root, 'src/diagnostics/renderer-diagnostics-bridge.ts'),
      'utf8',
    );
    const startFunction = source.match(
      /export function startRendererDiagnosticsBridge\(\): void \{[\s\S]*?\n\}/,
    )?.[0];

    expect(startFunction).toBeDefined();
    expect(startFunction).not.toContain('installRendererLogCapture');
    expect(source).toContain('stopCapture ??= installRendererLogCapture();');
    expect(source).toContain('stopCapture?.();');
    expect(source).toContain('setActiveSession(null);');
    expect(source).not.toContain('.bind(console)');
  });

  test('OpenCode diagnostics reads an existing handle and never starts or restarts it', () => {
    const source = readFileSync(join(root, 'server/diagnostics-opencode.ts'), 'utf8');

    expect(source).toContain('getHandle: getOpencodeHandle');
    expect(source).not.toContain('ensureOpencode');
    expect(source).not.toContain('restartOpencode');
  });
});
