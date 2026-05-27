import type express from 'express';
import { getHotupdateStatus } from '../release/hotupdate-lock.js';

export function registerHotupdateRoutes(app: express.Express): void {
  app.get('/api/hotupdate/status', (_req, res) => {
    res.json(getHotupdateStatus());
  });
}
