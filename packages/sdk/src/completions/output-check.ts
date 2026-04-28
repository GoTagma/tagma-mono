import type { CommandConfig, CompletionPlugin, CompletionContext, TaskResult } from '@tagma/types';
import { commandLabel, commandToSpawnSpec } from '@tagma/core';
import { parseOptionalPluginTimeout } from '../duration';

const DEFAULT_TIMEOUT_MS = 30_000;

export const OutputCheckCompletion: CompletionPlugin = {
  name: 'output_check',
  schema: {
    description:
      'Pipe the task output into a shell command; mark success when that command exits 0. For AI driver tasks the driver-normalized text is piped (not the raw NDJSON); command tasks see their raw stdout.',
    fields: {
      check: {
        type: 'json',
        required: true,
        description:
          'Shell command string or { argv: string[] } to run. The task output is piped to stdin.',
        placeholder: '{ "argv": ["grep", "-q", "PASS"] }',
      },
      timeout: {
        type: 'duration',
        default: '30s',
        description: 'Maximum time to wait for the check command.',
        placeholder: '30s',
      },
    },
  },

  async check(
    config: Record<string, unknown>,
    result: TaskResult,
    ctx: CompletionContext,
  ): Promise<boolean> {
    const checkCmd = config.check;
    if (
      typeof checkCmd !== 'string' &&
      !(
        checkCmd &&
        typeof checkCmd === 'object' &&
        !Array.isArray(checkCmd) &&
        (('shell' in checkCmd && typeof (checkCmd as { shell?: unknown }).shell === 'string') ||
          ('argv' in checkCmd &&
            Array.isArray((checkCmd as { argv?: unknown }).argv) &&
            (checkCmd as { argv: unknown[] }).argv.every((arg) => typeof arg === 'string')))
      )
    ) {
      throw new Error('output_check completion: "check" must be a shell string or { argv: string[] }');
    }
    const command = checkCmd as CommandConfig;

    const timeoutMs = parseOptionalPluginTimeout(config.timeout, DEFAULT_TIMEOUT_MS);

    const payload = result.normalizedOutput ?? result.stdout;
    const checkResult = await ctx.runtime.runSpawn(
      {
        ...commandToSpawnSpec(command, ctx.workDir),
        stdin: payload,
      },
      null,
      {
        timeoutMs,
        signal: ctx.signal,
        maxStdoutTailBytes: 256 * 1024,
        maxStderrTailBytes: 256 * 1024,
        envPolicy: ctx.envPolicy,
      },
    );

    if (checkResult.exitCode !== 0 && checkResult.stderr.trim()) {
      console.warn(
        `[output_check] "${commandLabel(command)}" exit=${checkResult.exitCode}: ${checkResult.stderr.trim()}`,
      );
    }

    return checkResult.exitCode === 0 && checkResult.failureKind === null;
  },
};
