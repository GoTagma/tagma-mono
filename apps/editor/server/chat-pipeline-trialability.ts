import type { PluginRegistry } from '@tagma/sdk/plugins';
import {
  TRIAL_INTERACTION_PROTOCOL_VERSION,
  isTrialInteractionDeclaration,
  type CapabilityHandler,
  type PipelineConfig,
  type PluginCategory,
  type TrialInteractionDeclaration,
} from '@tagma/types';

export type ChatPipelineTrialMode = 'sandbox' | 'sandbox-with-live-smoke';
export type ChatPipelineTrialabilityComponent =
  'hook' | 'command' | 'driver' | 'trigger' | 'middleware' | 'completion';
export type ChatPipelineTrialabilityDisposition =
  | 'sandbox-ready'
  | 'sandbox-ready-with-host-risk'
  | 'live-smoke-only'
  | 'live-smoke-ready'
  | 'human-required'
  | 'unsupported-in-unattended-trial';

export interface ChatPipelineTrialabilityItem {
  readonly component: ChatPipelineTrialabilityComponent;
  readonly taskId?: string;
  readonly type: string;
  readonly provider: string;
  readonly declaration: TrialInteractionDeclaration | null;
  readonly disposition: ChatPipelineTrialabilityDisposition;
  /** Zero-based position when one hook or middleware field contains several entries. */
  readonly occurrence?: number;
}

export interface ChatPipelineTrialabilityReport {
  readonly protocolVersion: typeof TRIAL_INTERACTION_PROTOCOL_VERSION;
  readonly mode: ChatPipelineTrialMode;
  readonly runnable: boolean;
  readonly enforcement: {
    readonly sandboxCases: {
      readonly workspace: 'temporary-copy';
      readonly stdin: 'closed';
      readonly tty: 'none';
      readonly secrets: 'synthetic';
      readonly filesystem: 'host-unrestricted-outside-copy';
      readonly network: 'host-unrestricted';
      readonly process: 'host-unrestricted';
    };
    readonly liveSmokeBaseline: {
      readonly workspace: 'real-workspace';
      readonly stdin: 'closed';
      readonly tty: 'none';
      readonly secrets: 'real';
      readonly filesystem: 'host-unrestricted';
      readonly network: 'host-unrestricted';
      readonly process: 'host-unrestricted';
    } | null;
  };
  readonly items: readonly ChatPipelineTrialabilityItem[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface BuildChatPipelineTrialabilityReportInput {
  readonly pipelineConfig: PipelineConfig;
  readonly registry: PluginRegistry;
  readonly capabilityOwners: ReadonlyMap<string, string>;
  readonly mode: ChatPipelineTrialMode;
}

const HOST_PROVIDER = '@tagma/editor/host';
const MAX_REPORT_ITEMS = 8_192;
const MAX_MESSAGE_LENGTH = 1_024;
const MAX_PROVIDER_LENGTH = 256;

const SANDBOX_CASE_ENFORCEMENT = {
  workspace: 'temporary-copy',
  stdin: 'closed',
  tty: 'none',
  secrets: 'synthetic',
  filesystem: 'host-unrestricted-outside-copy',
  network: 'host-unrestricted',
  process: 'host-unrestricted',
} as const;

const LIVE_SMOKE_BASELINE_ENFORCEMENT = {
  workspace: 'real-workspace',
  stdin: 'closed',
  tty: 'none',
  secrets: 'real',
  filesystem: 'host-unrestricted',
  network: 'host-unrestricted',
  process: 'host-unrestricted',
} as const;

const HOST_EXECUTION_DECLARATION = {
  protocolVersion: TRIAL_INTERACTION_PROTOCOL_VERSION,
  interaction: 'none',
  unattended: 'host-adapter',
  filesystem: 'external-write',
  network: 'write',
  secrets: 'synthetic-ok',
  runtime: 'bounded',
} as const satisfies TrialInteractionDeclaration;

const HOOK_ORDER = [
  'pipeline_start',
  'task_start',
  'task_success',
  'task_failure',
  'pipeline_complete',
  'pipeline_error',
] as const;

function bounded(value: string, max = MAX_MESSAGE_LENGTH): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

function providerName(value: string): string {
  return bounded(value.trim() || 'unknown', MAX_PROVIDER_LENGTH);
}

function declarationSnapshot(
  declaration: TrialInteractionDeclaration,
): TrialInteractionDeclaration {
  return {
    protocolVersion: declaration.protocolVersion,
    interaction: declaration.interaction,
    unattended: declaration.unattended,
    filesystem: declaration.filesystem,
    network: declaration.network,
    secrets: declaration.secrets,
    runtime: declaration.runtime,
  };
}

function itemLabel(
  item: Pick<ChatPipelineTrialabilityItem, 'component' | 'taskId' | 'type'>,
): string {
  const task = item.taskId ? ' for task ' + bounded(item.taskId) : '';
  return item.component + ' ' + bounded(item.type) + task;
}

function classifyDeclaration(
  item: Pick<ChatPipelineTrialabilityItem, 'component' | 'taskId' | 'type'>,
  declaration: TrialInteractionDeclaration,
  mode: ChatPipelineTrialMode,
  blockers: string[],
  warnings: string[],
): ChatPipelineTrialabilityDisposition {
  const label = itemLabel(item);
  if (
    declaration.interaction === 'interactive-stdio' ||
    declaration.interaction === 'browser-auth'
  ) {
    blockers.push(
      bounded(
        label + ' requires ' + declaration.interaction + ' and cannot run in an unattended Trial.',
      ),
    );
    return 'human-required';
  }

  if (
    declaration.interaction === 'unknown' ||
    declaration.unattended === 'unsupported' ||
    declaration.runtime === 'long-lived'
  ) {
    const reason =
      declaration.interaction === 'unknown'
        ? 'declares an unknown interaction'
        : declaration.unattended === 'unsupported'
          ? 'does not support unattended Trial execution'
          : 'declares a long-lived runtime';
    blockers.push(bounded(label + ' ' + reason + '.'));
    return 'unsupported-in-unattended-trial';
  }

  const needsLiveSmoke =
    declaration.secrets === 'real-required' ||
    declaration.network === 'read' ||
    declaration.network === 'write' ||
    declaration.filesystem === 'external-write';
  if (!needsLiveSmoke) return 'sandbox-ready';

  const risks = [
    declaration.secrets === 'real-required' ? 'real credentials' : null,
    declaration.network === 'read' ? 'external network reads' : null,
    declaration.network === 'write' ? 'external network writes' : null,
    declaration.filesystem === 'external-write' ? 'writes outside the temporary copy' : null,
  ].filter((risk): risk is string => risk !== null);
  warnings.push(bounded(label + ' may use ' + risks.join(', ') + ' with normal host authority.'));

  if (mode === 'sandbox-with-live-smoke') return 'live-smoke-ready';
  blockers.push(bounded(label + ' requires an explicitly authorized Live Smoke Test.'));
  return 'live-smoke-only';
}

/**
 * Inventory and classify every execution-capable surface without calling a
 * driver, trigger, middleware, or completion method.
 */
export function buildChatPipelineTrialabilityReport({
  pipelineConfig,
  registry,
  capabilityOwners,
  mode,
}: BuildChatPipelineTrialabilityReportInput): ChatPipelineTrialabilityReport {
  const items: ChatPipelineTrialabilityItem[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let itemLimitReached = false;

  const pushItem = (item: ChatPipelineTrialabilityItem): void => {
    if (items.length < MAX_REPORT_ITEMS) {
      items.push(item);
      return;
    }
    if (!itemLimitReached) {
      itemLimitReached = true;
      blockers.push(
        'Trialability report exceeds the deterministic limit of ' +
          MAX_REPORT_ITEMS +
          ' execution surfaces.',
      );
    }
  };

  const pushHostItem = (
    component: 'hook' | 'command',
    type: string,
    taskId?: string,
    occurrence?: number,
  ): void => {
    pushItem({
      component,
      ...(taskId === undefined ? {} : { taskId }),
      type,
      provider: HOST_PROVIDER,
      declaration: declarationSnapshot(HOST_EXECUTION_DECLARATION),
      disposition: 'sandbox-ready-with-host-risk',
      ...(occurrence === undefined ? {} : { occurrence }),
    });
    warnings.push(
      'Host commands and hooks use a temporary workspace copy, closed stdin, and no TTY, but external filesystem, network, and child-process access are not OS-enforced.',
    );
  };

  const pushCapabilityItem = (
    category: PluginCategory,
    component: Exclude<ChatPipelineTrialabilityComponent, 'hook' | 'command'>,
    type: string,
    taskId: string,
    occurrence?: number,
  ): void => {
    const owner = capabilityOwners.get(category + '/' + type);
    if (!registry.hasHandler(category, type)) {
      const item = {
        component,
        taskId,
        type,
        provider: providerName(owner ?? 'unregistered'),
        declaration: null,
        disposition: 'unsupported-in-unattended-trial',
        ...(occurrence === undefined ? {} : { occurrence }),
      } as const satisfies ChatPipelineTrialabilityItem;
      pushItem(item);
      blockers.push(bounded(itemLabel(item) + ' has no registered handler.'));
      return;
    }

    const handler = registry.getHandler<CapabilityHandler>(category, type);
    let rawDeclaration: unknown;
    try {
      rawDeclaration = handler.trial;
    } catch {
      rawDeclaration = null;
    }
    const provider = providerName(owner ?? handler.name);

    let declaration: TrialInteractionDeclaration | null = null;
    try {
      if (isTrialInteractionDeclaration(rawDeclaration)) {
        const snapshot = declarationSnapshot(rawDeclaration);
        if (isTrialInteractionDeclaration(snapshot)) declaration = snapshot;
      }
    } catch {
      declaration = null;
    }

    const baseItem = { component, taskId, type };
    if (declaration === null) {
      const item = {
        ...baseItem,
        provider,
        declaration: null,
        disposition: 'unsupported-in-unattended-trial',
        ...(occurrence === undefined ? {} : { occurrence }),
      } as const satisfies ChatPipelineTrialabilityItem;
      pushItem(item);
      blockers.push(
        bounded(
          rawDeclaration === undefined
            ? itemLabel(item) + ' does not declare Trial Interaction Protocol v1.'
            : itemLabel(item) +
                ' has a malformed Trial Interaction Protocol declaration; expected v1.',
        ),
      );
      return;
    }

    pushItem({
      ...baseItem,
      provider,
      declaration,
      disposition: classifyDeclaration(baseItem, declaration, mode, blockers, warnings),
      ...(occurrence === undefined ? {} : { occurrence }),
    });
  };

  for (const hookType of HOOK_ORDER) {
    const hook = pipelineConfig.hooks?.[hookType];
    if (hook === undefined) continue;
    const commands = Array.isArray(hook) ? hook : [hook];
    commands.forEach((_command, occurrence) => {
      pushHostItem('hook', hookType, undefined, commands.length > 1 ? occurrence : undefined);
    });
  }

  for (const track of pipelineConfig.tracks) {
    for (const task of track.tasks) {
      const taskId = track.id + '.' + task.id;
      if (task.command !== undefined) {
        pushHostItem('command', 'host-command', taskId);
      } else {
        pushCapabilityItem(
          'drivers',
          'driver',
          task.driver ?? track.driver ?? pipelineConfig.driver ?? 'opencode',
          taskId,
        );
      }

      if (task.trigger) {
        pushCapabilityItem('triggers', 'trigger', task.trigger.type, taskId);
      }

      const middlewares = task.middlewares ?? track.middlewares ?? [];
      middlewares.forEach((middleware, occurrence) => {
        pushCapabilityItem(
          'middlewares',
          'middleware',
          middleware.type,
          taskId,
          middlewares.length > 1 ? occurrence : undefined,
        );
      });

      if (task.completion) {
        pushCapabilityItem('completions', 'completion', task.completion.type, taskId);
      }
    }
  }

  return {
    protocolVersion: TRIAL_INTERACTION_PROTOCOL_VERSION,
    mode,
    runnable: blockers.length === 0,
    enforcement: {
      sandboxCases: { ...SANDBOX_CASE_ENFORCEMENT },
      liveSmokeBaseline:
        mode === 'sandbox-with-live-smoke' ? { ...LIVE_SMOKE_BASELINE_ENFORCEMENT } : null,
    },
    items,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
  };
}
