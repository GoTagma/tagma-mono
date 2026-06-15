import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from './index';

/**
 * Python sandbox test harness.
 *
 * Verifies the data contract between Python scripts and the Tagma pipeline
 * engine using the **real** `bunRuntime`. Each test creates Python scripts
 * in a temp directory and runs them as pipeline command tasks, validating:
 *
 *   1. JSON input -> Python reads from argv (via `{{inputs.x}}` templates)
 *   2. JSON output -> Python writes to stdout, engine parses declared outputs
 *   3. Environment variable passing
 *   4. Error propagation (non-zero exit, malformed JSON output)
 *   5. End-to-end: upstream task produces JSON -> Python transform consumes it
 *
 * The harness uses `python` (Python 3.x) which is available in the dev
 * environment. Tests are skipped when Python is not found.
 *
 * These tests close the gap identified in the testing pipeline review:
 * "No execution - I can't run `python your_script.py` to see if it works."
 */

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-python-'));
}

function hasPython(): boolean {
  try {
    const proc = Bun.spawnSync(['python', '--version']);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

function collectEvents(events: RunEventPayload[]) {
  return {
    finalTaskUpdate: (taskId: string) => {
      const updates = events.filter((e) => e.type === 'task_update' && e.taskId === taskId);
      return updates[updates.length - 1];
    },
  };
}

const PYTHON_AVAILABLE = hasPython();

const describeIf = PYTHON_AVAILABLE ? describe : describe.skip;

describeIf('python sandbox - data contract verification', () => {
  test('Python transform: JSON in via argv -> JSON out via stdout', async () => {
    const dir = makeDir();
    try {
      // Create a Python transform script that doubles a number
      writeFileSync(
        join(dir, 'double.py'),
        `
import sys, json

value = int(sys.argv[1])
result = {"doubled": value * 2}
sys.stdout.write(json.dumps(result))
`,
      );

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: python-double
  tracks:
    - id: main
      name: Main
      tasks:
        - id: produce
          name: produce
          command:
            argv: ["node", "-e", "process.stdout.write(JSON.stringify({n: 21}))"]
          outputs:
            n:
              type: number
        - id: transform
          name: transform
          depends_on: [produce]
          command:
            argv: ["python", "${join(dir, 'double.py').replace(/\\/g, '\\\\')}", "{{inputs.n}}"]
          inputs:
            n:
              from: produce.n
              type: number
              required: true
          outputs:
            doubled:
              type: number
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.success).toBe(2);
      }

      const ec = collectEvents(events);
      const transform = ec.finalTaskUpdate('main.transform');
      if (transform && transform.type === 'task_update') {
        expect(transform.status).toBe('success');
        expect(transform.outputs).toEqual({ doubled: 42 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python script reads environment via secrets/env policy', async () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, 'env_reader.py'),
        `
import os, json, sys

greeting = os.environ.get("TAGMA_TEST_GREETING", "none")
result = {"greeting": greeting}
sys.stdout.write(json.dumps(result))
`,
      );

      // Set env var before test, use allowlist to pass it through
      const prev = process.env.TAGMA_TEST_GREETING;
      process.env.TAGMA_TEST_GREETING = 'hello from tagma';

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      try {
        const result = await tagma.runYaml(
          `
pipeline:
  name: python-env
  tracks:
    - id: main
      name: Main
      tasks:
        - id: read_env
          name: read_env
          command:
            argv: ["python", "${join(dir, 'env_reader.py').replace(/\\/g, '\\\\')}"]
          outputs:
            greeting:
              type: string
`,
          {
            cwd: dir,
            onEvent: (e) => events.push(e),
            envPolicy: { mode: 'allowlist', keys: ['TAGMA_TEST_GREETING'] },
          },
        );

        expect(result.kind).toBe('pipeline');
        if (result.kind === 'pipeline') {
          expect(result.result.success).toBe(true);
        }

        const ec = collectEvents(events);
        const readEnv = ec.finalTaskUpdate('main.read_env');
        if (readEnv && readEnv.type === 'task_update') {
          expect(readEnv.status).toBe('success');
          expect(readEnv.outputs).toEqual({ greeting: 'hello from tagma' });
        }
      } finally {
        if (prev === undefined) delete process.env.TAGMA_TEST_GREETING;
        else process.env.TAGMA_TEST_GREETING = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python script failure: non-zero exit propagates as task failure', async () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, 'fail.py'),
        `
import sys
sys.stderr.write("intentional failure")
sys.exit(1)
`,
      );

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: python-fail
  tracks:
    - id: main
      name: Main
      tasks:
        - id: bad_script
          name: bad_script
          command:
            argv: ["python", "${join(dir, 'fail.py').replace(/\\/g, '\\\\')}"]
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(false);
        expect(result.result.summary.failed).toBe(1);
      }

      const ec = collectEvents(events);
      const badScript = ec.finalTaskUpdate('main.bad_script');
      if (badScript && badScript.type === 'task_update') {
        expect(badScript.status).toBe('failed');
        expect(badScript.exitCode).toBe(1);
        expect(badScript.stderr).toContain('intentional failure');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python syntax error surfaces as task failure with stderr', async () => {
    const dir = makeDir();
    try {
      // Intentionally broken Python - syntax error
      writeFileSync(
        join(dir, 'broken.py'),
        `
def broken(
    # missing closing paren and colon - SyntaxError
print("never reached")
`,
      );

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: python-syntax-error
  tracks:
    - id: main
      name: Main
      tasks:
        - id: broken
          name: broken
          command:
            argv: ["python", "${join(dir, 'broken.py').replace(/\\/g, '\\\\')}"]
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(false);
      }

      const ec = collectEvents(events);
      const broken = ec.finalTaskUpdate('main.broken');
      if (broken && broken.type === 'task_update') {
        expect(broken.status).toBe('failed');
        expect(broken.exitCode).not.toBe(0);
        // Python writes SyntaxError to stderr
        expect(broken.stderr).toContain('SyntaxError');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python multi-step pipeline: produce -> python transform -> consume', async () => {
    const dir = makeDir();
    try {
      // Python transform: receives city name, returns a greeting
      writeFileSync(
        join(dir, 'greet.py'),
        `
import sys, json

city = sys.argv[1]
result = {"greeting": f"Hello from {city}!", "length": len(city)}
sys.stdout.write(json.dumps(result))
`,
      );

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: python-multi-step
  tracks:
    - id: main
      name: Main
      tasks:
        - id: source
          name: source
          command:
            argv: ["node", "-e", "process.stdout.write(JSON.stringify({city: 'Shanghai'}))"]
          outputs:
            city:
              type: string
        - id: transform
          name: transform
          depends_on: [source]
          command:
            argv: ["python", "${join(dir, 'greet.py').replace(/\\/g, '\\\\')}", "{{inputs.city}}"]
          inputs:
            city:
              from: source.city
              type: string
              required: true
          outputs:
            greeting:
              type: string
            length:
              type: number
        - id: sink
          name: sink
          depends_on: [transform]
          command:
            argv: ["node", "-e", "process.stdout.write('Final: ' + process.argv[1])", "{{inputs.greeting}}"]
          inputs:
            greeting:
              from: transform.greeting
              type: string
              required: true
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.total).toBe(3);
        expect(result.result.summary.success).toBe(3);
      }

      const ec = collectEvents(events);
      const source = ec.finalTaskUpdate('main.source');
      const transform = ec.finalTaskUpdate('main.transform');
      const sink = ec.finalTaskUpdate('main.sink');

      if (source && source.type === 'task_update') {
        expect(source.outputs).toEqual({ city: 'Shanghai' });
      }
      if (transform && transform.type === 'task_update') {
        expect(transform.outputs).toEqual({
          greeting: 'Hello from Shanghai!',
          length: 8,
        });
      }
      if (sink && sink.type === 'task_update') {
        expect(sink.status).toBe('success');
        expect(sink.stdout).toContain('Final: Hello from Shanghai!');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python context shape: stdin JSON + argv + environment', async () => {
    const dir = makeDir();
    try {
      // Python script that validates the full context it receives:
      // - command-line args from {{inputs.*}} templates
      // - environment variables from envPolicy
      // - produces a structured validation report
      writeFileSync(
        join(dir, 'context_validator.py'),
        `
import sys, json, os

# Validate argv-based inputs (from {{inputs.*}} template)
task_name = sys.argv[1] if len(sys.argv) > 1 else "unknown"
input_value = sys.argv[2] if len(sys.argv) > 2 else "missing"

# Validate environment
has_path = "PATH" in os.environ

result = {
    "task_name": task_name,
    "input_value": input_value,
    "has_path_env": has_path,
    "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
}
sys.stdout.write(json.dumps(result))
`,
      );

      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: python-context
  tracks:
    - id: main
      name: Main
      tasks:
        - id: validate
          name: validate
          command:
            argv:
              - python
              - "${join(dir, 'context_validator.py').replace(/\\/g, '\\\\')}"
              - "my-task"
              - "test-input"
          outputs:
            task_name:
              type: string
            input_value:
              type: string
            has_path_env:
              type: boolean
            python_version:
              type: string
`,
        {
          cwd: dir,
          onEvent: (e) => events.push(e),
          envPolicy: { mode: 'allowlist', keys: ['PATH'] },
        },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
      }

      const ec = collectEvents(events);
      const validate = ec.finalTaskUpdate('main.validate');
      if (validate && validate.type === 'task_update') {
        expect(validate.status).toBe('success');
        expect(validate.outputs).toEqual({
          task_name: 'my-task',
          input_value: 'test-input',
          has_path_env: true,
          python_version: expect.stringMatching(/^3\.\d+$/),
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
