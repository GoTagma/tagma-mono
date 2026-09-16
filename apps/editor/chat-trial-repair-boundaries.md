# Chat Trial repair boundaries

## Coordinate contract

| Surface                                              | Base and mapping                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Command, built-in trigger/completion, static context | Effective task cwd: `task.cwd ?? track.cwd ?? workspaceRoot`.                     |
| Trial fixtures and generated-input paths             | Isolated case project root, with `<stem>/...` mapped to `.tagma/<stem>/...`.      |
| Trial file/JSON assertions                           | The same case-root mapping as fixture writes.                                     |
| Repeated-output freshness                            | The same `casePath` resolution as assertions, captured before and after each run. |

For a task running in `.tagma/report`, runtime `结果 目录/校验.json` is Trial
`report/结果 目录/校验.json`. Bare `结果 目录/校验.json` refers to a different
case-root location. No layer probes file existence to guess an alternative base.

The plan validator catches known trigger, completion, static-context, and input-binding
coordinate mismatches. It cannot statically infer every path hidden in arbitrary scripts.
The planner must inspect the actual input/output contract, including upstream rewrites of fixtures.

## Repair authority

Previously, a failed file assertion or unexpectedly successful negative case could directly grant
`pipeline-change-allowed`, even when business tasks succeeded. That allowed a bad coordinate or
an unused negative fixture to redirect business implementation.

The Host now routes assertion-only failed cases to the existing bounded `trial_plan` invocation.
It preserves executed evidence, authenticates a fresh attempt against the same YAML hash, and
grants no business repair authority. Exhaustion retains the draft as diagnostic-only. The planner
may correct the plan or report an independently evidenced business-contract finding; the failed
assertion itself is not that evidence. An actual unexpected task failure still follows ordinary
repair routing. Successful expected negative cases remain successful. Mixed evidence requiring
plan review is resolved before permitting business changes.

Publication still requires successful verification. Trial cache protocol 32 rejects earlier cached
repair decisions; no persisted YAML or public expectation shape changes.

JSON Pointer addresses array elements by numeric index, not JavaScript properties. `/length` and
`/items/length` on arrays are failed plan diagnostics; an object's own `length` field remains valid.
Use a whole-array equality assertion when the complete expected array is known.

Plan review also respects evidence authority: assertion-reader limits remain diagnostic-only and
do not invoke planning. Host-authored freshness probes remain ordinary verification evidence;
an unchanged file after a marked run is not an ambiguous authored assertion. A separate failing
authored path/content assertion still requires review, including when a bad coordinate also makes
freshness fail. Invalid array indexes carry typed `planError` evidence so they can request plan
correction without treating every diagnostic-only failure as actionable.

## Other confirmed defects

- Requirements tokenization recognized `if` only as a complete whitespace-separated word.
  It now recognizes control words followed immediately by `(` or `{`, keeping condition operands
  out of executable discovery. Quoted script arguments remain opaque, multiline scripts retain
  the existing opaque policy, and explicit `argv[0]` does not receive shell-language filtering.
- Prompt output inference treated a downstream `task.normalizedOutput` reference as an inferred
  JSON key. Raw `stdout`, `stderr`, `normalizedOutput`, and `exitCode` references now follow the
  input resolver's semantics. Explicit `.outputs.<name>` continues to require that named output;
  missing keys, invalid JSON/type values, and capture failures still fail normally.

## Verification and limits

Regression coverage includes real isolated Bun task execution for pipeline-local Unicode outputs,
case-root commands consuming pipeline-local inputs, ineffective and effective USD fixtures,
repeated-output freshness, plan exhaustion, and genuine task failure. Core and SDK tests exercise
raw output inference and downstream delivery with deterministic driver responses. These are not
real Kimi end-to-end validation.

The initial repair's focused editor verification passed 292 tests across Trial, Host lifecycle, requirements,
and publication suites. Public builds passed; public-package tests passed 606 cases and failed
two unchanged `runtime-bun/src/stdin-cancellation.test.ts` timing checks. Isolated repetition
still measured about 3.0 seconds against a 2.5-second deadline; that runtime issue was not changed.
The 10 non-test `verify:quick` gates passed, including full type/lint/dependency checks. CI for the
starting commit `0ccf4a2de8ca38b5f701d8da3aeef266dcb07d0b` was green; this does not establish CI status
for the repair commit.

Two existing Windows test harness assumptions were corrected without weakening their assertions:
complete CMD verification commands use verbatim command-line quoting, and publication fixtures
write exact bytes through Bun argv instead of POSIX redirection with different PowerShell encoding.

The original reported inline Windows command, provider response payload, and interaction timings
were not captured during this repair. No executor quoting change, provider error reclassification,
automatic provider retry, or interaction/performance optimization is justified by those reports
alone. Live verification requires new authorization; no old diagnostic/control token is used.

## CI follow-up: 2026-09-16

CI run `35051842463` on `7d1b3aa4` exposed four failures in two additional editor suites.
All four reproduced locally before this follow-up. The plan-review predicate was too broad:
it requested planning for diagnostic reader limits and for Host-authored freshness failures.
It now checks repair scope and evidence kind, with a fixed typed discriminator for invalid
JSON array pointers. Cache version 32 invalidates decisions from the broader predicate.

The duplicate-file and malformed-JSON route tests also still expected the old immediate business
repair state. They now assert the bounded plan-review request and exhausted-budget draft retention,
while preserving their failing artifact checks, strict JSON parsing, positive decoded-value case,
and workspace isolation assertions. Freshness and reader-limit tests retain their original verdicts.

The complete local editor run exercised 326 test files: 3,070 passed, five skipped, and two
additional Windows test-budget failures surfaced. The timeout-order test's 2s lifecycle budget
was shorter than the runner's 3s SIGKILL escalation grace; its lifecycle budget is now 8s (still
below the child's 10s natural lifetime), its task deadline remains 25ms, and it additionally
requires Sandbox case execution. The managed-tools fixture completed all 20 assertions but
exceeded Bun's default 5s test limit while copying dependencies and loading tools; it now has
an explicit 30s integration-test budget. Neither change alters product runtime timeouts.
Both affected test files were then rerun in full: all 12 tests passed. The four failures from
the supplied CI log also passed after the repair.

Server/test type checks, lint, formatting, source hygiene, import/cycle checks, and script tests
passed. Workspace/lock metadata comparison passed, but the frozen-install dependency gate could
not finish: registry connections closed while resolving `js-yaml` and `chokidar`, including on
retry. No dependency, registry, proxy, or credential setting was changed.
