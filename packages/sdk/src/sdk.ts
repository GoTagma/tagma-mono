// ═══ tagma-sdk public API ═══
//
// This is the SDK entry point. Import from here, not from internal modules.
// The CLI (src/index.ts in the CLI project) also imports from here.

// ── Core engine ──
export { runPipeline, TriggerBlockedError, TriggerTimeoutError } from './engine';
export type { EngineResult, RunPipelineOptions, PipelineEvent } from './engine';

// ── Pipeline runner (multi-pipeline lifecycle management) ──
export { PipelineRunner } from './pipeline-runner';
export type { PipelineRunnerStatus } from './pipeline-runner';

// ── Raw config CRUD (visual editor / YAML sync) ──
export {
  createEmptyPipeline,
  setPipelineField,
  upsertTrack,
  removeTrack,
  moveTrack,
  updateTrack,
  upsertTask,
  removeTask,
  moveTask,
  transferTask,
} from './config-ops';

// ── Raw config validation (real-time feedback) ──
export { validateRaw } from './validate-raw';
export type { ValidationError } from './validate-raw';

// ── Schema: parse / resolve / load / serialize / validate ──
export { parseYaml, resolveConfig, expandTemplates, loadPipeline, serializePipeline, deresolvePipeline, validateConfig } from './schema';

// ── Templates: discovery + manifest loading (F1) ──
export { discoverTemplates, loadTemplateManifest } from './templates';
export type { TemplateManifest } from './templates';

// ── DAG ──
export { buildDag, buildRawDag } from './dag';
export type { DagNode, Dag, RawDagNode, RawDag } from './dag';

// ── Plugin registry ──
export { bootstrapBuiltins } from './bootstrap';
export {
  loadPlugins,
  registerPlugin,
  unregisterPlugin,
  getHandler,
  hasHandler,
  listRegistered,
  isValidPluginName,
  PLUGIN_NAME_RE,
  readPluginManifest,
} from './registry';
export type { RegisterResult } from './registry';

// ── Approval gateway ──
export { InMemoryApprovalGateway } from './approval';
export type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalEvent,
  ApprovalListener,
} from './approval';

// ── Approval adapters ──
export { attachStdinApprovalAdapter } from './adapters/stdin-approval';
export type { StdinApprovalAdapter } from './adapters/stdin-approval';
export { attachWebSocketApprovalAdapter } from './adapters/websocket-approval';
export type { WebSocketApprovalAdapter, WebSocketApprovalAdapterOptions } from './adapters/websocket-approval';

// ── Logger ──
export { Logger, tailLines, clip } from './logger';
export type { LogRecord, LogLevel, LogListener } from './logger';

// ── Hook context types (useful for frontend display) ──
export type { HookResult, PipelineInfo, TrackInfo, TaskInfo } from './hooks';

// ── Utils (public subset) ──
export { parseDuration, validatePath, generateRunId, nowISO, truncateForName } from './utils';

// ── All types from @tagma/types + runtime constants ──
export * from './types';
