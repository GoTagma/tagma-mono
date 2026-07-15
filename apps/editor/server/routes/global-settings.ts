import type express from 'express';
import {
  parseGlobalSettingsPatch,
  readGlobalSettings,
  writeGlobalSettings,
} from '../global-settings.js';
import { errorMessage } from '../path-utils.js';

export function registerGlobalSettingsRoutes(app: express.Express): void {
  app.get('/api/global-settings', (_req, res) => {
    res.json(readGlobalSettings());
  });

  app.patch('/api/global-settings', (req, res) => {
    try {
      const patch = parseGlobalSettingsPatch(req.body);
      res.json(writeGlobalSettings(patch));
    } catch (error) {
      res.status(500).json({
        error: 'Failed to save global settings: ' + errorMessage(error),
      });
    }
  });
}
