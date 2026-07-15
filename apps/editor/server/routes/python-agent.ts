import type express from 'express';
import { errorMessage } from '../path-utils.js';
import { requireWorkspace } from '../require-workspace.js';
import { readEditorSettings, writeEditorSettings } from '../plugins/loader.js';
import {
  buildPythonInstallPlan,
  detectPython,
  ensurePythonAgentVenv,
  validatePythonInterpreter,
  type PythonInstallPlan,
} from '../python-agent.js';
import { getActiveYamlEditLock, publicYamlEditLock } from '../yaml-edit-lock.js';

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function parseVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseLinuxManager(value: unknown): 'apt' | 'dnf' | 'pacman' | null {
  return value === 'apt' || value === 'dnf' || value === 'pacman' ? value : null;
}

async function runInstallPlan(plan: PythonInstallPlan): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const [command, ...args] = plan.command;
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function registerPythonAgentRoutes(app: express.Express): void {
  app.get('/api/python-agent/detect', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      res.json(await detectPython());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.get('/api/python-agent/install-plan', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      const version = parseVersion(req.query.version);
      const manager = parseLinuxManager(req.query.manager);
      res.json(buildPythonInstallPlan(process.platform, version, manager));
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/python-agent/validate', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const raw = req.body as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.command !== 'string') {
      return res.status(400).json({ error: 'Python command is required' });
    }
    try {
      res.json(
        await validatePythonInterpreter({
          command: raw.command,
          args: parseStringArray(raw.args),
        }),
      );
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/python-agent/configure', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Set a working directory first' });
    const raw = req.body as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.command !== 'string') {
      return res.status(400).json({ error: 'Python command is required' });
    }
    const activeYamlLock = getActiveYamlEditLock(ws);
    if (activeYamlLock) {
      return res.status(423).json({
        error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
        lock: publicYamlEditLock(activeYamlLock),
      });
    }
    try {
      const interpreter = await validatePythonInterpreter({
        command: raw.command,
        args: parseStringArray(raw.args),
      });
      const venv = await ensurePythonAgentVenv({
        workDir: ws.workDir,
        command: interpreter.command,
        args: interpreter.args,
      });
      const settings = writeEditorSettings(ws, {
        pythonAgent: {
          enabled: true,
          interpreterCommand: interpreter.command,
          interpreterArgs: interpreter.args,
          interpreterVersion: interpreter.version,
          venvPath: '.tagma/.python-agent/venv',
          configuredAt: new Date().toISOString(),
        },
      });
      res.json({ settings, interpreter, venv, revision: ws.stateRevision });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/python-agent/install', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const raw = req.body as Record<string, unknown> | undefined;
    try {
      const version = parseVersion(raw?.version);
      const manager = parseLinuxManager(raw?.manager);
      const plan = buildPythonInstallPlan(process.platform, version, manager);
      const result = await runInstallPlan(plan);
      res.json({ plan, result, revision: ws.stateRevision });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/python-agent/disable', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Set a working directory first' });
    const activeYamlLock = getActiveYamlEditLock(ws);
    if (activeYamlLock) {
      return res.status(423).json({
        error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
        lock: publicYamlEditLock(activeYamlLock),
      });
    }
    try {
      const current = readEditorSettings(ws).pythonAgent;
      const settings = writeEditorSettings(ws, {
        pythonAgent: {
          ...current,
          enabled: false,
        },
      });
      res.json({ settings, revision: ws.stateRevision });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
