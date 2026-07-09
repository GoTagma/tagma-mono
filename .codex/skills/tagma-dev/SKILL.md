---
name: tagma-dev
description: 'Tagma product development workflow guardrails. Use when Codex works in the Tagma monorepo or D:\TagmaMono on implementation, bug fixes, refactors, frontend/editor changes, Electron desktop changes, package APIs, schemas, YAML task dataflow, plugins, tests, validation, release flow, publishing, or CI follow-up.'
---

# Tagma Dev

Use this skill for Tagma product development work. It borrows the Pullwise development discipline: test-first when useful, explicit edge-case handling, durable agent notes, project-specific verification, CI awareness, and a clear completion gate.

## Core Workflow

1. Identify the affected Tagma workspace or workspaces before editing. Read the relevant `README.md`, `package.json`, and nearest `AGENTS.md` if present.
2. Place the change in the monorepo shape before changing code: `packages/types`, `packages/core`, `packages/runtime-bun`, `packages/sdk`, plugin packages, `apps/editor`, or `apps/electron`.
3. Use test-first development for feature work and bug fixes. Write or update the smallest meaningful test first, run it to prove the missing behavior or bug exists, then implement the change and rerun the same test as verification.
4. Explicitly consider edge cases while designing, testing, and implementing changes, including empty states, invalid YAML, missing files, permission failures, Windows and POSIX paths, shell escaping, process crashes, partial update failure, version skew, concurrent editor windows, network failure, and boundary values.
5. During the work, continuously collect future-agent notes: project rules, constraints, definitions, invariants, data-shape decisions, task dataflow decisions, API assumptions, release quirks, CI gotchas, and anything non-obvious that another agent would need later.
6. Before finishing, write durable notes into the corresponding `AGENTS.md` when new non-obvious knowledge was discovered. Keep notes concise, actionable, and scoped. Do not add transient task notes, personal narration, or generic coding advice.
7. Run relevant local verification for every affected workspace. Prefer the repository's documented check, test, typecheck, lint, build, or verify commands.
8. Review the corresponding CI Action or check status before declaring the task complete when CI is relevant and accessible. If any CI check fails and the failure is related to the change, diagnose and fix it, then rerun local verification and re-check CI. If CI access is unavailable, state that explicitly and provide the strongest local verification performed.

## Compatibility Policy

Tagma has public npm packages, persisted YAML workflows, plugin contracts, desktop packaging, and hot-update behavior. Treat these as compatibility-sensitive. Do not break public `@tagma/*` APIs, YAML task semantics, package boundaries, published plugin contracts, desktop update contracts, or release artifact shape unless the user explicitly asks for a breaking change or the change includes the required versioning and migration plan.

Prefer clean internal design only when public behavior and persisted data remain stable. Do not add complex legacy adapters, migrations, dual paths, or backward-compatible shims for purely internal code unless a real persisted or published boundary requires them.

## Monorepo Boundaries

Respect the repository's dependency shape:

- Build order is `types -> core -> runtime-bun -> sdk -> plugins`.
- Desktop builds add editor client, editor sidecar, and Electron shell on top.
- Public packages should import other Tagma workspaces through public `@tagma/*` package names, not internal source paths.
- Workspace dependencies should use `workspace:*`.
- Public package tarballs ship built `dist/` output and exclude `src/`.
- `apps/editor` and `apps/electron` are private app workspaces, not npm packages.
- Use Bun for repository work. Use Node only for scripts that are already documented or declared to run with `node`.

## Task Dataflow Rules

Keep Tagma YAML behavior aligned with the repository README:

- Use task-level `inputs` and `outputs`; there is no public `ports:` key.
- Command tasks consume inputs through `{{inputs.name}}`.
- Prompt tasks receive inputs as context and produce structured JSON outputs.
- Matching input/output names connect automatically.
- Use `from` only to disambiguate, rename, or read raw streams.
- Command placeholders are verbatim by default. Use `| shellquote` for string inputs that may contain shell syntax.

## Frontend Policy

Keep Tagma frontend changes visually consistent with the existing product. The editor is a work-focused visual pipeline tool, so prioritize dense but readable information, stable dimensions, clear alignment, predictable controls, and existing components. Avoid decorative marketing-style pages, unnecessary cards, soft visual patterns that clash with the product, or controls that make repeated editor workflows slower.

For editor changes, preserve the split between the React/Vite client and the Bun/Express sidecar. For desktop changes, preserve the Electron shell's responsibility for launch environment, bundled OpenCode, packaging, and sidecar lifecycle.

## Desktop And Update Policy

Treat update behavior as a release contract:

- The primary Tagma update path stages editor and sidecar artifacts together before activation.
- Editor-only and sidecar-only update routes are recovery paths unless the task specifically targets them.
- OpenCode is pinned per desktop release; do not surface or encourage independent upgrades unless the task is explicitly about manual recovery or the existing upgrade route.
- Manifest hashes, optional signatures, rollback behavior, sidecar respawn behavior, and version skew handling are correctness boundaries.
- Release workflow source of truth is `.github/workflows/release-desktop.yml`.

## Verification Guidance

Prefer the narrowest command that proves the changed behavior, then broaden as risk increases:

- Public packages: `bun run check:public`, `bun run test:public`, or the matching `bun run check:<package>` script.
- Editor: `bun run check:server`, `bun run check:client`, `bun run check:tests`, `bun run --filter tagma-editor test`, `bun run build:editor`, or `bun run build:editor-sidecar`.
- Electron: `bun run check:electron`, `bun run --filter tagma-desktop test`, `bun run build:electron`, or `bun run build:desktop`.
- Whole repo: `bun run verify:quick` for broad local confidence; `bun run verify` for release-sensitive or high-risk changes.
- Hygiene: `bun run lint`, `bun run format:check`, `bun run check:text`, `bun run check:deps`, `bun run check:imports`, and `bun run check:cycles` when the change touches those concerns.

When diagnosing performance regressions, consider temporarily disabling or short-circuiting individual modules, rerunning the same performance test for each variant, and comparing metrics. The module whose removal produces the largest improvement is likely the main bottleneck; narrow further inside that module.

## Commit Summary Rule

If creating a git commit in this repository, follow the root `AGENTS.md` rule:

1. Write the commit message first and create the commit.
2. Read the final commit id after the commit is created.
3. Ensure root `changelog/` exists.
4. Create `changelog/<commit-id>.en.md`.
5. Write all related commit messages as a single-line JSON-style string array.
6. Do not amend the commit to include the changelog file.

If one task creates related commits in multiple repositories, create one combined changelog file in this repository root named after this repository's final commit id.

## Completion Gate

Do not present Tagma development work as complete until all applicable items are true:

- Test-first evidence exists for each feature or bug fix, or the exception is explicitly justified.
- The same test that failed or exposed the missing behavior now passes.
- Relevant workspace verification commands have been run.
- Broader verification has been run for shared package, public API, release, or desktop changes.
- Relevant `AGENTS.md` notes have been updated when durable knowledge was discovered.
- Corresponding CI Action status has been reviewed; related failures have been fixed or CI unavailability has been reported.
- Any git commit created for the task has the required local changelog summary file.

