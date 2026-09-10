# Chat V2 audit remediation

This ledger tracks the September 10 source audit and the authorized remediation.
Numbers refer to the original reported findings. Source review distinguishes
confirmed failures from conditional risks; production incidence was not measured.

## Required fixes

| Finding                                                | Acceptance evidence                                                                                                                                                                                        | Status                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 9: idle projections refresh the disk-edit grace window | Idle/foreign wakes do not mark edits as Chat-driven; one same-operation live-to-idle transition starts one bounded window; workspace changes clear it                                                      | Fixed; targeted regression green |
| 3: automatic commit executor drops failures            | Transient filesystem faults resume the same WAL; persistent failures stop the spinner with a durable explicit retry action; retries preserve CAS, commit decision, third-party bytes, and independent jobs | Fixed; regression tests pass     |
| 5: streaming abort leaves a socket open                | Post-header abort closes the upstream connection; body cancel and ordinary completion still work                                                                                                           | Fixed; regression tests pass     |
| 8: finalize races a pending platform edit              | Finalize and abort await serialized rendering of the latest text/footer                                                                                                                                    | Fixed; regression tests pass     |
| 1: retained-draft Send is silent                       | Composer and store agree on blocked Send; draft/attachments survive with actionable feedback                                                                                                               | Fixed; regression tests pass     |
| 2: verification retry loses its outcome attachment     | Same-process and restarted verification retries seal the verified attachment in the published result and export                                                                                            | Fixed; regression tests pass     |
| 10: workspace switch leaves a false handshake error    | Disposal is silent; successful workspace bootstrap removes only stale lifecycle errors                                                                                                                     | Fixed; regression tests pass     |
| 11: workspace close retains Chat subscriptions         | Synchronous workspace reset disposes requests/EventSource and fences late callbacks                                                                                                                        | Fixed; regression tests pass     |
| 13: authoring handoff has no usable Retry              | Live handoff Retry preserves the operation and classifier decision; restart follows the documented fresh-classifier exception                                                                              | Fixed; regression tests pass     |
| 4: mutation control errors become generic 500          | Read and mutation paths map corruption/schema mismatch to reset guidance and newer schema to upgrade guidance                                                                                              | Fixed; regression tests pass     |

## Conditional risks and maintenance

- **6:** Readiness marker lacks process-generation evidence. Confirmed marker weakness;
  the current V2 Send path does not consume this marker, so the claimed full-history
  exposure is unproven. Trace the current context-limit contract before changing it.
- **7:** Do not treat the assert outside try as an orphan-process reproduction.
  Spawn immediately registers the child; restart/shutdown terminate registered children.
  A new report needs a concrete cancellation/termination-failure schedule.
- **12:** Unused full Host-event parser rejects optional Trial `feedback`. Remove or
  reconnect only with parity tests; there is no current runtime rejection on this dead path.
- **14:** Audit retention per Map. Authoring contexts/interactive waits and invocation
  result caches retain strong references; `activeSessions` already has finally cleanup.
  Preserve digest-authenticated replay when introducing bounded eviction.
- Verification Retry/Discard can race after context recovery. Recheck terminal/CAS
  authority before treating missing pending content as corruption.
- Background verification catch can erase original error classification. Preserve
  fail-closed control/authority errors rather than relabeling them as ordinary Trial outages.
- Bot turns lack a total deadline under persistent transport failures or absent terminal
  events. Ordinary EOF/error paths already settle; indefinite subscription alone is not a bug.
- Compile watcher reattachment exists when start is called again; automatic recovery
  after root deletion/recreation without that call remains to be reproduced per platform.
- Managed tool registry readiness uses one probe. Establish a pinned-runtime transient
  failure before choosing a retry policy; invalid/missing tools must still fail closed.
- Startup stderr needs streaming UTF-8 decoding and bounded drain before reporting an exit.
- OpenCode version probing lacks a timeout; update availability uses inequality rather
  than version ordering; malformed directory headers are mislabeled as upstream 502.
- Provider mutations are synchronous in-process. Concurrent HTTP requests alone cannot
  interleave their read-modify-write; cross-process/external writers need separate evidence.
- Independent OpenCode update omits the schema sentinel. Missing metadata has a
  version-isolated fallback; stale existing metadata/explicit env needs a dedicated test.
- Draft-summary clipping can split a surrogate pair and lacks omitted counts.
- Paused flow bars retain a one-second timer; unrelated projections can erase a pending
  optimistic user bubble.
- Pair-code global counters reset without pending codes. No active-code rate-limit
  bypass is demonstrated; consider the desired lifetime/DoS tradeoff before changing it.
- Slack binding intentionally has one armed intent. Multiple-window UX is a design
  limitation, not a demonstrated workspace-authorization bypass.
- Electron skew warnings omit the editor sentinel fallback; the server capability
  version fallback has an unguarded literal; unused legacy Chat helpers remain.

## Product decisions

- Managed `.tagma/opencode.json` is sanitized and rewritten. Consider preserving the
  authored source while generating a restricted runtime copy; do not weaken isolation.
- Thrown Trial failures discard while some structured failures retain the draft.
  Separate transient infrastructure failure from invalid snapshot/authority evidence.
- Session-create transport failure does not prove that creation never occurred.
  Retain conservative replay rules unless stronger admission evidence is available.
- Bot live-workspace authoring is an explicit trust-model choice distinct from Desktop V2.
- Composer text carries across workspaces while attachments clear; choose a consistent
  workspace-scoped draft policy.
- Electron dev and direct server dev apply different protocol-declaration gates.

## Verification baseline

The audit ran 89 authoring/routes/loopback/bot-renderer tests and 6 process restart
tests successfully. Additional in-memory experiments reproduced findings 1, 2, 3,
5, 8, 9, 10, and the workspace reset gap in 11. These were audit evidence, not
permanent regression coverage. Remediation validation is recorded with each fix.

## Remediation checks

- Permanent coverage: chat-operation-v2-workspace-lifecycle.test.ts,
  chat-operation-v2-authoring.test.ts, chat-operation-v2-commit-runtime.test.ts,
  chat-operation-v2-service.test.ts, chat-operation-v2-routes.test.ts,
  loopback-fetch.test.ts, bot-bridge-stream-renderer.test.ts, and chat-priority-ui.test.tsx.
- Editor server/client/test TypeScript checks and changed-file ESLint passed.
- Repository bun run verify:quick completed: 9/11 gates passed. Its lint gate found four
  console warnings only in pre-existing, Git-ignored apps/editor/.tmp/chat-manual-concurrency-audit
  scripts. Full source lint passed with only that temporary directory excluded.
- The editor runner completed all files; its sole failure was the unchanged
  opencode-managed-tools.test.ts exceeding Bun's default five-second deadline. A
  normal isolated rerun also exceeded that deadline; the same test passed all 20
  assertions in about nine seconds with --timeout 30000. Track the fixture budget
  as maintenance; no assertion or production guard was disabled.
- Public package tests passed in the repository run. The separately completed
  Electron suite passed all 83 tests (the root && chain had stopped at the editor
  timeout). The new regression suites passed in the full editor run.
- Remote CI status could not be queried because GitHub CLI is not authenticated.
