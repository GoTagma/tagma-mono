// Codex Driver Plugin
//
// Translates a task into a `codex exec` invocation. Headless runs use
// `-a never` because there is no TTY to confirm on, and permissions map to
// Codex's sandbox policy.
//
// Codex has no native session resume or independent system-prompt flag, so
// `continue_from` and `agent_profile` are folded into the prompt text.

import type {
  DriverPlugin,
  DriverCapabilities,
  TaskConfig,
  TrackConfig,
  DriverContext,
  SpawnSpec,
  Permissions,
  TagmaPlugin,
} from '@tagma/types';

const DEFAULT_MODEL = 'gpt-5-codex';
const DEFAULT_REASONING_EFFORT = 'medium';
const DEFAULT_PERMISSIONS: Permissions = { read: true, write: false, execute: false };
const VALID_REASONING_EFFORT = new Set(['low', 'medium', 'high']);

function resolveSandbox(permissions: Permissions): string {
  if (permissions.execute) return 'danger-full-access';
  if (permissions.write) return 'workspace-write';
  return 'read-only';
}

export const CodexDriver: DriverPlugin = {
  name: 'codex',

  capabilities: {
    sessionResume: false,
    systemPrompt: false,
    outputFormat: false,
  } satisfies DriverCapabilities,

  resolveModel(): string {
    return DEFAULT_MODEL;
  },

  async buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec> {
    const model = task.model ?? track.model ?? DEFAULT_MODEL;
    const rawEffort = task.reasoning_effort ?? track.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    const reasoningEffort = VALID_REASONING_EFFORT.has(rawEffort)
      ? rawEffort
      : DEFAULT_REASONING_EFFORT;
    const sandbox = resolveSandbox(task.permissions ?? track.permissions ?? DEFAULT_PERMISSIONS);

    let prompt = task.prompt!;

    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      prompt = `[Role]\n${profile}\n\n[Task]\n${prompt}`;
    }

    if (task.continue_from) {
      let prev: string | null = null;
      if (ctx.normalizedMap.has(task.continue_from)) {
        prev = ctx.normalizedMap.get(task.continue_from)!;
      }
      if (prev !== null) {
        prompt = `[Previous Output]\n${prev}\n\n[Current Task]\n${prompt}`;
      }
    }

    const args: string[] = [
      'codex',
      '-a',
      'never',
      'exec',
      '--skip-git-repo-check',
      '-c',
      `model_reasoning_effort="${reasoningEffort}"`,
      '--model',
      model,
      '--sandbox',
      sandbox,
      '--color',
      'never',
      '-',
    ];

    return { args, stdin: prompt, cwd: task.cwd ?? ctx.workDir };
  },
};

export default {
  name: '@tagma/driver-codex',
  capabilities: {
    drivers: {
      codex: CodexDriver,
    },
  },
} satisfies TagmaPlugin;
