import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OpenCode context-window plugin.
 *
 * The plugin runs inside the managed OpenCode process (a different module graph
 * from the sidecar), so the whole trimming policy is serialized into the
 * generated source as a self-contained module — exactly like the seeded custom
 * tools. It hooks `experimental.chat.messages.transform` (verified present in
 * pinned OpenCode 1.17.8: `packages/opencode/src/session/prompt.ts` and
 * `compaction.ts` both call `plugin.trigger("experimental.chat.messages.transform",
 * {}, { messages: msgs })` and then keep using the same `msgs` array, so the
 * hook must splice in place and never reassign `output.messages`).
 *
 * The hook fires for every model request in the workspace process, so it only
 * acts when a host-authored `<tagma-chat-context-window>` marker is present in
 * the current prompt's `<editor-context>` (or, for a hidden internal repair
 * continuation, in the most recent visible user turn). Bot-bridge, standalone
 * CLI, and legacy pre-marker threads have no marker and are left untouched.
 *
 * On init the plugin writes a readiness marker into `.opencode/` so the sidecar
 * can fail closed: when the limit setting is on but the plugin did not load,
 * the editor blocks the send instead of silently exposing the full history.
 */
export const OPENCODE_CONTEXT_WINDOW_PLUGIN_FILENAME = 'tagma-chat-context-window.ts';
export const OPENCODE_CONTEXT_WINDOW_READY_FILENAME = '.tagma-chat-context-window-ready.json';
export const OPENCODE_CONTEXT_WINDOW_PLUGIN_ID = 'tagma-chat-context-window';
export const OPENCODE_CONTEXT_WINDOW_SCHEMA = 1;

export function opencodeContextWindowReadyPath(tagmaCwd: string): string {
  return join(tagmaCwd, '.opencode', OPENCODE_CONTEXT_WINDOW_READY_FILENAME);
}

export interface OpencodeContextWindowPluginReady {
  ready: boolean;
  schema: number;
}

export function readOpencodeContextWindowPluginReady(
  tagmaCwd: string,
): OpencodeContextWindowPluginReady {
  try {
    const parsed = JSON.parse(readFileSync(opencodeContextWindowReadyPath(tagmaCwd), 'utf8')) as {
      schema?: unknown;
      plugin?: unknown;
      ready?: unknown;
    };
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.plugin === OPENCODE_CONTEXT_WINDOW_PLUGIN_ID &&
      parsed.ready === true &&
      parsed.schema === OPENCODE_CONTEXT_WINDOW_SCHEMA
    ) {
      return { ready: true, schema: OPENCODE_CONTEXT_WINDOW_SCHEMA };
    }
  } catch {
    // Missing or unreadable marker — the plugin has not reported readiness.
  }
  return { ready: false, schema: 0 };
}

/**
 * Wait (bounded) for the plugin to report readiness after an OpenCode start or
 * restart. Plugin modules load during server startup, which can finish after
 * the health probe, so the ensure/restart routes poll the marker before
 * answering. If the plugin file was never seeded (headless/legacy workspace),
 * report not-ready immediately instead of burning the full timeout.
 */
export async function waitForOpencodeContextWindowPluginReady(
  tagmaCwd: string,
  timeoutMs = 15_000,
): Promise<OpencodeContextWindowPluginReady> {
  const pluginPath = join(
    tagmaCwd,
    '.opencode',
    'plugins',
    OPENCODE_CONTEXT_WINDOW_PLUGIN_FILENAME,
  );
  if (!existsSync(pluginPath)) return { ready: false, schema: 0 };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const readiness = readOpencodeContextWindowPluginReady(tagmaCwd);
    if (readiness.ready) return readiness;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readOpencodeContextWindowPluginReady(tagmaCwd);
}

function pluginReadyMarkerSource(): string {
  return [
    '{',
    '  "schema": ' + String(OPENCODE_CONTEXT_WINDOW_SCHEMA) + ',',
    '  "plugin": "' + OPENCODE_CONTEXT_WINDOW_PLUGIN_ID + '",',
    '  "ready": true',
    '}',
  ].join('\n');
}

/**
 * Build the plugin module source seeded into every workspace's
 * `.opencode/plugins/`. Plain JavaScript (Bun loads it as TypeScript without
 * type-checking) with zero imports beyond node built-ins, so it can never break
 * on an unrelated editor dependency.
 */
export function buildTagmaChatContextWindowPlugin(): string {
  return [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    '',
    'const READY_FILE = "' + OPENCODE_CONTEXT_WINDOW_READY_FILENAME + '";',
    'const READY = ' + pluginReadyMarkerSource() + ';',
    'const INTERNAL_TURN_PREFIX = "<tagma-internal>";',
    '',
    'function isTextPart(part) {',
    '  return !!part && part.type === "text" && typeof part.text === "string";',
    '}',
    '',
    'function isInternalContinuation(message) {',
    '  const parts = message && message.parts ? message.parts : [];',
    '  for (const part of parts) {',
    '    if (isTextPart(part) && part.text.includes(INTERNAL_TURN_PREFIX)) return true;',
    '  }',
    '  return false;',
    '}',
    '',
    'function isSyntheticCompaction(message) {',
    '  const parts = message && message.parts ? message.parts : [];',
    '  for (const part of parts) {',
    '    if (!isTextPart(part)) continue;',
    '    if (part.synthetic === true) return true;',
    '    if (part.metadata && part.metadata.compaction_continue === true) return true;',
    '  }',
    '  return false;',
    '}',
    '',
    'function isVisibleUserTurn(message) {',
    '  if (!message || !message.info || message.info.role !== "user") return false;',
    '  if (isInternalContinuation(message)) return false;',
    '  if (isSyntheticCompaction(message)) return false;',
    '  const parts = message.parts ? message.parts : [];',
    '  for (const part of parts) {',
    '    if (isTextPart(part)) return true;',
    '  }',
    '  return false;',
    '}',
    '',
    'function collectVisibleUserStarts(messages) {',
    '  const starts = [];',
    '  for (let index = 0; index < messages.length; index += 1) {',
    '    if (isVisibleUserTurn(messages[index])) starts.push(index);',
    '  }',
    '  return starts;',
    '}',
    '',
    'function readAttribute(attributes, name) {',
    '  const match = attributes.match(new RegExp("\\\\b" + name + "\\\\s*=\\\\s*[\\"\']([^\\"\']*)[\\"\']"));',
    '  return match ? match[1] : null;',
    '}',
    '',
    'function readInteger(attributes, name) {',
    '  const raw = readAttribute(attributes, name);',
    '  if (raw === null) return null;',
    '  const value = Number.parseInt(raw, 10);',
    '  return Number.isFinite(value) ? value : null;',
    '}',
    '',
    'function parseMarker(messageText) {',
    '  if (typeof messageText !== "string" || !messageText.trimStart().startsWith("<editor-context>")) {',
    '    return null;',
    '  }',
    '  const blockMatch = messageText.match(/^<editor-context>([\\s\\S]*?)<\\/editor-context>/);',
    '  const block = blockMatch ? blockMatch[1] : "";',
    '  const tagMatch = block.match(/<tagma-chat-context-window\\b([^>]*)>/);',
    '  if (!tagMatch) return null;',
    '  const attributes = tagMatch[1];',
    '  if (readInteger(attributes, "schema") !== 1) return null;',
    '  const mode = readAttribute(attributes, "mode");',
    '  if (mode === "last-rounds") {',
    '    const priorRoundLimit = readInteger(attributes, "prior-round-limit");',
    '    if (priorRoundLimit === null) return null;',
    '    return { mode: "last-rounds", priorRoundLimit: Math.max(0, Math.trunc(priorRoundLimit)) };',
    '  }',
    '  if (mode === "unlimited") return { mode: "unlimited" };',
    '  return null;',
    '}',
    '',
    'function editorContextTextOf(message) {',
    '  const parts = message && message.parts ? message.parts : [];',
    '  for (const part of parts) {',
    '    if (isTextPart(part) && part.text.trimStart().startsWith("<editor-context>")) return part.text;',
    '  }',
    '  return null;',
    '}',
    '',
    'function parsePolicy(messages) {',
    '  if (messages.length === 0) return null;',
    '  const currentText = editorContextTextOf(messages[messages.length - 1]);',
    '  const currentMarker = currentText ? parseMarker(currentText) : null;',
    '  if (currentMarker) return currentMarker;',
    '  const visibleStarts = collectVisibleUserStarts(messages);',
    '  if (visibleStarts.length === 0) return null;',
    '  const lastVisibleText = editorContextTextOf(messages[visibleStarts[visibleStarts.length - 1]]);',
    '  return lastVisibleText ? parseMarker(lastVisibleText) : null;',
    '}',
    '',
    'function applyContextWindow(messages, previousRoundLimit) {',
    '  const visibleUserStarts = collectVisibleUserStarts(messages);',
    '  if (visibleUserStarts.length === 0) return;',
    '  const currentUserPosition = visibleUserStarts.length - 1;',
    '  const firstRetainedPosition = Math.max(0, currentUserPosition - Math.max(0, Math.trunc(previousRoundLimit)));',
    '  const cutoffIndex = visibleUserStarts[firstRetainedPosition];',
    '  if (cutoffIndex > 0) messages.splice(0, cutoffIndex);',
    '}',
    '',
    'export const TagmaChatContextWindow = async ({ directory }) => {',
    '  try {',
    '    const readyDir = join(directory, ".opencode");',
    '    mkdirSync(readyDir, { recursive: true });',
    '    writeFileSync(join(readyDir, READY_FILE), JSON.stringify(READY, null, 2), "utf8");',
    '  } catch (err) {',
    '    console.error("[tagma-chat-context-window] failed to write readiness marker:", err);',
    '  }',
    '  return {',
    '    "experimental.chat.messages.transform": async (_input, output) => {',
    '      const messages = output && output.messages;',
    '      if (!Array.isArray(messages) || messages.length === 0) return;',
    '      const policy = parsePolicy(messages);',
    '      if (!policy || policy.mode !== "last-rounds" || typeof policy.priorRoundLimit !== "number") return;',
    '      applyContextWindow(messages, policy.priorRoundLimit);',
    '    },',
    '  };',
    '};',
    '',
  ].join('\n');
}
