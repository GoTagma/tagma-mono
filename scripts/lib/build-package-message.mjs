function errorCode(err) {
  return typeof err?.code === 'string' ? err.code : 'UNKNOWN';
}

function errorPath(err) {
  return typeof err?.path === 'string' ? err.path : null;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function formatBuildCleanupFailure(packageDir, distDir, err) {
  const code = errorCode(err);
  const target = errorPath(err);
  const lines = [
    'Failed to clean package dist directory before build.',
    `Package: ${packageDir}`,
    `Dist: ${distDir}`,
    `Error: ${code}: ${errorMessage(err)}`,
  ];
  if (target) lines.push(`Path: ${target}`);
  lines.push(
    'Remove or unlock the dist directory, then rerun the build. On Windows this often means a process still holds a generated file open.',
  );
  return lines.join('\n');
}
