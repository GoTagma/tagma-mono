// Pure line scanners shared by the focus and secrets gates, extracted
// so their patterns (and the placeholder filter that keeps the secrets
// gate green) are unit-tested for both teeth and false-positive safety.

export const FOCUS_RULES = [
  [/\b(?:describe|context|suite|it|test|bench)\.only\s*\(/, 'focused test (.only) disables sibling tests'],
  [/\bf(?:describe|it)\s*\(/, 'focused test (fdescribe/fit) disables sibling tests'],
  [/\bx(?:describe|it)\s*\(/, 'disabled test (xdescribe/xit) silently skipped'],
  [/(?:^|[^.\w])debugger\s*;/, 'debugger statement left in source'],
];

// Returns the rule message if the line trips a focus rule, else null.
export function focusHit(line) {
  for (const [re, why] of FOCUS_RULES) if (re.test(line)) return why;
  return null;
}

export const SECRET_STRONG = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bASIA[0-9A-Z]{16}\b/, 'AWS temporary access key id'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bxoxb-[0-9A-Za-z-]{20,}\b/, 'Slack bot token'],
  [/\bxox[aprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z\-_]{35}\b/, 'Google API key'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'OpenAI-style secret key'],
];

const GENERIC =
  /(?:secret|token|api[_-]?key|apikey|passwd|password|client[_-]?secret|access[_-]?key|private[_-]?key)\s*[:=]\s*['"]([^'"]{16,})['"]/i;
const PLACEHOLDER =
  /(example|placeholder|your[_-]?|xxx+|<[^>]+>|change[_-]?me|dummy|sample|redacted|\$\{|process\.env|import\.meta|env\.|\bfake\b|\btest[_-]|0{8,}|1234567|abcdef)/i;

// Returns a label if the line carries a high-confidence secret; second
// arg toggles the generic credential-assignment heuristic (off for
// markdown/tests/fixtures to stay false-positive free).
export function secretHit(line, allowGeneric) {
  for (const [re, label] of SECRET_STRONG) if (re.test(line)) return label;
  if (allowGeneric && GENERIC.test(line) && !PLACEHOLDER.test(line)) {
    return 'hardcoded credential-like assignment';
  }
  return null;
}
