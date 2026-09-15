import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forceStopProcessTree } from './chat-v2-agent-loop';

// Manual/CLI-driven real-editor validation. This never sends a model request by itself.
const editor = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(editor, '..', '..');
const compiled = process.argv.includes('--compiled');
const desktop = process.argv.includes('--desktop-release')
  ? 'release'
  : process.argv.includes('--desktop-debug')
    ? 'debug'
    : null;
const resumeIndex = process.argv.indexOf('--resume');
const resume =
  resumeIndex >= 0
    ? (JSON.parse(readFileSync(process.argv[resumeIndex + 1]!, 'utf8')) as {
        runRoot: string;
        origin: string;
      })
    : null;
const runRoot = resume?.runRoot ?? mkdtempSync(join(tmpdir(), 'tagma-chat-control-lab-'));
if (!resolve(runRoot).startsWith(join(tmpdir(), 'tagma-chat-control-lab-')))
  throw new Error('Refusing a non-lab runtime directory.');
const workspace = join(runRoot, 'workspace');
const artifacts = join(root, 'output', 'playwright', `chat-control-${Date.now()}`);
const profile = join(runRoot, 'desktop-profile');
const desktopLogFile = join(profile, 'logs', 'sidecar.log');
const desktopLogOffset =
  desktop && existsSync(desktopLogFile) ? readFileSync(desktopLogFile, 'utf8').length : 0;
for (const dir of [
  workspace,
  artifacts,
  join(runRoot, 'home'),
  join(runRoot, 'xdg-data', 'opencode'),
  join(workspace, '.tagma', 'baseline'),
])
  mkdirSync(dir, { recursive: true, mode: 0o700 });
const auth = JSON.parse(
  readFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8'),
) as Record<string, { type?: string }>;
const kimi = auth['kimi-for-coding'];
if (!kimi || kimi.type !== 'api')
  throw new Error('This isolated lab requires the configured Kimi For Coding API credential.');
if (!existsSync(join(runRoot, 'xdg-data', 'opencode', 'auth.json')))
  writeFileSync(
    join(runRoot, 'xdg-data', 'opencode', 'auth.json'),
    JSON.stringify({ 'kimi-for-coding': kimi }),
    { mode: 0o600 },
  );
if (!existsSync(join(workspace, '.tagma', 'baseline', 'baseline.yaml')))
  writeFileSync(
    join(workspace, '.tagma', 'baseline', 'baseline.yaml'),
    'pipeline:\n  name: Control API baseline\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: baseline\n          name: Baseline\n          command: echo baseline\n',
    'utf8',
  );
const manifest = JSON.parse(
  readFileSync(join(editor, '..', 'electron', 'package.json'), 'utf8'),
) as {
  tagma: { bundledOpencodeVersion: string; bundledOpencodeDbSchemaVersion: number };
};
const bundledDir = join(
  editor,
  '..',
  'electron',
  'build',
  'opencode',
  `${process.platform}-${process.arch}`,
);
if (!existsSync(join(bundledDir, 'version.txt')))
  throw new Error('Build the pinned OpenCode prerequisite first.');
const executable = join(
  editor,
  'desktop-dist',
  process.platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server',
);
if (compiled && !existsSync(executable))
  throw new Error('Build the current sidecar before using --compiled.');
const releaseDirIndex = process.argv.indexOf('--release-dir');
const releaseDir =
  releaseDirIndex < 0
    ? join(root, 'apps', 'electron', 'release')
    : resolve(process.argv[releaseDirIndex + 1]!);
if (!releaseDir.startsWith(join(root, 'apps', 'electron', 'release')))
  throw new Error('Expected a repository Release artifact.');
const desktopExecutableIndex = process.argv.indexOf('--desktop-executable');
const explicitDesktopExecutable =
  desktopExecutableIndex < 0 ? null : process.argv[desktopExecutableIndex + 1];
if (desktopExecutableIndex >= 0 && (!explicitDesktopExecutable || desktop !== 'release'))
  throw new Error('--desktop-executable requires a Release QA executable.');
const desktopExecutable =
  desktop === 'release'
    ? resolve(releaseDir, explicitDesktopExecutable ?? join('win-unpacked', 'Tagma.exe'))
    : join(root, 'apps', 'electron', 'node_modules', 'electron', 'dist', 'electron.exe');
const desktopRelativePath = relative(releaseDir, desktopExecutable);
if (
  desktop === 'release' &&
  (desktopRelativePath === '..' ||
    desktopRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(desktopRelativePath))
)
  throw new Error('The Release QA executable must remain within --release-dir.');
if (desktop && !existsSync(desktopExecutable))
  throw new Error('Build the desktop prerequisite first.');
const command = desktop
  ? [
      desktopExecutable,
      ...(desktop === 'debug' ? [join(root, 'apps', 'electron')] : []),
      '--remote-debugging-port=0',
    ]
  : compiled
    ? [executable]
    : [process.execPath, join(editor, 'server', 'index.ts')];
const child = (() => {
  try {
    return Bun.spawn(command, {
      cwd: editor,
      env: {
        ...process.env,
        USERPROFILE: join(runRoot, 'home'),
        ELECTRON_RUN_AS_NODE: undefined,
        TAGMA_DESKTOP_USER_DATA_DIR: desktop ? profile : undefined,
        TAGMA_DESKTOP_RENDERER_URL: undefined,
        TAGMA_DESKTOP_HMR: '0',
        HOST: '127.0.0.1',
        PORT: resume ? new URL(resume.origin).port : '0',
        TAGMA_AUTH_TOKEN: '',
        TAGMA_GLOBAL_SETTINGS_DIR: join(runRoot, 'global-settings'),
        TAGMA_CHAT_CONTROL_DIR: join(runRoot, 'control'),
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '2',
        TAGMA_EDITOR_DIST_DIR: join(editor, 'dist'),
        TAGMA_EDITOR_USER_DIST_DIR: '',
        TAGMA_OPENCODE_BUNDLED_DIR: bundledDir,
        TAGMA_OPENCODE_BUNDLED_VERSION: manifest.tagma.bundledOpencodeVersion,
        TAGMA_OPENCODE_SKIP_USER_DIR: '1',
        TAGMA_OPENCODE_DB_STATE_DIR: join(runRoot, 'database-state'),
        TAGMA_OPENCODE_DB_SCHEMA_VERSION: String(manifest.tagma.bundledOpencodeDbSchemaVersion),
        XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
        XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
        XDG_DATA_HOME: join(runRoot, 'xdg-data'),
        XDG_STATE_HOME: join(runRoot, 'xdg-state'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    if (!runRoot.startsWith(join(tmpdir(), 'tagma-chat-control-lab-')))
      throw new Error('Unexpected isolated lab path.');
    if (!resume) rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
})();
let logs = '';
let desktopLogs = '';
let announced = false;
const publishReady = () => {
  const ready = /TAGMA_READY port=(\d+)/.exec(desktop ? desktopLogs : logs);
  const cdp = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(logs);
  if (!ready || announced || (desktop && !cdp)) return;
  announced = true;
  const origin = `http://127.0.0.1:${ready[1]}`;
  const metadata = {
    mode: desktop ? `desktop-${desktop}` : compiled ? 'compiled' : 'source',
    runRoot,
    workspace,
    artifacts,
    origin,
    url: `${origin}/?ws=${encodeURIComponent(workspace)}`,
    pid: process.pid,
    ...(desktop
      ? { desktopPid: child.pid, desktopExecutable, profile, cdp: `http://127.0.0.1:${cdp![1]}` }
      : { sidecarPid: child.pid }),
    provider: 'kimi-for-coding',
  };
  writeFileSync(join(artifacts, 'lab.json'), JSON.stringify(metadata, null, 2), 'utf8');
  console.log(JSON.stringify(metadata));
};
const desktopPoll = desktop
  ? setInterval(() => {
      const file = desktopLogFile;
      if (!existsSync(file)) return;
      desktopLogs = readFileSync(file, 'utf8')
        .slice(desktopLogOffset)
        .slice(-2 * 1024 * 1024);
      writeFileSync(join(artifacts, 'sidecar.log'), desktopLogs);
      publishReady();
    }, 500)
  : null;
const drain = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    logs = (logs + text).slice(-2 * 1024 * 1024);
    writeFileSync(join(artifacts, desktop ? 'desktop.log' : 'sidecar.log'), logs, 'utf8');
    publishReady();
  }
};
const streams = Promise.all([drain(child.stdout), drain(child.stderr)]);
const stop = () => {
  if (child.exitCode === null) forceStopProcessTree(child);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const code = await child.exited;
if (desktopPoll) clearInterval(desktopPoll);
await streams;
console.log(JSON.stringify({ stopped: true, code, runRoot, artifacts }));
process.exitCode = code;
