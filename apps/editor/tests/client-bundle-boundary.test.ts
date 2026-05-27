import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const CLIENT_SRC = join(import.meta.dir, '..', 'src');
const SDK_RUNTIME_IMPORT_RE =
  /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+['"]@tagma\/(?:sdk|core)(?:\/[^'"]*)?['"]/gm;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('client bundle boundaries', () => {
  test('does not import SDK/Core runtime modules into the browser client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CLIENT_SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(SDK_RUNTIME_IMPORT_RE)) {
        offenders.push(`${relative(CLIENT_SRC, file)}: ${match[0].replace(/\s+/g, ' ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
