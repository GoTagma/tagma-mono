---
name: test-tagma-test-sets
description: Run a developer-supplied Tagma live test set or benchmark matrix, adjudicate one-prompt success, and stop for generic product repairs when a Tagma-owned defect is confirmed. Use only for explicit test-set or scenario/level acceptance work, not ordinary tests or diagnostics monitoring.
---

# Test Tagma Test Sets

Use the supplied test set as the source of prompts and acceptance criteria. Follow its requested order and workspace isolation. Keep an evidence ledger with separate observations for the initial response and draft, compilation, actual Trial, Host terminal outcome, published bytes, and a normal Run with real workspace artifacts. Compilation, Trial, publication, and a green task count do not by themselves prove the requested business result.

## Decide each case

1. Submit the original case prompt once in a dedicated conversation and fresh workspace. A Host safety clarification or in-operation automatic repair is part of that original attempt; record it explicitly. Do not add hints, fixtures, or attachments to the original submission unless the user supplied them.
2. Call **one-prompt pass** only when that attempt produces the requested working result in a normal Run, including the case's substantive artifact and content criteria. Check the authored architecture and required failure behavior as well as file existence. A later user Retry or follow-up cannot retroactively make the original attempt pass.
3. On a one-prompt failure, diagnose before advancing. Separate Tagma-owned runtime, planning, publication, and recovery faults from generated workflow/model mistakes, provider errors, network failures, and environment limits. Treat the test case as a probe: establish the affected class and seek structurally different evidence or a deterministic counterexample before confirming a product defect.
4. If a Tagma-owned defect is confirmed, **stop the remaining matrix**. Fix the general owning mechanism, demonstrate a failing regression before the fix and a passing regression after it, preserve existing Trial strength, run relevant repository checks, and document the durable invariant. Do not add branches for the test set's names, prompts, claims, fixture values, or paths. Tell the developer to restart the local editor after the fix; wait for a fresh connection before resuming the failed level and subsequent levels.
5. If no product defect is confirmed, same-conversation follow-ups or explicit Host Retry may be used to reach a functional output. Label each interaction and its Trial/Run result separately. Record the outcome as **functional after follow-up/Retry**, not one-prompt pass. If a Tagma-owned defect emerges during recovery, apply step 4 immediately.

Use fresh Diagnostics and Chat Control instructions for each workspace. Read their manifests/state first; keep diagnostics cursors independent; never find or reuse old bearer tokens. Preserve unrelated files and global model settings. Do not weaken Trial assertions. Update the ledger after each completed case, and stop at the user's stated matrix boundary.

Follow `tagma-dev` for source changes and `monitor-tagma-diagnostics` for evidence and defect qualification. A candidate observation is not yet a confirmed product defect; investigate it before deciding to repair or advance.
