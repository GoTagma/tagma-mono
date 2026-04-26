import type { TaskConfig, TaskPorts, TaskResult } from '../types';
import {
  extractTaskBindingOutputs,
  extractTaskOutputs,
  inferPromptPorts,
} from '../ports';
import type { RunContext } from './run-context';

function isPromptTaskConfig(
  task: TaskConfig,
): task is TaskConfig & { readonly prompt: string; readonly command?: undefined } {
  return task.prompt !== undefined && task.command === undefined;
}

function isCommandTaskConfig(
  task: TaskConfig,
): task is TaskConfig & { readonly command: string; readonly prompt?: undefined } {
  return task.command !== undefined && task.prompt === undefined;
}

export type EffectivePortsResult =
  | {
      readonly kind: 'ready';
      readonly isPromptTask: boolean;
      readonly effectivePorts: TaskPorts | undefined;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: string;
    };

export function inferEffectivePorts(
  ctx: RunContext,
  taskId: string,
): EffectivePortsResult {
  const node = ctx.dag.nodes.get(taskId)!;
  const task = node.task;
  const isPromptTask = isPromptTaskConfig(task);

  if (!isPromptTask) {
    return { kind: 'ready', isPromptTask: false, effectivePorts: task.ports };
  }

  const inference = inferPromptPorts({
    upstreams: node.dependsOn.map((upstreamId) => {
      const upstream = ctx.dag.nodes.get(upstreamId);
      const isUpstreamCommand = upstream ? isCommandTaskConfig(upstream.task) : false;
      return {
        taskId: upstreamId,
        outputs: isUpstreamCommand ? upstream?.task.ports?.outputs : undefined,
      };
    }),
    downstreams: (ctx.directDownstreams.get(taskId) ?? []).map((downstreamId) => {
      const downstream = ctx.dag.nodes.get(downstreamId);
      const isDownstreamCommand = downstream ? isCommandTaskConfig(downstream.task) : false;
      return {
        taskId: downstreamId,
        inputs: isDownstreamCommand ? downstream?.task.ports?.inputs : undefined,
      };
    }),
  });

  if (inference.inputConflicts.length > 0 || inference.outputConflicts.length > 0) {
    const lines: string[] = [];
    for (const conflict of inference.inputConflicts) lines.push(conflict.reason);
    for (const conflict of inference.outputConflicts) lines.push(conflict.reason);
    return { kind: 'blocked', reason: lines.join('\n') };
  }

  return { kind: 'ready', isPromptTask: true, effectivePorts: inference.ports };
}

export interface ExtractSuccessfulOutputsOptions {
  readonly task: TaskConfig;
  readonly effectivePorts: TaskPorts | undefined;
  readonly result: TaskResult;
}

export interface ExtractSuccessfulOutputsResult {
  readonly outputs: Readonly<Record<string, unknown>> | null;
  readonly bindingDiagnostic: string | null;
  readonly portDiagnostic: string | null;
}

export function extractSuccessfulOutputs(
  options: ExtractSuccessfulOutputsOptions,
): ExtractSuccessfulOutputsResult {
  const { task, effectivePorts, result } = options;
  let extractedOutputs: Readonly<Record<string, unknown>> | null = null;

  const bindingExtraction = extractTaskBindingOutputs(
    task.outputs,
    result.stdout,
    result.stderr,
    result.normalizedOutput,
  );
  if (task.outputs && Object.keys(task.outputs).length > 0) {
    extractedOutputs = bindingExtraction.outputs;
  }

  const portExtraction = extractTaskOutputs(
    effectivePorts,
    result.stdout,
    result.normalizedOutput,
  );
  if (effectivePorts?.outputs && effectivePorts.outputs.length > 0) {
    extractedOutputs = {
      ...(extractedOutputs ?? {}),
      ...portExtraction.outputs,
    };
  }

  return {
    outputs: extractedOutputs,
    bindingDiagnostic: bindingExtraction.diagnostic,
    portDiagnostic: portExtraction.diagnostic,
  };
}
