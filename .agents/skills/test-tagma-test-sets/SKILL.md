---
name: test-tagma-test-sets
description: Run a developer-supplied Tagma live test set or scenario/level matrix one conversation round at a time, adjudicate one-round success, and repair confirmed Tagma-owned defects before advancing. Use only for explicit test-set or scenario/level acceptance work, not ordinary repository tests or diagnostics-only monitoring.
---

# Test Tagma Test Sets

Use the supplied test set as the source of prompts, levels, and acceptance criteria. Follow its requested order and workspace isolation. Run levels strictly in order and never start the next level before the current level is adjudicated. Keep an evidence ledger with separate observations for every round: the initial response and draft, compilation, actual Trial, Host terminal outcome, and the sealed round result with its published bytes. Compilation or publication alone, and a green task count without the case's substantive criteria, do not prove the requested business result. The acceptance bar is the conversation round's normal result: **no manual real-workspace Run is required** beyond what the round itself produces.

## Round definition

- One **round** is a single user message submitted in a dedicated conversation in a fresh workspace, plus everything the Host and agent-mode execution do on their own until the operation reaches a terminal state. Automatic in-operation repair attempts, Host safety clarifications, and Trial/verification loops are part of that same round; they are never counted as extra rounds.
- A new user message in the same conversation, an explicit user Retry, or a new conversation starts a new round. Label every round and its Trial/Run result separately in the ledger.
- Monitor every round live through the supplied Diagnostics and Chat Control APIs. A round that reaches the requested business result but shows a Tagma-owned defect in monitoring is not clean: handle it under the defect path below.

## Decide each level

1. Submit the level's original case prompt once as round 1 in a dedicated conversation and fresh workspace. Do not add hints, fixtures, or attachments to the original submission unless the user supplied them.
2. Call **one-round pass** only when round 1 reaches a normal sealed result — passed Trial evidence and published bytes meeting the case's substantive artifact and content criteria, authored architecture, and required failure behavior, not mere file existence — and round monitoring shows no product defect. A real-workspace manual Run is not part of the bar. A later round cannot retroactively make round 1 a one-round pass.
3. On a round failure or a defect signal from monitoring, diagnose before advancing. Separate Tagma-owned runtime, planning, publication, and recovery faults from generated workflow/model mistakes, provider errors, network failures, and environment limits. Treat the test case as a probe: establish the affected class and seek structurally different evidence or a deterministic counterexample before confirming a product defect.
4. If a Tagma-owned defect is confirmed, **stop the remaining matrix** and repair immediately:
   - Fix the general owning mechanism. Demonstrate a failing regression before the fix and a passing regression after it, preserve existing Trial strength, run relevant repository checks, and document the durable invariant. Do not add branches for the test set's names, prompts, claims, fixture values, or paths.
   - Tell the developer to restart the local editor after the fix, and wait for a fresh connection.
   - Create a **new workspace** with fresh Diagnostics and Chat Control instructions, then re-run the failed level's case from round 1 to verify the fix. Only after that verification passes, continue with the next level.
5. If no product defect is confirmed, additional rounds in the same conversation (follow-ups or explicit Host Retry) may be used to reach a functional output. Monitor every such round; if a Tagma-owned defect emerges in any round, apply step 4 immediately. When the level reaches a normal result without a product defect, record the outcome as **functional after follow-up/Retry**, not one-round pass.

A level is complete when its case reaches a normal result through either path. Continue level by level until the final level of the supplied matrix, then report the per-level outcomes.

## Cross-cutting rules

Use fresh Diagnostics and Chat Control instructions for each workspace. Read their manifests/state first; keep diagnostics cursors independent; never find or reuse old bearer tokens. Preserve unrelated files and global model settings. Do not weaken Trial assertions. Update the ledger after each completed round, and stop at the user's stated matrix boundary.

Follow `tagma-dev` for source changes and `monitor-tagma-diagnostics` for evidence and defect qualification. A candidate observation is not yet a confirmed product defect; investigate it before deciding to repair or advance.
