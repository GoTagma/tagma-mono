import type express from 'express';
import {
  parseGlobalSettingsPatch,
  readGlobalSettings,
  writeGlobalSettings,
} from '../global-settings.js';
import { errorMessage } from '../path-utils.js';
import {
  MAX_OPENCODE_AGENT_MAX_STEPS,
  MIN_OPENCODE_AGENT_MAX_STEPS,
  isValidOpencodeAgentMaxSteps,
} from '../../shared/opencode-agent-step-limit.js';
import { getActiveYamlEditLock, publicYamlEditLock } from '../yaml-edit-lock.js';

function hasExplicitAgentMaxSteps(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'opencodeAgentMaxSteps')
  );
}

export function registerGlobalSettingsRoutes(app: express.Express): void {
  app.get('/api/global-settings', (_req, res) => {
    res.json(readGlobalSettings());
  });

  app.patch('/api/global-settings', (req, res) => {
    try {
      if (
        hasExplicitAgentMaxSteps(req.body) &&
        !isValidOpencodeAgentMaxSteps(req.body.opencodeAgentMaxSteps)
      ) {
        return res.status(400).json({
          error:
            `opencodeAgentMaxSteps must be a whole number from ` +
            `${MIN_OPENCODE_AGENT_MAX_STEPS} to ${MAX_OPENCODE_AGENT_MAX_STEPS}.`,
        });
      }
      if (hasExplicitAgentMaxSteps(req.body) && req.workspace) {
        const activeYamlLock = getActiveYamlEditLock(req.workspace);
        if (activeYamlLock) {
          return res.status(423).json({
            error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
            lock: publicYamlEditLock(activeYamlLock),
          });
        }
      }
      const patch = parseGlobalSettingsPatch(req.body);
      res.json(writeGlobalSettings(patch));
    } catch (error) {
      res.status(500).json({
        error: 'Failed to save global settings: ' + errorMessage(error),
      });
    }
  });
}
