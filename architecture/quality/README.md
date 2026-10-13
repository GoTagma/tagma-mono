# Historical issue regression gate

`known-issues.json` is the durable issue register. Its current contents are an
incomplete intake of the 2026-10-12 handoff, not a recovered historical inventory
and not a report that the original acceptance set passed. `importComplete` must
remain `false` until the required historical sources have been restored,
authenticated, read, and imported issue by issue.

The handoff attachment was fully read and its SHA-256 is
`4bc4afcbdf12cb964f8065e7c7acd435941406d8e0d7bba4801d95d0fe55342a`.
The attachment reports prior observations; it does not replace the original run
evidence. The current workspace audit found the four catalogs and the round-18
formal records absent. The original test-set source is present with the expected
SHA-256, but that alone cannot restore the issue inventory or prior run evidence.

## Evidence and state

- Stable issue IDs persist after resolution. Import original IDs into `lineage`
  when their catalogs are available; do not guess the missing lineage or merge
  records merely because their symptoms sound similar.
- `observationVerified` and `causeConfirmed` are independent. The handoff-only
  entries remain `unknown` in both fields until their underlying evidence is
  read and authenticated. `reportedObservation` and `reportedCause` preserve what
  the handoff says without promoting it to a local finding.
- `firstEvidence: null` means the original first evidence has not been recovered.
  `intakeEvidence` records the read handoff attachment; it is not historical first
  evidence. `reportedEvidence` preserves exact reported paths and hashes.
- `pending-evidence` is not `fixed`, `confirmed-regression`, or `newly-exposed`.
  Assign those states only after reviewing source-bound evidence. A runner must
  never change an issue to fixed automatically.
- Preserve previous source identities, first evidence, lineage, fixes, and
  ordered history. Append later observations and repairs instead of rewriting
  the old record. Keep resolved issues and their executable regressions.
- `regressionCandidates` are inspected test selectors that may help investigate
  a mechanism. They are not an accepted issue-to-regression mapping. An existing
  passing guard test does not prove a missing real Engine path has been fixed.

## Required historical import

Paths below are relative to the repository. Hashes are reported by the handoff
and have not been authenticated against the missing files in this workspace.

| Source   | Path                                                                                         | Reported SHA-256                                                   |
| -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Round 12 | `work/fact-checker/reviews/sweep12-root-issue-catalog-complete-v5.json`                      | `e2a5b26a0b8835399d92459bc293dd078d510c2bc53d7a942646dcccb852525f` |
| Round 13 | `work/fact-checker/reviews/sweep13-unified-issue-catalog-v1.json`                            | `9fab8d2c2d1920436f0be16ce42a5207f135bb0dcc1ba56d55f9330c145f922a` |
| Round 16 | `work/fact-checker/reviews/sweep16-root-whole-problem-catalog-actual-v1/catalog.actual.json` | `0a8237d96311f7fa44355dde032c400e00731f239a84e6b6a2dbe8f81c63af01` |
| Round 17 | `work/fact-checker/reviews/sweep17-full12-issue-catalog-prepared-v1/catalog.json`            | `2ce888df4451db515efae77851cfc5b237c820a2126339ccbf35c0339d3587de` |

Also recover `work/fact-checker/reviews/sweep18-formal-current/` and
`work/fact-checker/reviews/sweep18-sole-grader-finished/`, including all nine
formally graded cases, and the exact round-18 source, acceptance-policy, and run
bindings. Their directory hashes were not supplied, so do not invent them.
Recover `work/fact-checker/case-inventory.json` with reported SHA-256
`68bbda2f669e438f3270238c621f3ad08f6367f221343c53cfcf8ba25b9b3343`.

For each original entry, authenticate the evidence and its source/policy, record
its original ID, establish whether it shares a mechanism with an intake entry,
and preserve original first evidence and ordered history. Counts in the handoff
(such as round 17's 36 issues) do not mean that many confirmed root causes. In
particular, round 13's uncommitted-plan cause was not proven. Only mark the import
complete after accounting for every historical entry, including resolved ones,
and binding each required issue to a real executable regression.

## Repair batches and the gate

`current-source-regressions.json` is a separate, explicitly scoped baseline of
the initial eight recorded mechanisms/guard contracts and 29 exact executable selectors,
plus two later portable interaction contracts (ten records and 40 selectors).
Qualification capture and four later clarification guards bring the current mapping
to eleven records and 45 exact selectors. Its
first four guard observations are preserved in
`evidence/current-source-initial-observations.json`: the actual local run executed
four passing tests in three calls, and retains every output hash and execution
count. Each mapped selector uses the complete test name and expects one test.
The source and test-file SHA bindings matched commit
`f5efe267efd829c1e17e9a52b2bbd4545fef66dd` when this intake was recorded.

Its `importComplete=true` applies only to the mapped current-source
records. `historicalCoverageComplete=false` remains explicit. A passing run of
this baseline establishes current visible guard coverage; it does not establish
historical GREEN, repaired historical causes, or readiness to resume real
acceptance. The original issue register retains missing first evidence and
regression mappings. Related historical issue IDs are references only and do not
change their status to fixed.

Run the full current-source baseline after every coherent repair batch. Add a
new contract only with source-bound evidence and its executable regression; record
later executions separately without overwriting the immutable initial evidence.
The first four contracts retain their original limited claims. `CSR-0005` adds
four actual Engine second-slot identity regressions with source-bound assertion
RED/GREEN evidence. `CSR-0006` records the test descendant observer boundary;
`CSR-0007` covers fixed Host environment inheritance. `CSR-0008` adds four actual
renderer/Host helper regressions for exact runtime model membership: three failed
assertions and one pass on old production, then all ten tests in that file passed,
including six retained legacy tests. The generic picker mechanism is confirmed;
the specific real R3 admission cause and free-provider availability remain UNKNOWN.
The newly expanded 29-selector gate must be executed against the final source;
the ten-test local result does not replace it or establish real acceptance.

1. Keep missing historical import explicitly blocked. Continue in the new
   workspace requested by the user: rebuild a separately named current-source
   baseline from authenticated public source and executable regressions, retaining
   all unresolved handoff entries. Do not wait indefinitely for the old workspace,
   set `importComplete=true` to acknowledge missing data, or call this baseline
   the full historical set. If archives become available, reconcile them as above.
   Validate the gate's rejection
   of empty inventories, missing evidence/mappings/files, zero matched tests,
   skips/todos, test failures, and historical record deletion or rewriting.
2. Select one coherent mechanism. Add a regression through the actual relevant
   Managed/Trial Engine path and observe an assertion failure on the old product.
   A missing module, installation failure, or import error is an environment
   failure, not proof of the product bug.
3. Apply the smallest causal repair and rerun that same regression. Preserve the
   original fixtures and assertions. Do not add production branches for test-set
   names, prompts, business values, or workspace paths.
4. Run the established current-source baseline after every coherent change batch,
   and the entire historical set when its import is complete. A failure blocks
   expanding the change: fix or revert it first. The current-source baseline and
   local subsets cannot produce historical GREEN. Missing archives remain an
   explicit evidence limitation, not a silently removed historical obligation.
5. Run relevant types, lint, and format checks. For changed product behavior,
   freeze the actual source, complete the required engineering qualification,
   rebuild the desktop, and run the local no-cost smoke before real acceptance.
   Do not repeat a full check already included in the same successful Full13.

The handoff recommends the planner identity second-slot Engine regression first,
then the repair/stale-plan path. The five prepared patches are separate proposals
with `ready=false`; their tests, compilation, and real acceptance were not run.
Do not merge them as one package or call static preparation a repair result.
Diagnostics preservation and test-fixture cleanup are separately scoped changes;
neither proves Chat convergence. Environment failures remain separate from product
regressions. A current typed provider billing block is an observed provider failure;
its account balance and specific billing cause remain UNKNOWN.

## Real acceptance after the gate

The user selected the new workspace for continuing work. For the restart from
the beginning, use fresh product workspaces for all 12
original cases and preserve the exact original prompts. Run through the started
Tagma application's **OpenCode Chat**, monitor **Diagnostics / Chat Control**, and
judge the current **Open Pipeline** result, normal publication, and necessary
automatic repair convergence. Direct model calls, manual Run, and repository
tests do not substitute for this acceptance.

Keep DeepSeek **Flash + low**, `planning=2`, `pipelineRepair=2`, serial execution,
one original Send per case, no manual Retry, and no additional paid probes. Keep
the same source binding and UI/convergence policy for comparisons; do not compare
round 17's stricter business grading directly with round 18's UI grading or add
math accuracy/all-Trial-coverage criteria as new acceptance requirements.

The user's later conditional authorization permits trying a genuine OpenCode
Free-labelled model after the preferred DeepSeek financial path is blocked. Bind
the actual typed billing/quota evidence and closed attempted paid/native/controller
scopes before a distinct fresh run. `provider_billing_required` alone does not
prove quota exhaustion or account balance; authentication, rate-limit, and network
failures do not authorize this fallback. Discover the exact model from the current
configured runtime picker, retain its provider/model/variant and a separate model
scope, and preserve the same prompts and budgets. Free labels do not establish
price or provider availability. Select `low` when explicitly supported; `null`
is allowed only for no advertised variants and means provider default, not low.
Do not use Pro, high, or max, or manually retry an already sent case.

For a new workspace's create-versus-default-blank-draft clarification, the user
authorized creating the new pipeline at the requested filename according to the
original test goal. Use the normal pending clarification reply once; retain the
original prompt and Send. Do not invent answers beyond that authority or duplicate
a reply whose acknowledgement is unknown.

Every qualification binds the completed source snapshot, exact compiled desktop
artifact hashes, harness entry/dependencies, regression evidence, and actual local
zero-Send smoke. A Git HEAD, static review, or old receipt is insufficient after
source changes. Earlier R7 smoke proved compiled UI startup, monitoring, zero
Host invocations/Usage records, and Free candidate metadata discovery; it did not
execute model selection or prove that provider callable. Each real case must
commit the exact qualified model/variant through normal controls and verify the
current selection before its one original Send.

Current publication proof joins the native workspace binding, Diagnostics and
Chat Control operation/conversation/version, mounted renderer, genuine current
DOM/PNG Open Pipeline, and matching result/artifact/file identity. Normal startup
may consume the temporary `ws` URL parameter; its absence does not invalidate
this identity chain. Capture the publication surface before later Usage Stats
navigation. Missing or conflicting current evidence stays UNKNOWN; historical
results, summary fields, or a later screenshot cannot fabricate missing DOM proof.

Round 18 was legitimately paused after 10 closed cases. Preserve that partial
closure: S4L1 still needs review and exact permitted cleanup, S4L2 and S4L3 were
not run, and user cancellation is not a new product regression. Do not reuse a
whole-12 closure template or resume the old launcher to manufacture a fresh run.
Do not repeat already completed version bumps or cleanup, upload `work/`, delete
unknown-owned artifacts, or lower the product's resource admission floor.

Finite regressions establish checkable coverage of recorded mechanisms. They do
not guarantee that every unknown failure is impossible.

## Recorded R6 result and later preparation

The R6 [runtime supplement](runtime-observations-20261012-r6-supplement.json)
appends current observations while preserving the earlier registers, first
evidence and ordered histories. All 12 original cases were attempted once with
DeepSeek Flash + low and the original planning2/repair2 budget: S1L2 passed and
11 cases remained NOT_FULL_PASS. The sealed closure and independent review cover
the available recorded owned scopes and 27 terminal keyed rows. Global provider
scope and financial facts remain UNKNOWN. Historical coverage remains
`false` and the historical gate remains `BLOCKED_UNAVAILABLE_EVIDENCE`.

The later generic planner-guidance v4 change passed the existing eight-record,
29-selector gate, 100 related seed tests and one exact begin selector. That proof
does not establish a NoPlan/core/identity/provider cause or real Chat convergence.
The sealed S4L1 chronology separately shows successful final structural
validation followed by no counted native commit; its original NoPlan and
NOT_FULL_PASS result remain unchanged.

Two portable workflow fixes are installed in the current-source catalog. CSR-0009
retains the six genuine old-harness assertion failures and 177-test GREEN proof,
with seven exact public Bun selectors and unchanged links to its six real cases.
CSR-0010 retains the earlier denial evidence and adds identifier-type hardening
with four unchanged selectors and 47 passing assertions. Its normal reject
workflow requires trusted current-request authority; actual target scope,
provider adaptation and real convergence remain UNKNOWN. The catalog has ten
records and 40 selectors at that earlier step. Later additions preserve those
records and selectors. A full gate must bind the complete source and catalog after
each batch. Local synthetic GREEN does not replace current
publication proof or complete the missing historical import.

## Recorded R7 result and current tool coverage

The R7 [runtime supplement](runtime-observations-20261012-r7-supplement.json)
records all twelve original cases on the frozen 1419-file R7 source: four PASS
(S2L2, S3L1, S4L1, S4L2) and eight NOT_FULL_PASS. The unchanged Flash low policy,
one Send per case and planning2/repair2 budget produced 36 terminal keyed rows,
14 planner invocations and two repairs. Independent review confirms the recorded
current Root, native and Host scopes closed; global processes, provider children,
financial facts and unproved product causes remain UNKNOWN. Root's external
operator reply count is zero; that ledger does not count normal harness actions.

Four cases stopped at authorized clarification matching gaps. S1L2's two native
plan commits and S3L2's single commit are distinct recorded chronologies; structural
repairs made the retained old plans stale after the original paid planning slots
were used. Saved error evidence was completely delivered, including S3L3's large
second-planner block. Model network findings and guidance causality remain UNKNOWN.
No result difference alone establishes a historical regression or a repaired issue.

The current mapping has eleven records and 45 exact selectors. CSR-0011 binds
installed qualification capture to actual read-only private qualification adoption,
one outer Bun selector and four real inner Node cases; the separate 41-selector
environment batch passed. CSR-0009 appends four source-bound grammar selectors
while preserving its first evidence, old history and seven prior selectors. All
eleven tests in the installed clarification file passed with Bun1.3.14 and JUnit;
the mapped 45-selector gate must independently bind the final source and catalog.
These later tool source epochs do not replace R7's qualification or establish
native post-fix adaptation, real convergence, complete historical GREEN, or fixed
runtime status. Historical coverage remains false and BLOCKED_UNAVAILABLE_EVIDENCE.

## Recorded R8 result

The R8 [runtime supplement](runtime-observations-20261012-r8-supplement.json)
appends all twelve original cases on the frozen 1425-file source: three PASS
(S1L2, S2L1, S3L2) and nine NOT_FULL_PASS. Four cases retained blocked content
findings, three stopped at unanswered authorized clarification, one stopped
after normal least-privilege permission denial, and one retained NoPlan.
Fourteen planner calls, no repairs and 36 current keyed rows settled under the
unchanged Flash low, one-Send and planning2/repair2 policy.

The Root external ledger separately records two plan preparations, one utility
execution and zero typed reply POSTs, extra Sends, retries or paid probes. Normal
harness clarification and permission replies are separately journaled. The sealed
current owned native, Root CLI and paid operation scopes are closed; global and
financial facts remain UNKNOWN. All fourteen stable issue definitions, first
evidence, statuses and prior histories remain intact. Historical import remains
blocked. These observations grant no new launch, cleanup or fixed-status claim.
The bounded NoPlan follow-up reproduced distinct attempt identities for S4L2.
Later draft changes had no final validation or commit; final validity and the
model stop reason remain UNKNOWN. This case supplies no repeated-identity
counterexample and changes no earlier issue status.

## Root clarification workflow regression

The current-source inventory now preserves the original eleven issues and 45
selectors, and appends CSR-0012 with ten executable broker contracts (55 total).
The broker accepts an explicit Root choice bound to the original request and
a fresh full Chat Control state, then permits one normal typed clarification
reply through the existing harness session. Permanent reservations prevent
reposting after an unknown acknowledgement. This changes no original Send,
Retry, model, permission or pipeline Run budget. The whole mapped gate and
actual new-source desktop qualification are still required; local contract
results do not establish genuine publication or complete missing history.

## Recorded R9 result and native rejection coordinate contract

The R9 [runtime supplement](runtime-observations-20261012-r9-supplement.json)
records all twelve genuine original cases on the frozen 1429-file source: five
PASS (S1L2, S2L2, S2L3, S3L1, S4L3) and seven NOT_FULL_PASS. The unchanged Flash
low, one-Send and planning2/repair2 policy produced twenty planner invocations,
two repairs and fifty current keyed rows: forty-seven settled/completed and three
unavailable. Unavailable is terminal evidence, not a completed model output.

The same-policy R8 comparison records four NOT-to-PASS and two PASS-to-NOT
outcomes. These observations do not prove a causal repair or a reintroduced
fixed mechanism. Four Root metadata choices delegated four normal clarification
replies; Root sent no direct typed POST, extra original Send, Retry or paid probe.
The later bound closure and independent review resolve the recorded current
native, paid-operation and precise Root CLI scopes. Earlier UNKNOWN fields remain
as-of evidence; global processes and provider financial facts stay UNKNOWN.
All fourteen stable runtime IDs and twenty-nine historical representations are
preserved. Missing historical import remains blocked.

CSR-0013 adds seven portable generated-tool selectors while preserving the
previous twelve records and fifty-five selectors. One genuine old-source selected
assertion failed because the native rejection lacked finite bound coordinates;
the intermediate five-pass/two-fail candidate remains recorded. The selected V3
candidate passed all seven tests with 111 assertions in an isolated local tree.
The feedback retains the original admission predicates, summaries, fingerprints,
counters and budgets, and always reports availability as unknown. It proves no
validator false rejection or real Chat convergence. The full thirteen-record,
sixty-two-selector gate is NOT_RUN at this metadata preparation; installation,
qualification and a fresh full original12 acceptance must bind their own evidence.
Historical coverage remains false and BLOCKED_UNAVAILABLE_EVIDENCE.

## Recorded R10 result

The R10 [runtime supplement](runtime-observations-20261013-r10-supplement.json)
records all twelve genuine original cases on the frozen 1433-file source:
four PASS (S1L1, S2L1, S4L1, S4L3) and eight NOT_FULL_PASS. Flash low, one
original Send per case and planning2/repair2 produced twenty-one planner
invocations and four repairs. Fifty-two current keyed rows are terminal:
fifty settled and two unavailable. No manual Retry or extra paid probe was used.

Two cases paused with an older-revision plan after repair; their protected
artifact deltas and revalidation eligibility remain UNKNOWN. Three retained
NoPlan/planner pauses and two retained preexecution blocked-core pauses. S1L3
stopped at an unanswered authorized clarification: Root's late writer was
rejected without a choice or reply. This is retained as a workflow observation.
Four later metadata choices delegated four normal clarification replies.

The sole grades, Root closure, final operator ledger and saved independent late
review resolve the recorded current owned scopes. Earlier UNKNOWN records remain
unchanged; global processes, provider financial facts and missing historical
coverage remain UNKNOWN. Three NOT-to-PASS and four PASS-to-NOT differences
against R9 do not establish causal repairs or historical regressions. CSR-0013
retains its seven selectors, original evidence and installed fix history; these
runtime observations do not automatically promote it to live verified.

## Retained contract after an owned repair

CSR-0014 records an Engine counterexample: after two planners, a genuine failed
Trial and one owned YAML repair, the unchanged plan contract could not resume
verification. Its normal publication control passed; the stale raw-plan guard
remains correct. The new Host path captures the original contract before repair,
keeps its live bytes unchanged, and revalidates every original case and repeat
against the repaired source before granting current publication authority.

Ten portable regressions cover real coordinator publication, authority refusal,
the ordinary stale reader and inactive companion symlinks. The current catalog
now maps fourteen issues to seventy-two exact selectors. Run the complete mapped
gate after each coherent change; a failed, missing, skipped or zero-execution
selector blocks further changes and real testing. Earlier issue identities,
first evidence, histories and regressions remain present.

The first captured eligible repair is supported. A second owner cannot inherit
that authority; its continuation requires a separate regression and repair.
Current R10 case eligibility and fresh real Chat convergence remain unknown.
The receipt authenticates the execution's post-witness and current source; it
does not prove that mutable external prerequisites stay equal forever.
The next real run follows the user's current preference for an available
OpenCode free model, with DeepSeek Flash low as fallback in a distinct fresh
run. Original prompts and Send/planning/repair budgets remain unchanged.

The retained-contract mechanism also maps a separate cache/replay scenario: original cases and repeats execute freshly after owned repair even when an independent branch cache is eligible; normal replay preserves genuine run and archive identities. Its local candidate proof does not establish real Chat convergence. The current inventory has 14 issues and 73 exact selectors as of this addition.

The current inventory also retains CSR-0015, the genuine unanswered-clarification test-harness observation with four observer regressions, and CSR-0016, seventeen preventive guards for the newly authorized Free-first model workflow. CSR-0016 is a local workflow contract, with no previous product defect asserted. Unknown causes remain unknown. This addition maps 16 entries to 94 exact selectors; original12 acceptance and actual observer activation still require new source-bound evidence.

CSR-0017 records the full engineering check failure caused by two obsolete cache protocol expectations. Its four signed legacy-cache route regressions retain fresh execution, authenticated cache, replay counters and finalize rejection. The inventory now maps 17 records to 98 selectors; the failed engineering run remains failed and requires a new source-bound qualification.

CSR-0018 and CSR-0019 preserve confirmed local proof-log overwrite and copied invocation metadata incidents. Their nine real-Node regression guards prevent capture-path reuse and require one actual command, complete captured streams, matching source bytes and nonempty named execution. The missing old raw proof remains UNKNOWN; future prevention does not reconstruct it. The current inventory now maps 19 records to 107 selectors.

CSR-0020 retains the genuine current typed Host DTO mismatch in the Free-run boundary collector. Monitoring errorCode/diagnosticCodes and adjudication typedFailure.code carry the provider rejection, while the old collector ignored those coordinates. Six exact regressions keep the four provider codes, legacy fields, unknown/prose negatives, Free-mode scope and current closure controls. The local candidate preserves seventeen existing assertions and passed twenty-three Bun tests; The minimal public collector and all six mapped guards are installed; the new 113-selector current gate and a distinct fresh real run remain pending. The original R11 reports and qualification are immutable; no provider channel cause or genuine workflow PASS is inferred. This addition maps twenty records to 113 exact selectors without removing resolved or unresolved history.

R12 clarification regressions retain the seven actual closed waits and the old
helper assertion failures. The portable policy now recognizes complete ownership
and pipeline-intent alternatives while keeping original-source, caller-authority
and current-operation checks. CSR-0021 separately covers bounded optional JSON
polling: incomplete producer bytes confer no reply authority, and persistent
malformed or unsettled bytes block. Its local counterexample does not establish
the cause of the actual R12 observer exit. Both mechanisms remain in the current
regression gate; fresh product publication and missing historical evidence are
separate from local regression results.

The latest user instruction supersedes the earlier DeepSeek fallback for future
runs: use only a usable OpenCode Free model with the explicit low variant. If
none is usable, wait; do not switch automatically to DeepSeek or recharge.
Earlier Free-first and Free-then-DeepSeek records remain unchanged as-of evidence.
Current metadata does not prove provider availability or actual charges; both
remain UNKNOWN.

CSR-0022 adds eight portable FreeOnly/wait authority and selection guards while
retaining all twenty-one earlier issues and 143 mappings. The old reader's
selected assertion RED establishes support missing for the new policy type; the
first candidate's 30-pass/1-fail fixture result and its later correction remain
separate evidence. The saved final candidate passed all 31 local tests, including
the unchanged original 23. The proposed inventory maps 22 issues to 151 selectors;
public installation, a new source-bound whole current gate and fresh real
acceptance remain separate. Missing historical evidence remains blocked.

The managed session also records `ENV-current-node-child-capture`, linked to the
existing CSR-0011 qualification fixture. Two current gates stopped before that
selected test because a child Node returned empty stdout in the default execution
context. A version-only comparison and the later complete 151-selector gate
verified the native execution context mitigation. The underlying environment cause
remains unknown; these are environment failures, not product regression evidence.
Keep the explicit Node binary and the configured native execution context for
actual child-process checks in this session. The regression runner removes provider
credentials, and these checks make no model requests.

CSR-0024 retains a source-extracted private operator counterexample: a genuinely started and closed slot with zero original Sends can have NOT RUN adjudication, so adjudication status cannot determine the started or sent count. The portable closed-matrix-identity helper checks the run and source joins, exact original serial prefix, explicit 0/1 submission facts, and known paid/process closure facts. Its three synthetic metadata regressions preserve the old failure evidence and reject unknown closure and foreign identities. Public installation and the next whole current-source gate are separate evidence; these tests do not establish provider acceptance, product convergence, or complete historical coverage.

Later verification epochs for CSR-0022 and CSR-0023 record actual public installation, the complete 23-issue/159-selector current-source gate, and genuine H16 caller execution. Their earlier pending preparation fields remain unchanged as-of; consult the appended history and latestVerificationState for the later mechanism verification. CSR-0023 preserves independent finalization hooks after evidence failures without treating successful callbacks as proof of scope closure.

The public inventory now maps 24 reconstructed current-source issues to 162 executable selectors. Run the complete current-source gate after this coherent batch; its source-bound receipt is kept separately to avoid a catalog self-reference. Historical import gaps remain explicit. [The R14 observation supplement](runtime-observations-20261013-r14-supplement.json) preserves one genuinely closed NOT_FULL_PASS submission and eleven unstarted slots after the selected Free request was rejected. Supplier cause and availability of other Free models remain UNKNOWN. The current policy waits and permits no DeepSeek fallback, manual Retry, or extra model probe.
