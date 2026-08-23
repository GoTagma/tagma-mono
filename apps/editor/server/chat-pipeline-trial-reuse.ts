import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { buildDag } from '@tagma/sdk/config';
import type { PipelineConfig } from '@tagma/sdk';

import type { ChatPipelineTrialMode } from './chat-pipeline-trialability.js';
import type { ChatPipelineTrialPlanCase } from './chat-pipeline-trial-plan.js';
import type { WorkspaceRuntimeMode } from './execution/native-broker.js';

interface ChatPipelineTrialCaseReuseFingerprintInput {
  pipelineConfig: PipelineConfig;
  relativeYamlPath: string;
  testCase: ChatPipelineTrialPlanCase;
  supportTreeHash: string;
  trialabilityReportHash: string;
  trialMode: ChatPipelineTrialMode;
  runtimeMode: WorkspaceRuntimeMode;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

/**
 * Return a cross-revision cache key only for deterministic command-only target
 * closures. Prompt closures deliberately rerun: model/provider behavior is an
 * execution input even when their YAML text is unchanged.
 */
export function buildChatPipelineTrialCaseReuseFingerprint(
  input: ChatPipelineTrialCaseReuseFingerprintInput,
): string | null {
  const dag = buildDag(input.pipelineConfig);
  const pending = [...input.testCase.targetTaskIds];
  const visited = new Set<string>();
  const closure: Array<Record<string, unknown>> = [];

  while (pending.length > 0) {
    const taskId = pending.pop()!;
    if (visited.has(taskId)) continue;
    const node = dag.nodes.get(taskId);
    if (!node) return null;
    if (
      node.task.command === undefined ||
      node.task.prompt !== undefined ||
      node.task.trigger !== undefined
    ) {
      return null;
    }
    visited.add(taskId);
    pending.push(...node.dependsOn);
    closure.push({
      taskId,
      track: {
        id: node.track.id,
        cwd: node.track.cwd,
        on_failure: node.track.on_failure,
        secrets: node.track.secrets,
        permissions: node.track.permissions,
      },
      task: {
        id: node.task.id,
        command: node.task.command,
        cwd: node.task.cwd,
        depends_on: [...node.dependsOn].sort(),
        trigger: node.task.trigger,
        completion: node.task.completion,
        timeout: node.task.timeout,
        secrets: node.task.secrets,
        permissions: node.task.permissions,
        inputs: node.task.inputs,
        outputs: node.task.outputs,
      },
    });
  }

  closure.sort((left, right) => String(left.taskId).localeCompare(String(right.taskId)));
  const payload = canonicalValue({
    version: 1,
    relativeYamlPath: input.relativeYamlPath.replace(/\\/gu, '/'),
    pipeline: {
      requires: input.pipelineConfig.requires,
      hooks: input.pipelineConfig.hooks,
      plugins: input.pipelineConfig.plugins,
      secrets: input.pipelineConfig.secrets,
      permissions: input.pipelineConfig.permissions,
      timeout: input.pipelineConfig.timeout,
      max_concurrency: input.pipelineConfig.max_concurrency,
    },
    closure,
    testCase: input.testCase,
    supportTreeHash: input.supportTreeHash,
    trialabilityReportHash: input.trialabilityReportHash,
    trialMode: input.trialMode,
    runtimeMode: input.runtimeMode,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function normalizedRequirementsBytes(content: Buffer): Buffer {
  const text = content.toString('utf8');
  return Buffer.from(text.replace(/^(\s*generatedAt:\s*).+$/mu, '$1<host-generated>'), 'utf8');
}

/** Hash user-owned support inputs while excluding YAML-bound generated companions. */
export function hashChatPipelineTrialReusableSupportTree(pipelineYamlPath: string): string {
  const pipelineDir = dirname(pipelineYamlPath);
  const yamlName = basename(pipelineYamlPath);
  const stem = yamlName.replace(/\.ya?ml$/iu, '');
  const excluded = new Set([
    yamlName,
    `${stem}.compile.log`,
    `${stem}.layout.json`,
    `${stem}.manifest.json`,
    `${stem}.trial-plan.json`,
  ]);
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const relativePath = relative(pipelineDir, path).replace(/\\/gu, '/');
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (!relativePath.includes('/') && excluded.has(entry.name)) continue;
      const bytes = readFileSync(path);
      entries.push({
        path: relativePath,
        bytes:
          !relativePath.includes('/') && entry.name === `${stem}.requirements.md`
            ? normalizedRequirementsBytes(bytes)
            : bytes,
      });
    }
  };
  visit(pipelineDir);
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path).update('\0').update(entry.bytes).update('\0');
  }
  return hash.digest('hex');
}
