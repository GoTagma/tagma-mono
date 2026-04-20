---
name: yaml-pipeline
description: Generate and review Tagma YAML pipelines — tracks, tasks, drivers, dependencies — following the project's house conventions.
compatibility: opencode
metadata:
  audience: tagma-editor users
  category: authoring
---

## What I do

Help the user produce valid Tagma pipeline YAML. This includes:

- Drafting a full pipeline skeleton from a plain-English goal
- Adding tracks / tasks with the right driver and fields
- Wiring `depends_on` between tasks across tracks
- Reviewing an existing YAML and flagging violations of the rules below

## House rules for Tagma YAML

1. **Top level is required:** `name`, `tracks`. Optional: `plugins`, `triggers`,
   `middleware`, `completion`, `hooks`.
2. **Track IDs are kebab-case** and unique within the pipeline.
3. **Task IDs are kebab-case** and unique within their track. The fully-qualified
   form `track-id.task-id` is how other tasks reference them.
4. **Every task must declare a `driver`.** Pull the driver name from the
   workspace's plugin registry — never invent driver names.
5. **`depends_on` entries are always fully-qualified** (`track.task`), even for
   same-track dependencies. The editor's validator flags bare task IDs.
6. **Prefer explicit `continue_from`** over implicit ordering when a task should
   only start after a specific upstream task, not just after the whole track.
7. **Secrets never go in YAML.** Use `${env.NAME}` placeholders; Tagma resolves
   them from the runtime environment.
8. **Timeouts use Go duration strings** (`30s`, `5m`, `1h`) — not raw seconds.

## When to use me

Activate for any request that mentions pipelines, tracks, tasks, YAML authoring,
or driver selection inside the Tagma editor. If the user is asking about Tagma
runtime behavior (not authoring), defer to the docs instead.

## Output format

When generating a full pipeline, return a single fenced `yaml` block. When
editing, return a unified diff against the current file so the editor can apply
it in place.
