#!/usr/bin/env node
// ANGLE: hardcoded credentials in tracked files.
//
// No existing gate looks at content for leaked secrets. A committed
// private key, cloud key or provider token passes text/format/types/
// lint/test/build untouched. This gate fails on high-confidence secret
// signatures across tracked files, plus a generic "<secretish> = '...'"
// assignment with strict placeholder filtering to keep it green on a
// clean tree.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, reportGate, trackedFiles } from './lib/repo.mjs';

// Strong signatures: scanned in every tracked text file.
const STRONG = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'AWS temporary access key id'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z\-_]{35}\b/, 'Google API key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style secret key'],
  [/\bxoxb-[0-9A-Za-z-]{20,}\b/, 'Slack bot token'],
];

// Generic assignment: only in code-ish files, with placeholder guard.
const GENERIC =
  /(?:secret|token|api[_-]?key|apikey|passwd|password|client[_-]?secret|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]([^'"]{16,})['"]/i;
const PLACEHOLDER =
  /(example|placeholder|your[_-]?|xxx+|<[^>]+>|change[_-]?me|dummy|sample|redacted|\$\{|process\.env|import\.meta|env\.|\bfake\b|\btest[_-]|0{8,}|1234567|abcdef)/i;
const CODE_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs|json|ya?ml|env)$/;
const SKIP_GENERIC =
  /(\.test\.|\.spec\.|__fixtures__|\/fixtures\/|\/__mocks__\/|\.example$|\.md$|examples?\/)/;

const failures = [];
for (const file of trackedFiles()) {
  if (file === 'bun.lock') continue;
  let text;
  try {
    text = readFileSync(join(repoRoot, file), 'utf8');
  } catch {
    continue; // binary / unreadable
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [re, label] of STRONG) {
      if (re.test(line)) failures.push(`${file}:${i + 1}: ${label}`);
    }
    if (CODE_EXT.test(file) && !SKIP_GENERIC.test(file)) {
      const m = GENERIC.exec(line);
      if (m && !PLACEHOLDER.test(line)) {
        failures.push(`${file}:${i + 1}: hardcoded credential-like assignment -> ${line.trim().slice(0, 80)}`);
      }
    }
  }
}

reportGate('secrets-check', [...new Set(failures)], 'clean (no hardcoded secrets detected)');
