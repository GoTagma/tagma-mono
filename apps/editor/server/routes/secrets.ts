import type express from 'express';
import { errorMessage } from '../path-utils.js';
import { requireWorkspace } from '../require-workspace.js';
import { deleteSecret, listSecrets, upsertSecret, type CredentialBackend } from '../secrets.js';

function parseSecretId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[0-9a-fA-F-]{20,80}$/.test(id)) {
    throw new Error('Invalid secret id.');
  }
  return id;
}

export function registerSecretsRoutes(app: express.Express, backend?: CredentialBackend): void {
  app.get('/api/secrets', (req, res) => {
    try {
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
      res.json(listSecrets(ws.workDir, backend));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/secrets', (req, res) => {
    try {
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
      const entry = upsertSecret(ws.workDir, req.body ?? {}, backend);
      res.json({ ok: true, secret: entry });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });

  app.delete('/api/secrets/:id', (req, res) => {
    try {
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
      const id = parseSecretId(req.params.id);
      const removed = deleteSecret(ws.workDir, id, backend);
      if (!removed) return res.status(404).json({ error: `Secret "${id}" was not found.` });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: errorMessage(err) });
    }
  });
}
