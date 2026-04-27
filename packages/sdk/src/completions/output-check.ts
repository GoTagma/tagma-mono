import type { CompletionPlugin, CompletionContext, TaskResult } from '../types';
import { parseDuration, shellArgs } from '@tagma/core';

const DEFAULT_TIMEOUT_MS = 30_000;

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  await stream.pipeTo(
    new WritableStream<Uint8Array>({
      write() {
        // Discard check stdout; only exit status matters.
      },
    }),
  );
}

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Wire pipeline abort signal into the check process so external abort
    // terminates the child instead of leaving it running undetected.
    const onAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) {
        controller.abort();
      } else {
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const proc = Bun.spawn(shellArgs(checkCmd) as string[], {
      cwd: ctx.workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });

    try {
      if (proc.stdin) {
        try {
          // Prefer driver-normalized text (e.g. concatenated message text for
          // AI drivers that emit NDJSON). Falling back to raw stdout keeps
          // command tasks and drivers without parseResult working.
          const payload = result.normalizedOutput ?? result.stdout;
          proc.stdin.write(payload);
          proc.stdin.end(); // no await — consistent with runner.ts; proc.exited handles sync
        } catch (err: unknown) {
          // EPIPE is expected when the check process exits before reading all of stdin
          // (e.g. `grep -q` exits on first match). Anything else is a real failure.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPIPE') throw err;
        }
      }

      // Drain stdout and stderr concurrently so verbose check commands cannot
      // block on pipe buffers while the parent waits for process exit.
      const [exitCode, , stderr] = await Promise.all([
        proc.exited,
        drain(proc.stdout),
        new Response(proc.stderr).text(),
      ]);

      if (exitCode !== 0 && stderr.trim()) {
        console.warn(`[output_check] "${checkCmd}" exit=${exitCode}: ${stderr.trim()}`);
      }

      return exitCode === 0;
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};
