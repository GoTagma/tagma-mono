import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('production diagnostics UI wiring', () => {
  test('starts the renderer diagnostics bridge with the editor', () => {
    const source = readFileSync(join(root, 'src/main.tsx'), 'utf8');

    expect(source).toContain('import { startRendererDiagnosticsBridge }');
    expect(source).toContain('startRendererDiagnosticsBridge();');
  });

  test('settings exposes explicit enable, revoke, and coding-agent handoff actions', () => {
    const source = [
      readFileSync(
        join(root, 'src/components/settings/use-editor-settings-controller.tsx'),
        'utf8',
      ),
      readFileSync(join(root, 'src/components/panels/DiagnosticsSettingsSection.tsx'), 'utf8'),
    ].join('\n');

    expect(source).toContain('Coding agent diagnostics');
    expect(source).toContain('api.enableDiagnosticsSession()');
    expect(source).toContain('api.disableDiagnosticsSession()');
    expect(source).toContain('buildDiagnosticsAgentInstructions');
    expect(source).toContain('Copy agent instructions');
    expect(source).not.toContain('Copy agent connection');
    expect(source).toContain('Known credential formats are redacted');
    expect(source).toContain('may still contain sensitive text');
  });
});
