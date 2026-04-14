// Preinstall guard — refuses installation under npm / yarn / pnpm.
// @tagma/sdk is published as pre-built JS (dist/) but historically shipped
// TypeScript source. The guard remains for external consumers who might try
// to install via non-Bun managers that can't resolve the dist/ entry points.
//
// In the monorepo, Bun workspace links this package directly, so this script
// is only hit during `npm publish` or external installs.

const ua = process.env.npm_config_user_agent || '';
if (process.versions.bun || ua.startsWith('bun/') || ua.startsWith('bun ')) {
  process.exit(0);
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

process.stderr.write(
  [
    '',
    red(bold('  @tagma/sdk requires Bun (>= 1.3).')),
    '',
    '  Install with:',
    cyan('    bun add @tagma/sdk'),
    '',
    '  Get Bun: https://bun.sh',
    '',
  ].join('\n') + '\n',
);

process.exit(1);