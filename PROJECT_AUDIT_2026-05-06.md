# Tagma Mono Project Audit - 2026-05-06

## Scope

本次检查覆盖源码和工程配置，不审查 `dist/`、`build/`、`node_modules/`、`coverage/` 等产物目录。

检查类别：

- 项目配置、脚本、CI 和发布链路
- TypeScript、lint、format、text hygiene 门禁
- 依赖安全审计
- 后端 API、revision/If-Match 数据一致性
- YAML 解析、导入、保存和前端状态流
- 插件安装、加载和 workspace YAML 扫描
- Electron 安全配置
- 前端 bundle 体积和长期维护性风险

## Executive Summary

当前仓库存在会直接挡住静态门禁的高优先级问题：`bun audit` 和 `bun run check` 失败。除此之外，revision 同步、YAML strict parse、`/api/config/replace` 输入防护、插件声明扫描资源上限是需要尽快修的中优先级问题。

测试和构建层面，`bun run test`、`bun run build`、`bun run build:editor`、`bun run check:electron`、`bun run build:electron` 已验证通过；但 `bun run check`、`bun run lint`、`bun run format:check`、`bun run check:text`、`bun audit` 失败。

## Issue List

| Priority | Issue | Status | Evidence | Recommended Fix |
| --- | --- | --- | --- | --- |
| High | `bun audit` fails with Electron/tar vulnerabilities | Confirmed | `electron@35.7.5` is below audit-patched `38.8.6`; vulnerable `tar@6.2.1` comes mainly through `electron-builder@25.1.8` transitive chain. Direct `tar@7.5.x` dependencies are already above the tar patched threshold. Relevant manifests: `apps/electron/package.json:37-39`, `apps/editor/package.json:36`. Advisories: [Electron GHSA-9wfr-w7mm-pc7f](https://github.com/advisories/GHSA-9wfr-w7mm-pc7f), [tar GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v). | Upgrade Electron to a patched supported line, then upgrade or override the `electron-builder` dependency chain so `tar@6.2.1` is removed. Re-run `bun audit`. |
| High | `bun run check` type gate fails | Confirmed | `apps/editor/tests/pipeline-store-sync-local-memory.test.ts:52` uses undefined `serverConfig`; `:178` and `:205` pass `unknown` where `TrackFolder[] \| undefined` is expected. | Define or remove `serverConfig`; type the mocked layout folders as `TrackFolder[]` before assignment. |
| Medium-High | `/api/export-file` bumps revision but returns no `revision` | Confirmed | `apps/editor/server/index.ts:321` pre-bumps revision for mutations; `apps/editor/server/revision-routes.ts:1` does not bypass `/api/export-file`; `apps/editor/server/routes/workspace.ts:887` returns only `{ ok, path }`; `apps/editor/src/api/client.ts:342` updates client revision only when the response includes `revision`. The next mutation can 409 on a stale client baseline. | Either add `/api/export-file` to revision bypass if export should not affect editor state, or return `{ ok, path, revision }` and update the client response type. |
| Medium | YAML strict parse allows invalid task items into frontend state | Confirmed | `packages/sdk/src/schema.ts:67` validates track shape and `tasks` array shape but not each task item. Open/import paths use `parseYaml` first at `apps/editor/server/routes/workspace.ts:625` and `:817`; if strict parse succeeds, sanitizer is skipped. Frontend code such as `apps/editor/src/components/board/BoardCanvas.tsx:98` directly reads `task.id`. `tasks: [null]` can pass `parseYaml`. | Make `parseYaml` reject non-object task items, or route editor open/import through the sanitizer before state is returned. |
| Medium | `/api/config/replace` does not reuse bounded JSON and forbidden-key guard | Mostly confirmed | `apps/editor/server/routes/pipeline.ts:118` defines `assertBoundedJson` for depth, array length, node count and forbidden keys; normal mutation handlers use `guardedObject`. `apps/editor/server/routes/pipeline.ts:673` only performs shallow config/track/task shape checks. Express has a 5 MB body limit, but that is not equivalent to the same structural guard. | Reuse `assertBoundedJson` for the replace payload and add recursive whitelist cleanup for `RawPipelineConfig`/layout fields. |
| Medium | `.tagma` YAML plugin declaration scanner lacks file count and file size caps | Confirmed, scope corrected | `apps/editor/server/plugins/loader.ts:1090` scans top-level `.tagma/*.yaml`; it is not recursive. `apps/editor/server/plugins/loader.ts:1094` uses `readFileSync` plus `yaml.load` with no per-file size cap or total file count cap. Workspace open calls `autoLoadInstalledPlugins` at `apps/editor/server/routes/workspace.ts:269`, so the scan is on the workspace-load path. | Add maximum scanned YAML count, per-file byte limit, and warning/skip behavior for oversized files. |
| Medium | PR CI has coverage gaps | Confirmed | `.github/workflows/ci.yml` PR job uses `submodules: false` and runs only `check:public`, `test:public`, and `lint:public`. Full app/editor/electron checks run on push to main, so submodule/app regressions can land before being caught. | For PRs that can affect the app submodule, run recursive checkout plus editor/electron check jobs, or add a separate required app CI workflow. |
| Medium | Published package manifests may expose `workspace:*` protocol | Partially confirmed, needs tarball dry-run verification | `scripts/build-package.mjs` only runs `tsc` and does not rewrite manifests. Public package manifests such as `packages/core/package.json:42`, `packages/runtime-bun/package.json:50`, and `packages/sdk/package.json:77-79` contain `workspace:*` in runtime dependencies; several plugin packages also use `workspace:*` in `peerDependencies`. `packages/trigger-webhook/package.json` is a better pattern: runtime peer semver plus workspace dependency only in devDependencies. [Bun workspaces](https://bun.com/docs/install/workspaces) / [bun publish](https://bun.com/docs/pm/cli/publish) are expected to rewrite workspace dependencies during publish, but this should be verified against the actual packed/published tarball. | Run `bun publish --dry-run` or pack inspection for every public package and confirm tarball manifests contain semver ranges, not `workspace:*`. If not rewritten, replace runtime/peer workspace protocols with semver ranges before publishing. |
| Medium-Low | `bun run format:check` fails across 80 files | Confirmed | Prettier reports 80 files with formatting drift. CI does not currently run `format:check`, so this is repository hygiene and gate-definition debt rather than a currently required PR blocker. | Run Prettier in a dedicated formatting-only change, or remove/soften the unused format gate if it is not intended to be enforced. |
| Medium-Low | Editor main JS chunk is large | Confirmed | `bun run build:editor` passes, but Vite reports main JS chunk at about 1,068.44 kB minified / 300.97 kB gzip. | Add route-level dynamic imports or manual chunks for heavy editor panels, plugin UI, and infrequently used flows. |
| Low | `bun run lint` fails on a hook dependency warning | Confirmed | `apps/editor/src/components/board/BoardCanvas.tsx:1157` includes unnecessary `renameFolder` in a dependency array. `--max-warnings 0` makes this warning fail lint. | Remove `renameFolder` from the dependency array, or use it if the callback actually depends on it. |
| Low | `bun run check:text` fails | Confirmed, corrected line number | The failure is at `packages/sdk/src/middlewares/static-context.test.ts:64`, not line 43. The CJK literals are valid UTF-8; the hygiene check is triggered by the intentional U+FFFD replacement-character assertion. The focused test itself passes. | Replace the literal replacement character with `'\uFFFD'`, or add a precise allowlist to the text hygiene checker. |
| Low | Large files and type/hook escape hatches create maintainability risk | Confirmed, not urgent | Large files include `apps/editor/src/store/pipeline-store.ts`, `apps/editor/server/plugins/install.ts`, `apps/editor/src/App.tsx`, `apps/editor/src/components/board/BoardCanvas.tsx`, `apps/editor/src/api/client.ts`. There are also scattered `eslint-disable react-hooks/exhaustive-deps` and `as unknown as` casts. | Do not mix this with gate fixes. Plan separate, behavior-locked cleanup passes for the largest modules and highest-risk hook disables/casts. |

## Non-Issues And Observations

| Item | Conclusion | Reason |
| --- | --- | --- |
| `docs/` is ignored | Not included as a current issue | `.gitignore` does ignore `docs/`, but the current local `docs/plans` directory has no actual tracked-worthy documentation file observed. |
| Electron security boundary | Observation only | Current code uses hardened BrowserWindow settings, including `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. No direct unsafe spread into `webPreferences` was identified. Dependency upgrades are still required because of audit findings. |

## Verification Commands

| Command | Result | Notes |
| --- | --- | --- |
| `bun run check` | Failed | Type errors in `pipeline-store-sync-local-memory.test.ts`. |
| `bun run lint` | Failed | React hook dependency warning treated as error. |
| `bun run check:text` | Failed | Intentional U+FFFD literal trips text hygiene. |
| `bun run format:check` | Failed | 80 files need Prettier formatting. |
| `bun audit` | Failed | 24 vulnerabilities reported, including Electron and transitive tar issues. |
| `bun run test` | Passed | Full workspace test run passed during audit. |
| `bun run build` | Passed | Public packages/plugins build passed. |
| `bun run build:editor` | Passed with warning | Large main chunk warning. |
| `bun run check:electron` | Passed | Electron typecheck passed. |
| `bun run build:electron` | Passed | Electron build passed. |

## Suggested Fix Order

1. Fix `bun run check` type failures.
2. Fix dependency audit: Electron first, then `electron-builder`/transitive `tar`.
3. Fix `/api/export-file` revision handling and add regression coverage.
4. Harden YAML task item parsing and editor import/open path behavior.
5. Harden `/api/config/replace` with bounded JSON and recursive whitelist cleanup.
6. Add `.tagma` YAML scan file count and size caps.
7. Decide PR CI policy for app/electron/submodule checks.
8. Verify publish tarball manifests and remove any published `workspace:*`.
9. Clean lint/text hygiene/format drift in small isolated changes.
10. Plan maintainability refactors separately after behavior is locked by tests.
