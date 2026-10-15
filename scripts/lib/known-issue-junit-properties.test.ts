import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBunJunit } from '../known-issue-regressions.mjs';

test('real Bun CI metadata properties preserve exact selected JUnit execution proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-junit-ci-properties-'));
  try {
    const path = join(root, 'metadata.test.ts');
    const report = join(root, 'results.xml');
    writeFileSync(
      path,
      "import {describe,test,expect} from 'bun:test'; describe('metadata suite',()=>{test('selected proof',()=>expect(1).toBe(1));test('unselected',()=>expect(1).toBe(1));});\n",
    );
    const env: Record<string, string> = {
      CI_JOB_URL: 'https://ci.example.invalid/runs/123',
      CI_COMMIT_SHA: 'b'.repeat(40),
    };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP'])
      if (process.env[key]) env[key] = process.env[key]!;
    const child = spawnSync(
      process.execPath,
      [
        'test',
        path,
        '-t',
        '^metadata suite selected proof$',
        '--reporter=junit',
        '--reporter-outfile=' + report,
      ],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000 },
    );
    expect(child.status).toBe(0);
    const xml = readFileSync(report, 'utf8');
    expect(xml).toContain('<properties>');
    expect(xml).toContain('name="ci"');
    expect(xml).toContain('name="commit"');
    expect(parseBunJunit(xml, '^metadata suite selected proof$', 1)).toMatchObject({
      passed: true,
      matched: 1,
      executed: 1,
    });
    expect(parseBunJunit(xml, '^metadata suite unselected$', 1).passed).toBe(false);
    expect(parseBunJunit(xml, '^metadata suite missing$', 1).passed).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JUnit metadata cannot forge selected tests, counts or successful outcomes', () => {
  const property =
    '<properties><property name="ci" value="https://ci.example.invalid/?a=1&amp;b=2" /></properties>';
  const caseXml = '<testcase name="proof" />';
  const document = (body: string, counts = 'tests="1" failures="0" skipped="0"') =>
    `<testsuites ${counts}><testsuite name="file">${body}</testsuite></testsuites>`;
  expect(parseBunJunit(document(property + caseXml), '^proof$', 1).passed).toBe(true);
  for (const xml of [
    document('<properties>' + caseXml + '</properties>'),
    document('<properties><testsuite name="forged">' + caseXml + '</testsuite></properties>'),
    document('<property name="ci" value="ignored" />' + caseXml),
    document('<properties tests="999" />' + caseXml),
    document('<properties><property name="ci"><testcase name="proof" /></property></properties>'),
    document(
      property + '<testcase name="proof"><skipped /></testcase>',
      'tests="1" failures="0" skipped="1"',
    ),
    document(
      property + '<testcase name="proof"><failure /></testcase>',
      'tests="1" failures="1" skipped="0"',
    ),
    document(property + caseXml, 'tests="2" failures="0" skipped="0"'),
    '<!DOCTYPE testsuites [<!ENTITY proof "fake">]>' + document(property + caseXml),
  ])
    expect(parseBunJunit(xml, '^proof$', 1).passed).toBe(false);
});
