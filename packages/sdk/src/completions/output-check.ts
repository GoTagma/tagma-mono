import type { CompletionPlugin, CompletionContext, TaskResult } from '../types';
import { parseDuration, shellArgs } from '@tagma/core';

const DEFAULT_TIMEOUT_MS = 30_000;

export const OutputCheckCompletion: CompletionPlugin = {
  name: 'output_check',
  schema: {
    description:
      'Pipe the task output into a shell command; mark success when that command exits 0. For AI driver tasks the driver-normalized text is piped (not the raw NDJSON); command tasks see their raw stdout.',
    fields: {
      check: {
        type: 'string',
        required: true,
        description:
          'Shell command to run. The task output is piped to its stdin — normalizedOutput when the driver provides one, otherwise raw stdout.',
        placeholder: "grep -q 'PASS'",
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
    const checkCmd = config.check as string;
    if (!checkCmd) throw new Error('output_check completion: "check" is required');

    const timeoutMs =
      config.timeout != null ? parseDuration(String(config.timeout)) : DEFAULT_TIMEOUT_MS;

    const payload = result.normalizedOutput ?? result.stdout;
    const checkResult = await ctx.runtime.runSpawn(
      {
        args: shellArgs(checkCmd),
        cwd: ctx.workDir,
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
      console.warn(`[output_check] "${checkCmd}" exit=${checkResult.exitCode}: ${checkResult.stderr.trim()}`);
    }

    return checkResult.exitCode === 0 && checkResult.failureKind === null;
  },
};
