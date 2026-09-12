import { lstatSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isPathWithin } from './path-utils.js';

/** Literal command arguments only; never expand variables or execute a shell. */
function commandWords(command: unknown): string[] {
  if (command && typeof command === 'object') {
    const config = command as { argv?: unknown; shell?: unknown };
    if (Array.isArray(config.argv))
      return config.argv.filter((word): word is string => typeof word === 'string');
    return commandWords(config.shell);
  }
  if (typeof command !== 'string') return [];
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (
      char === '\\' &&
      quote !== "'" &&
      next &&
      (next === quote || (!quote && /[\s'"\\]/u.test(next)))
    ) {
      word += next;
      index++;
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/[\s;|&()<>=]/u.test(char)) {
      if (word) words.push(word);
      word = '';
    } else word += char;
  }
  if (word) words.push(word);
  return words;
}

function fileState(path: string): 'file' | 'missing' | 'other' {
  try {
    return lstatSync(path).isFile() ? 'file' : 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

/**
 * A command's literal target-pipeline file arguments must resolve to the same
 * regular bytes as the authenticated snapshot. This covers interpreters, direct
 * scripts, config arguments and completion/hook commands without a language or
 * extension allowlist. An absent file on both sides remains a runtime error.
 * Dynamic paths and transitive imports are not inferred by this lexical check.
 */
export function commandUsesUnpublishedPipelineFile(
  command: unknown,
  effectiveCwd: string,
  projection: { livePipelineDir: string; stagedPipelineDir: string },
  availability: Map<string, boolean>,
): boolean {
  return commandWords(command).some((argument) => {
    const word =
      argument.startsWith('-') && argument.includes('=')
        ? argument.slice(argument.indexOf('=') + 1)
        : argument;
    if (!word || word.startsWith('-')) return false;
    const live = resolve(effectiveCwd, word);
    if (!isPathWithin(live, projection.livePipelineDir)) return false;
    const staged = resolve(
      projection.stagedPipelineDir,
      relative(projection.livePipelineDir, live),
    );
    if (!isPathWithin(staged, projection.stagedPipelineDir)) return true;
    let matches = availability.get(live);
    if (matches === undefined) {
      const liveState = fileState(live);
      const stagedState = fileState(staged);
      // Directory arguments and unknown/missing paths are not file evidence.
      if (liveState !== 'file' && stagedState !== 'file') return false;
      matches = false;
      if (liveState === 'file' && stagedState === 'file') {
        try {
          matches =
            lstatSync(live).size === lstatSync(staged).size &&
            readFileSync(live).equals(readFileSync(staged));
        } catch {
          /* unavailable */
        }
      }
      availability.set(live, matches);
    }
    return !matches;
  });
}
