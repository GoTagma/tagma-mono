import { describe, expect, test } from 'bun:test';
import {
  buildPythonAgentRunEnv,
  buildPythonInstallPlan,
  detectPython,
  parsePythonVersionText,
  parseWindowsPyList,
  validatePythonInterpreter,
  type PythonCommandRunner,
} from '../server/python-agent';

function runner(
  responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
): PythonCommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(' ');
    return responses[key] ?? { exitCode: 1, stderr: `missing mock: ${key}` };
  };
}

describe('python agent detection helpers', () => {
  test('parses py --list output and marks the default version', () => {
    const versions = parseWindowsPyList(`
 -V:3.13 *        Python 3.13 (64-bit)
 -V:3.12          Python 3.12 (64-bit)
`);

    expect(versions).toEqual([
      {
        id: 'py-3.13',
        command: 'py',
        args: ['-3.13'],
        version: '3.13',
        source: 'py-list',
        default: true,
      },
      {
        id: 'py-3.12',
        command: 'py',
        args: ['-3.12'],
        version: '3.12',
        source: 'py-list',
        default: false,
      },
    ]);
  });

  test('parses normal Python --version output', () => {
    expect(parsePythonVersionText('Python 3.13.7')).toBe('3.13.7');
    expect(parsePythonVersionText('Python 3.12.4\r\n')).toBe('3.12.4');
  });

  test('falls back to python and python3 on Windows when py launcher is missing', async () => {
    const result = await detectPython({
      platform: 'win32',
      run: runner({
        'py --list': { exitCode: 1, stderr: 'not found' },
        'python --version': { exitCode: 0, stdout: 'Python 3.13.7' },
        'python3 --version': { exitCode: 1, stderr: 'not found' },
      }),
    });

    expect(result.detected).toEqual([
      {
        id: 'python-3.13.7',
        command: 'python',
        args: [],
        version: '3.13.7',
        source: 'python-version',
        default: true,
      },
    ]);
    expect(result.defaultId).toBe('python-3.13.7');
  });

  test('validates a manually supplied interpreter path', async () => {
    const result = await validatePythonInterpreter({
      command: 'C:\\Python313\\python.exe',
      run: runner({
        'C:\\Python313\\python.exe --version': { exitCode: 0, stdout: 'Python 3.13.7' },
      }),
    });

    expect(result.version).toBe('3.13.7');
    expect(result.source).toBe('manual-path');
  });

  test('builds platform-specific install plans without running package managers', () => {
    expect(buildPythonInstallPlan('win32', '3.13').command).toEqual([
      'winget',
      'install',
      '--id',
      'Python.Python.3.13',
      '-e',
    ]);
    expect(buildPythonInstallPlan('darwin', '3.13').command).toEqual([
      'brew',
      'install',
      'python@3.13',
    ]);
    expect(buildPythonInstallPlan('linux', '3.13', 'apt').command).toEqual([
      'sudo',
      'apt',
      'install',
      '-y',
      'python3.13',
      'python3.13-venv',
    ]);
  });

  test('builds run env that exposes the workspace venv and interpreter', () => {
    const env = buildPythonAgentRunEnv(
      'C:\\work\\demo',
      {
        enabled: true,
        interpreterCommand: 'py',
        venvPath: '.tagma/.python-agent/venv',
      },
      'win32',
    );

    expect(env.TAGMA_PYTHON_AGENT_ENABLED).toBe('1');
    expect(env.TAGMA_PYTHON_AGENT_PYTHON).toContain('.tagma\\.python-agent\\venv');
    expect(env.TAGMA_PYTHON_AGENT_VENV).toContain('.tagma\\.python-agent\\venv');
    expect(env.PATH ?? env.Path).toContain('.tagma\\.python-agent\\venv\\Scripts');
  });
});
