const lifecycleScriptPattern =
  /\b(?:preinstall|install|postinstall|prepare|prepublishOnly)\b.*\b(?:script|exited|failed)|\blifecycle script\b/i;

const lockfileDriftPattern =
  /\blockfile\b.*\b(?:had changes|frozen|out of sync|would be modified)\b|\bfrozen lockfile\b/i;

const OUTPUT_TAIL_LINES = 12;

function commandTail(stdout, stderr) {
  return `${stdout ?? ''}${stderr ?? ''}`
    .trim()
    .split(/\r?\n/)
    .slice(-OUTPUT_TAIL_LINES)
    .join('\n');
}

export function formatFrozenInstallDetail(result) {
  if (typeof result.status === 'number') return `exit ${result.status}`;
  if (result.signal) return `signal ${result.signal}`;
  if (result.error?.message) return `error ${result.error.message}`;
  return 'unknown failure';
}

export function formatFrozenInstallFailure(result) {
  const detail = formatFrozenInstallDetail(result);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const tail = commandTail(result.stdout, result.stderr);
  let reason;

  if (lifecycleScriptPattern.test(output)) {
    reason =
      'A lifecycle script or build step failed while Bun verified the frozen lockfile. ' +
      'Fix the script failure shown below, then rerun this gate.';
  } else if (lockfileDriftPattern.test(output)) {
    reason =
      'The lockfile is out of sync with package.json. Run `bun install` and commit bun.lock.';
  } else {
    reason =
      'Bun could not verify the frozen lockfile. See the Bun output below; this may be ' +
      'lockfile drift or an install-time script failure.';
  }

  return `bun install --frozen-lockfile failed (${detail}). ${reason}${tail ? `\n${tail}` : ''}`;
}
