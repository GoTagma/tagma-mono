const { spawnSync } = require('node:child_process');

const executable =
  'D:\\nvm\\v22.19.0\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
const result = spawnSync(
  executable,
  ['--codex-run-as-apply-patch', process.env.TAGMA_APPLY_PATCH_INPUT],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
