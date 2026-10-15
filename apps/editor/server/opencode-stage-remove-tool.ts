import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type StageRemoveContext = {
  directory: string;
  sessionID: string;
  agent: string;
  abort: AbortSignal;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

/** Canonical spellings can differ on Windows; filesystem identity stays authoritative. */
export function sameStagedDirectory(left: string, right: string): boolean {
  const a = lstatSync(left, { bigint: true });
  if (!a.isDirectory() || a.isSymbolicLink()) return false;
  if (left === right) return true;
  const b = lstatSync(right, { bigint: true });
  return (
    a.isDirectory() &&
    b.isDirectory() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.ino > 0n &&
    a.ino === b.ino &&
    a.dev === b.dev
  );
}

/** Only the Host-relocated author may remove one entry in its private staging root. */
export async function removeStagedEntry(
  args: { path: string },
  context: StageRemoveContext,
): Promise<string> {
  function authorize(): string {
    if (context.abort.aborted) throw new Error('Staged removal aborted.');
    if (context.agent !== 'tagma-pipeline')
      throw new Error('Staged removal requires the pipeline author.');
    const root = realpathSync(context.directory);
    const stage = dirname(dirname(root));
    if (
      basename(root) !== '.tagma' ||
      basename(dirname(root)) !== 'agent-workspace' ||
      basename(dirname(stage)) !== '.chat-staging'
    )
      throw new Error('Staged removal requires a private agent root.');
    const metadataPath = join(stage, 'stage.json');
    const metadataStat = lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1)
      throw new Error('Invalid Host stage metadata.');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const binding = metadata.sessionRelocation;
    if (
      metadata.id !== basename(stage) ||
      metadata.lifecycleOwner !== 'chat-operation-v2' ||
      binding?.version !== 1 ||
      binding.stageId !== metadata.id ||
      binding.sessionId !== context.sessionID ||
      binding.phase !== 'staged' ||
      typeof binding.targetDirectory !== 'string' ||
      !sameStagedDirectory(realpathSync(binding.targetDirectory), root)
    )
      throw new Error('Staged removal requires the current Host session binding.');
    return root;
  }
  const root = authorize();
  if (typeof args.path !== 'string' || !args.path || args.path.includes('\0'))
    throw new Error('A staged entry path is required.');
  const target = resolve(root, args.path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('Removal must stay strictly inside the private agent root.');
  function inspect() {
    let current = root;
    const parts = rel.split(sep);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (stat.isSymbolicLink())
        throw new Error('Removal cannot traverse or remove symbolic links.');
      if (index < parts.length - 1 && !stat.isDirectory())
        throw new Error('Removal ancestor must be a directory.');
      if (index === parts.length - 1) {
        if (!stat.isFile() && !stat.isDirectory())
          throw new Error('Removal accepts regular files or empty directories only.');
        if (stat.isFile() && stat.nlink !== 1)
          throw new Error('Removal cannot remove a multiply linked file.');
        if (stat.isDirectory() && readdirSync(current).length !== 0)
          throw new Error('Removal cannot remove a nonempty directory.');
        return stat;
      }
    }
    return null;
  }
  const before = inspect();
  await context.ask({
    permission: 'edit',
    patterns: [target],
    always: [],
    metadata: { filepath: target },
  });
  if (authorize() !== root) throw new Error('Private stage identity changed during approval.');
  const after = inspect();
  if (
    before?.dev !== after?.dev ||
    before?.ino !== after?.ino ||
    before?.mode !== after?.mode ||
    before?.ctimeMs !== after?.ctimeMs
  )
    throw new Error('Staged entry changed during approval.');
  if (!after) return JSON.stringify({ path: rel, removed: false, alreadyAbsent: true });
  // No await between final identity checks and the bounded filesystem mutation.
  if (after.isDirectory()) rmdirSync(target);
  else unlinkSync(target);
  return JSON.stringify({ path: rel, removed: true });
}

export function buildTagmaStageRemoveTool(): string {
  return `import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tool } from '@opencode-ai/plugin';
const sameStagedDirectory = (${sameStagedDirectory.toString()});
const removeStagedEntry = (${removeStagedEntry.toString()});
export default tool({
  description: 'Remove one unintended staged regular file or EMPTY directory inside the authenticated private author workspace. For scope repair, remove fresh files and then empty directories bottom-up. Never recursively deletes, uses shell, accesses the live workspace, or changes the classified target. Existing Host scope and publication checks still apply.',
  args: { path: tool.schema.string().describe('Path relative to the private agent root (or its absolute equivalent). Only a regular file or empty directory; never the root, links, or outside paths.') },
  async execute(args, context) { return removeStagedEntry(args, context); }
});`;
}
