import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  forceStopProcessTree,
  runIsolatedChatV2AgentLoop,
  type ChatV2AgentLoopScenario,
  type IsolatedChatV2AgentLoopReport,
  type RunIsolatedChatV2AgentLoopOptions,
} from './chat-v2-agent-loop.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(scriptDirectory, '..');
const DEFAULT_SCENARIOS = Object.freeze([
  'clarification',
  'discussion',
  'authoring-trial',
] as const satisfies readonly ChatV2AgentLoopScenario[]);
const SUPPORTED_SCENARIOS = new Set<ChatV2AgentLoopScenario>([
  'clarification',
  'discussion',
  'authoring-trial',
]);
const MAX_LOG_BYTES = 512 * 1024;

export type ChatV2AgentCyclePhase =
  'source_matrix' | 'compiled_build' | 'compiled_matrix' | 'cleanup';

export interface ChatV2AgentCycleOptions {
  readonly artifactsParentDirectory?: string;
  readonly scenarios?: readonly ChatV2AgentLoopScenario[];
  readonly stabilityRuns?: number;
  readonly timeoutMs?: number;
  readonly keepRuntime?: boolean;
}

export interface ChatV2AgentCycleCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface ChatV2AgentCycleBuildResult {
  readonly executablePath: string;
  readonly sha256: string;
  readonly output: string;
}

export interface ChatV2AgentCycleDependencies {
  readonly buildCompiledSidecar: (input: {
    readonly buildDirectory: string;
    readonly artifactsDirectory: string;
    readonly timeoutMs: number;
  }) => Promise<ChatV2AgentCycleBuildResult>;
  readonly runScenario: (
    input: RunIsolatedChatV2AgentLoopOptions & {
      readonly scenario: ChatV2AgentLoopScenario;
    },
  ) => Promise<IsolatedChatV2AgentLoopReport>;
  readonly cleanupBuildDirectory: (input: { readonly buildDirectory: string }) => Promise<void>;
}

export interface ChatV2AgentCycleFailure {
  readonly phase: ChatV2AgentCyclePhase;
  readonly mode: 'source' | 'compiled' | null;
  readonly scenario: ChatV2AgentLoopScenario | null;
  readonly stabilityRun: number | null;
  readonly name: string;
  readonly message: string;
  readonly fingerprint: string;
  readonly reportPath: string | null;
}

export interface ChatV2AgentCycleReport {
  readonly schemaVersion: 1;
  readonly cycleId: string;
  readonly verdict: 'passed' | 'failed';
  readonly nextAction: 'verified' | 'repair_required' | 'investigate_instability';
  readonly startedAt: number;
  readonly completedAt: number;
  readonly stabilityRuns: number;
  readonly scenarios: readonly ChatV2AgentLoopScenario[];
  readonly build: {
    readonly verdict: 'passed' | 'failed';
    readonly sha256: string | null;
    readonly logPath: string;
  } | null;
  readonly runs: readonly {
    readonly mode: 'source' | 'compiled';
    readonly stabilityRun: number;
    readonly purpose: 'stability' | 'confirmation';
    readonly scenario: ChatV2AgentLoopScenario;
    readonly verdict: 'passed' | 'failed';
    readonly terminalOutcome: string | null;
    readonly reportPath: string | null;
  }[];
  readonly confirmation: {
    readonly verdict: 'confirmed' | 'not_reproduced' | 'divergent';
    readonly mode: 'source' | 'compiled';
    readonly scenario: ChatV2AgentLoopScenario;
    readonly initialFingerprint: string;
    readonly confirmationFingerprint: string | null;
    readonly reportPath: string | null;
  } | null;
  readonly cleanup: {
    readonly verdict: 'passed' | 'failed';
    readonly message: string | null;
  };
  readonly failure: ChatV2AgentCycleFailure | null;
  readonly artifactsDirectory: string;
  readonly reportPath: string;
}

function boundedLog(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= MAX_LOG_BYTES) return value;
  const suffix = Buffer.from('\n[agent-cycle log clipped]\n', 'utf8');
  return Buffer.concat([bytes.subarray(0, MAX_LOG_BYTES - suffix.byteLength), suffix]).toString(
    'utf8',
  );
}

export async function drainBoundedCommandStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_LOG_BYTES,
): Promise<{ text: string; clipped: boolean; totalBytes: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Command stream byte bound must be a positive integer.');
  }
  const reader = stream.getReader();
  const retained: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      const remaining = maxBytes - retainedBytes;
      if (remaining > 0) {
        const chunk = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        retained.push(Uint8Array.from(chunk));
        retainedBytes += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(retained.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    clipped: totalBytes > retainedBytes,
    totalBytes,
  };
}

function safeError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
  };
}

function failureFingerprint(input: {
  readonly phase: ChatV2AgentCyclePhase;
  readonly mode: 'source' | 'compiled' | null;
  readonly scenario: ChatV2AgentLoopScenario | null;
  readonly name: string;
  readonly lastPhase?: string | null;
  readonly waitReason?: string | null;
  readonly terminalOutcome?: string | null;
  readonly detail?: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        phase: input.phase,
        mode: input.mode,
        scenario: input.scenario,
        name: input.name,
        lastPhase: input.lastPhase ?? null,
        waitReason: input.waitReason ?? null,
        terminalOutcome: input.terminalOutcome ?? null,
        detail: stableFailureDetail(input.detail ?? null),
      }),
    )
    .digest('hex');
}

function stableFailureDetail(value: string | null): string | null {
  if (value === null) return null;
  return value
    .normalize('NFC')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '[uuid]')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/giu, '[loopback]')
    .replace(/[A-Za-z]:[\\/][^\r\n"']+/gu, '[path]')
    .replace(/\b\d+\b/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_024);
}

function modeForPhase(phase: ChatV2AgentCyclePhase): 'source' | 'compiled' | null {
  if (phase === 'source_matrix') return 'source';
  if (phase === 'compiled_build' || phase === 'compiled_matrix') return 'compiled';
  return null;
}

function validateOptions(options: ChatV2AgentCycleOptions): {
  stabilityRuns: number;
  timeoutMs: number;
  scenarios: readonly ChatV2AgentLoopScenario[];
} {
  const stabilityRuns = options.stabilityRuns ?? 2;
  if (!Number.isSafeInteger(stabilityRuns) || stabilityRuns < 2 || stabilityRuns > 5) {
    throw new TypeError('stabilityRuns must be an integer from 2 to 5.');
  }
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) {
    throw new TypeError('timeoutMs must be an integer from 30000 to 900000.');
  }
  const scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
  if (scenarios.length === 0 || scenarios.length > SUPPORTED_SCENARIOS.size) {
    throw new TypeError('Agent cycle scenarios must be a non-empty bounded set.');
  }
  const unique = new Set<ChatV2AgentLoopScenario>();
  for (const scenario of scenarios) {
    if (!SUPPORTED_SCENARIOS.has(scenario) || unique.has(scenario)) {
      throw new TypeError('Agent cycle scenarios must be unique supported scenario ids.');
    }
    unique.add(scenario);
  }
  return { stabilityRuns, timeoutMs, scenarios: Object.freeze([...scenarios]) };
}

async function runCommand(input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs: number;
}): Promise<ChatV2AgentCycleCommandResult> {
  const child = Bun.spawn([...input.command], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    forceStopProcessTree(child);
  }, input.timeoutMs);
  let stdout: Awaited<ReturnType<typeof drainBoundedCommandStream>>;
  let stderr: Awaited<ReturnType<typeof drainBoundedCommandStream>>;
  let exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      drainBoundedCommandStream(child.stdout as ReadableStream<Uint8Array>, MAX_LOG_BYTES / 2),
      drainBoundedCommandStream(child.stderr as ReadableStream<Uint8Array>, MAX_LOG_BYTES / 2),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const clipping = [
    ...(stdout.clipped ? [`stdout clipped after ${stdout.totalBytes} bytes`] : []),
    ...(stderr.clipped ? [`stderr clipped after ${stderr.totalBytes} bytes`] : []),
    ...(timedOut ? [`command timed out after ${input.timeoutMs}ms`] : []),
  ];
  return {
    exitCode: timedOut ? 124 : exitCode,
    output: boundedLog(
      `${stdout.text}${stderr.text}${clipping.length > 0 ? `\n[${clipping.join('; ')}]\n` : ''}`,
    ),
  };
}

const productionDependencies: ChatV2AgentCycleDependencies = {
  buildCompiledSidecar: async ({ buildDirectory, timeoutMs }) => {
    const result = await runCommand({
      command: [process.execPath, 'run', 'build:sidecar'],
      cwd: editorRoot,
      env: { ...process.env, TAGMA_SIDECAR_OUTDIR: buildDirectory },
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`Compiled sidecar build exited ${result.exitCode}.`), {
        output: result.output,
      });
    }
    const executablePath = join(
      buildDirectory,
      process.platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server',
    );
    if (!existsSync(executablePath)) {
      throw Object.assign(new Error('Compiled sidecar build produced no executable.'), {
        output: result.output,
      });
    }
    return {
      executablePath,
      sha256: createHash('sha256').update(readFileSync(executablePath)).digest('hex'),
      output: result.output,
    };
  },
  runScenario: (input) => runIsolatedChatV2AgentLoop(input),
  cleanupBuildDirectory: async ({ buildDirectory }) => {
    rmSync(buildDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  },
};

function scenarioFailure(input: {
  phase: 'source_matrix' | 'compiled_matrix';
  mode: 'source' | 'compiled';
  stabilityRun: number;
  report: IsolatedChatV2AgentLoopReport;
}): ChatV2AgentCycleFailure {
  const error = input.report.failure ?? {
    name: 'ScenarioFailure',
    message: 'Scenario failed without bounded failure evidence.',
  };
  return {
    phase: input.phase,
    mode: input.mode,
    scenario: input.report.scenario,
    stabilityRun: input.stabilityRun,
    name: error.name,
    message: error.message,
    fingerprint: failureFingerprint({
      phase: input.phase,
      mode: input.mode,
      scenario: input.report.scenario,
      name: error.name,
      lastPhase: input.report.lastOperation?.phase,
      waitReason: input.report.lastOperation?.waitReason,
      terminalOutcome:
        input.report.lastOperation?.terminalOutcome ?? input.report.operation?.terminalOutcome,
      detail: error.message,
    }),
    reportPath: input.report.reportPath,
  };
}

function realProviderRequiredFailure(input: {
  phase: 'source_matrix' | 'compiled_matrix';
  mode: 'source' | 'compiled';
  stabilityRun: number;
  report: IsolatedChatV2AgentLoopReport;
}): ChatV2AgentCycleFailure | null {
  if (input.report.provider.mode === 'real') return null;
  const name = 'RealProviderRequired';
  const message = 'Chat V2 convergence cannot be verified by a fake provider scenario.';
  return {
    phase: input.phase,
    mode: input.mode,
    scenario: input.report.scenario,
    stabilityRun: input.stabilityRun,
    name,
    message,
    fingerprint: failureFingerprint({
      phase: input.phase,
      mode: input.mode,
      scenario: input.report.scenario,
      name,
      lastPhase: input.report.lastOperation?.phase,
      waitReason: input.report.lastOperation?.waitReason,
      terminalOutcome:
        input.report.lastOperation?.terminalOutcome ?? input.report.operation?.terminalOutcome,
      detail: message,
    }),
    reportPath: input.report.reportPath,
  };
}

export async function runChatV2AgentCycle(
  options: ChatV2AgentCycleOptions = {},
  dependencies: ChatV2AgentCycleDependencies = productionDependencies,
): Promise<ChatV2AgentCycleReport> {
  const validated = validateOptions(options);
  const cycleId = randomUUID();
  const startedAt = Date.now();
  const artifactsParentDirectory = options.artifactsParentDirectory ?? tmpdir();
  mkdirSync(artifactsParentDirectory, { recursive: true });
  const artifactsDirectory = mkdtempSync(
    join(artifactsParentDirectory, 'tagma-chat-v2-agent-cycle-'),
  );
  const reportPath = join(artifactsDirectory, 'cycle-report.json');
  const buildLogPath = join(artifactsDirectory, 'compiled-build.log');
  const buildDirectory = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-cycle-build-'));
  const runs: ChatV2AgentCycleReport['runs'][number][] = [];
  let build: ChatV2AgentCycleReport['build'] = null;
  let failure: ChatV2AgentCycleFailure | null = null;
  let confirmation: ChatV2AgentCycleReport['confirmation'] = null;
  let cleanup: ChatV2AgentCycleReport['cleanup'] = { verdict: 'passed', message: null };
  let currentPhase: ChatV2AgentCyclePhase = 'source_matrix';

  const writeReport = (): ChatV2AgentCycleReport => {
    const nextAction: ChatV2AgentCycleReport['nextAction'] = !failure
      ? 'verified'
      : cleanup.verdict === 'failed' ||
          confirmation === null ||
          confirmation.verdict === 'confirmed'
        ? 'repair_required'
        : 'investigate_instability';
    const report: ChatV2AgentCycleReport = {
      schemaVersion: 1,
      cycleId,
      verdict: failure ? 'failed' : 'passed',
      nextAction,
      startedAt,
      completedAt: Date.now(),
      stabilityRuns: validated.stabilityRuns,
      scenarios: validated.scenarios,
      build,
      runs: Object.freeze([...runs]),
      confirmation,
      cleanup,
      failure,
      artifactsDirectory,
      reportPath,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  };

  const runMatrix = async (
    mode: 'source' | 'compiled',
    sidecarExecutable: string | undefined,
  ): Promise<ChatV2AgentCycleFailure | null> => {
    for (let stabilityRun = 1; stabilityRun <= validated.stabilityRuns; stabilityRun += 1) {
      for (const scenario of validated.scenarios) {
        let report: IsolatedChatV2AgentLoopReport;
        try {
          report = await dependencies.runScenario({
            scenario,
            providerMode: 'real',
            timeoutMs: validated.timeoutMs,
            artifactsParentDirectory: artifactsDirectory,
            keepRuntime: options.keepRuntime,
            ...(sidecarExecutable ? { sidecarExecutable } : {}),
          });
        } catch (error) {
          const value = safeError(error);
          const phase = mode === 'source' ? 'source_matrix' : 'compiled_matrix';
          runs.push({
            mode,
            stabilityRun,
            purpose: 'stability',
            scenario,
            verdict: 'failed',
            terminalOutcome: null,
            reportPath: null,
          });
          return {
            phase,
            mode,
            scenario,
            stabilityRun,
            ...value,
            fingerprint: failureFingerprint({
              phase,
              mode,
              scenario,
              name: value.name,
              detail: value.message,
            }),
            reportPath: null,
          };
        }
        const phase = mode === 'source' ? 'source_matrix' : 'compiled_matrix';
        const providerFailure = realProviderRequiredFailure({
          phase,
          mode,
          stabilityRun,
          report,
        });
        runs.push({
          mode,
          stabilityRun,
          purpose: 'stability',
          scenario,
          verdict: providerFailure ? 'failed' : report.verdict,
          terminalOutcome: report.operation?.terminalOutcome ?? null,
          reportPath: report.reportPath,
        });
        if (providerFailure) return providerFailure;
        if (report.verdict === 'failed') {
          return scenarioFailure({
            phase: mode === 'source' ? 'source_matrix' : 'compiled_matrix',
            mode,
            stabilityRun,
            report,
          });
        }
      }
    }
    return null;
  };

  const confirmScenarioFailure = async (
    initial: ChatV2AgentCycleFailure,
    sidecarExecutable: string | undefined,
  ): Promise<ChatV2AgentCycleReport['confirmation']> => {
    if (!initial.mode || !initial.scenario || initial.stabilityRun === null) return null;
    let report: IsolatedChatV2AgentLoopReport | null = null;
    let confirmedFailure: ChatV2AgentCycleFailure;
    try {
      report = await dependencies.runScenario({
        scenario: initial.scenario,
        providerMode: 'real',
        timeoutMs: validated.timeoutMs,
        artifactsParentDirectory: artifactsDirectory,
        keepRuntime: options.keepRuntime,
        ...(sidecarExecutable ? { sidecarExecutable } : {}),
      });
      const phase = initial.mode === 'source' ? 'source_matrix' : 'compiled_matrix';
      const providerFailure = realProviderRequiredFailure({
        phase,
        mode: initial.mode,
        stabilityRun: initial.stabilityRun,
        report,
      });
      runs.push({
        mode: initial.mode,
        stabilityRun: initial.stabilityRun,
        purpose: 'confirmation',
        scenario: initial.scenario,
        verdict: providerFailure ? 'failed' : report.verdict,
        terminalOutcome: report.operation?.terminalOutcome ?? null,
        reportPath: report.reportPath,
      });
      if (providerFailure) {
        confirmedFailure = providerFailure;
      } else if (report.verdict === 'passed') {
        return {
          verdict: 'not_reproduced',
          mode: initial.mode,
          scenario: initial.scenario,
          initialFingerprint: initial.fingerprint,
          confirmationFingerprint: null,
          reportPath: report.reportPath,
        };
      } else {
        confirmedFailure = scenarioFailure({
          phase,
          mode: initial.mode,
          stabilityRun: initial.stabilityRun,
          report,
        });
      }
    } catch (error) {
      const value = safeError(error);
      const phase = initial.mode === 'source' ? 'source_matrix' : 'compiled_matrix';
      confirmedFailure = {
        phase,
        mode: initial.mode,
        scenario: initial.scenario,
        stabilityRun: initial.stabilityRun,
        ...value,
        fingerprint: failureFingerprint({
          phase,
          mode: initial.mode,
          scenario: initial.scenario,
          name: value.name,
          detail: value.message,
        }),
        reportPath: null,
      };
      runs.push({
        mode: initial.mode,
        stabilityRun: initial.stabilityRun,
        purpose: 'confirmation',
        scenario: initial.scenario,
        verdict: 'failed',
        terminalOutcome: null,
        reportPath: null,
      });
    }
    return {
      verdict: confirmedFailure.fingerprint === initial.fingerprint ? 'confirmed' : 'divergent',
      mode: initial.mode,
      scenario: initial.scenario,
      initialFingerprint: initial.fingerprint,
      confirmationFingerprint: confirmedFailure.fingerprint,
      reportPath: report?.reportPath ?? null,
    };
  };

  try {
    currentPhase = 'source_matrix';
    failure = await runMatrix('source', undefined);
    if (failure) confirmation = await confirmScenarioFailure(failure, undefined);

    let executablePath: string | null = null;
    if (!failure) {
      currentPhase = 'compiled_build';
      try {
        const buildResult = await dependencies.buildCompiledSidecar({
          buildDirectory,
          artifactsDirectory,
          timeoutMs: validated.timeoutMs,
        });
        writeFileSync(buildLogPath, boundedLog(buildResult.output), 'utf8');
        build = { verdict: 'passed', sha256: buildResult.sha256, logPath: buildLogPath };
        executablePath = buildResult.executablePath;
      } catch (error) {
        const value = safeError(error);
        const output =
          typeof (error as { output?: unknown })?.output === 'string'
            ? ((error as { output: string }).output as string)
            : value.message;
        writeFileSync(buildLogPath, boundedLog(output), 'utf8');
        build = { verdict: 'failed', sha256: null, logPath: buildLogPath };
        failure = {
          phase: 'compiled_build',
          mode: 'compiled',
          scenario: null,
          stabilityRun: null,
          ...value,
          fingerprint: failureFingerprint({
            phase: 'compiled_build',
            mode: 'compiled',
            scenario: null,
            name: value.name,
            detail: value.message,
          }),
          reportPath: null,
        };
      }
    }
    if (!failure && executablePath) {
      currentPhase = 'compiled_matrix';
      failure = await runMatrix('compiled', executablePath);
      if (failure) confirmation = await confirmScenarioFailure(failure, executablePath);
    }
  } catch (error) {
    const value = safeError(error);
    const phase = currentPhase;
    const mode = modeForPhase(phase);
    failure = {
      phase,
      mode,
      scenario: null,
      stabilityRun: null,
      ...value,
      fingerprint: failureFingerprint({
        phase,
        mode,
        scenario: null,
        name: value.name,
        detail: value.message,
      }),
      reportPath: null,
    };
  }
  try {
    await dependencies.cleanupBuildDirectory({ buildDirectory });
  } catch (error) {
    const value = safeError(error);
    cleanup = { verdict: 'failed', message: value.message };
    if (!failure) {
      failure = {
        phase: 'cleanup',
        mode: null,
        scenario: null,
        stabilityRun: null,
        ...value,
        fingerprint: failureFingerprint({
          phase: 'cleanup',
          mode: null,
          scenario: null,
          name: value.name,
          detail: value.message,
        }),
        reportPath: null,
      };
    }
  }
  return writeReport();
}

function cliValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function runCli(): Promise<void> {
  const stabilityRuns = Number(cliValue('--stability-runs') ?? '2');
  const timeoutMs = Number(cliValue('--timeout-ms') ?? '180000');
  const artifactsParentDirectory = cliValue('--artifacts') ?? undefined;
  const scenarioValue = cliValue('--scenario');
  if (scenarioValue && !SUPPORTED_SCENARIOS.has(scenarioValue as ChatV2AgentLoopScenario)) {
    throw new TypeError(`Unsupported agent-cycle scenario: ${scenarioValue}`);
  }
  const report = await runChatV2AgentCycle({
    stabilityRuns,
    timeoutMs,
    ...(artifactsParentDirectory ? { artifactsParentDirectory } : {}),
    ...(scenarioValue ? { scenarios: [scenarioValue as ChatV2AgentLoopScenario] } : {}),
    keepRuntime: process.argv.includes('--keep-runtime'),
  });
  process.stdout.write(
    `${JSON.stringify({
      verdict: report.verdict,
      nextAction: report.nextAction,
      failureFingerprint: report.failure?.fingerprint ?? null,
      reportPath: report.reportPath,
    })}\n`,
  );
  process.exitCode = report.verdict === 'passed' ? 0 : 1;
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    const failure = safeError(error);
    process.stdout.write(
      `${JSON.stringify({
        verdict: 'failed',
        nextAction: 'repair_required',
        failureFingerprint: failureFingerprint({
          phase: 'source_matrix',
          mode: 'source',
          scenario: null,
          name: failure.name,
          detail: failure.message,
        }),
        reportPath: null,
        failure,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
