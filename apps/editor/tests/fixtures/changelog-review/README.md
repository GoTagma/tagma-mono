# Changelog review acceptance fixture

This Windows PowerShell pipeline reproduces a review/revision handoff and release-check gap found
during editor diagnostics. It retains the observed eight-task topology, including later user-owned
bindings and continuation links. The repaired revision explicitly consumes `issues`, and the release
gate checks source entry identity, uniqueness, area, completeness, and severity callouts.

`../../changelog-review-acceptance.test.ts` runs the real SDK dataflow, commands, middleware, and
completion checks with deterministic prompt-driver responses. It covers an empty-workspace first
run, reuse, empty approval feedback, a varied source dataset, missing/ignored corrections, malformed
release content, and the original negative input gates. A Host Sandbox case additionally verifies
creation and content assertions without leaking fixtures or generated output into the source
workspace. These tests do not claim to grade arbitrary prose semantics or provider reliability.

Negative cases assert an explicit child-authored `validation-error:` marker on stdout. PowerShell
stderr may contain wrapped CLIXML and the full invocation script, so matching arbitrary substrings
there can either miss the actual error or match a branch that never ran.
