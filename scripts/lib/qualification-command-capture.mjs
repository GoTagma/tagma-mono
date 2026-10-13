import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const QUALIFICATION_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function runQualificationCommand(
  executable,
  args,
  { cwd, env, maxBuffer = QUALIFICATION_CAPTURE_MAX_BYTES } = {},
) {
  if (
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > QUALIFICATION_CAPTURE_MAX_BYTES
  ) {
    throw new TypeError('qualification_capture_limit_invalid');
  }
  const result = spawnSync(executable, args, {
    cwd,
    env,
    maxBuffer,
    encoding: null,
    windowsHide: true,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  const capture = {
    maxBuffer,
    exitCode: result.status,
    exitSignal: result.signal,
    errorCode: result.error?.code ?? null,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
  if (result.error || result.signal !== null || result.status !== 0) {
    const error = new Error(
      result.error?.code === 'ENOBUFS'
        ? 'qualification_capture_output_overflow'
        : 'qualification_command_failed',
    );
    error.code =
      result.error?.code === 'ENOBUFS'
        ? 'QUALIFICATION_OUTPUT_OVERFLOW'
        : 'QUALIFICATION_COMMAND_FAILED';
    error.capture = capture; // Metadata only; partial raw output is never returned as successful output.
    throw error;
  }
  return { stdout, stderr, capture };
}
