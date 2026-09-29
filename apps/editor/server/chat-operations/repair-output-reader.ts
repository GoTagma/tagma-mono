import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_SERVER_RECORD_BYTES } from '../server-record-auth';

export interface TrialTaskOutputPaths {
  stdoutPath?: string | null;
  stderrPath?: string | null;
}

/** Only the Host-emitted log coordinate for this completed run is read, never an error-text path. */
export function readCompleteRepairOutput(workDir: string, logPath: string, path: string): Buffer {
  const root = resolve(workDir);
  const output = resolve(path);
  const logs = resolve(dirname(logPath));
  const logRelative = relative(root, logs);
  const outputRelative = relative(logs, output);
  if (
    isAbsolute(logRelative) ||
    logRelative.startsWith('..') ||
    !outputRelative ||
    isAbsolute(outputRelative) ||
    outputRelative.startsWith('..') ||
    dirname(output) !== logs ||
    basename(output).includes(':')
  ) {
    throw new Error('Complete task output is outside its Host-owned run log directory.');
  }
  let coordinate = root;
  for (const component of [
    root,
    ...relative(root, output)
      .split(sep)
      .map((part) => (coordinate = resolve(coordinate, part))),
  ]) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink()) throw new Error('Complete task output crosses a symbolic link.');
    if (component !== output && !stat.isDirectory())
      throw new Error('Complete task output parent is not a directory.');
  }
  const before = lstatSync(output, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n)
    throw new Error('Complete task output is not a private regular log file.');
  if (before.size > BigInt(MAX_SERVER_RECORD_BYTES))
    throw new Error(
      'Complete task output exceeds the existing authenticated-record limit; it was not reduced to an excerpt.',
    );
  const descriptor = openSync(output, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev
    )
      throw new Error('Complete task output identity changed before reading.');
    const bytes = readFileSync(descriptor);
    const after = lstatSync(output, { bigint: true });
    const finished = fstatSync(descriptor, { bigint: true });
    const actualOutput = realpathSync.native(output);
    const actualLogs = realpathSync.native(logs);
    if (dirname(actualOutput) !== actualLogs)
      throw new Error('Complete task output moved outside its Host-owned log directory.');
    if (
      after.isSymbolicLink() ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      finished.size !== opened.size ||
      BigInt(bytes.length) !== opened.size
    )
      throw new Error('Complete task output changed while reading.');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
