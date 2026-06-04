import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import type {
  PipelineConfig,
  PipelineGraphConfig,
  RawPipelineConfig,
  RawTaskConfig,
  RawWorkflowConfig,
  TagmaSdkRequirements,
} from '@tagma/types';

export interface YamlCompatibilityFeature {
  readonly id: string;
  readonly minSdkVersion: string;
  readonly description: string;
}

export interface CompatibilityDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface TagmaYamlCompatibility {
  readonly currentSdkVersion: string;
  readonly minSdkVersion: string | null;
  readonly sdkRequirement: string | null;
  readonly declaredSdkRequirement: string | null;
  readonly features: readonly YamlCompatibilityFeature[];
  readonly diagnostics: readonly CompatibilityDiagnostic[];
}

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export interface ParsedSdkRequirement {
  readonly raw: string;
  readonly minVersion: string;
}

const SDK_PACKAGE_VERSION_FALLBACK = '0.0.0';
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const SDK_REQUIREMENT_RE = /^(?:>=\s*)?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const INPUT_PLACEHOLDER_RE = /\{\{\s*inputs\.[A-Za-z_][A-Za-z0-9_]*\b/;

export const TAGMA_SDK_VERSION = readCurrentSdkVersion();

/**
 * Minimum SDK that understands the `requires.sdk` YAML metadata itself.
 * Keep this aligned with the first package version that ships this file.
 */
export const YAML_REQUIRES_FIELD_MIN_SDK = TAGMA_SDK_VERSION;

export const YAML_FEATURE_MIN_SDK = {
  requires: YAML_REQUIRES_FIELD_MIN_SDK,
  workflow: '0.7.0',
  workflow_lifecycle: '0.7.0',
  task_bindings: '0.7.0',
  safe_mode: '0.7.0',
} as const;

const FEATURE_DESCRIPTIONS: Record<keyof typeof YAML_FEATURE_MIN_SDK, string> = {
  requires: 'YAML declares SDK compatibility metadata with requires.sdk',
  workflow: 'YAML uses the workflow graph document format',
  workflow_lifecycle: 'Workflow pipeline declares lifecycle retry policy',
  task_bindings: 'Pipeline tasks declare inputs/outputs bindings or input placeholders',
  safe_mode: 'Pipeline declares an explicit safe/trusted execution mode',
};

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    throw new Error(`Cannot compare invalid semver values "${a}" and "${b}"`);
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l) ? Number(l) : null;
    const rNum = /^\d+$/.test(r) ? Number(r) : null;
    if (lNum !== null && rNum !== null) {
      if (lNum !== rNum) return lNum > rNum ? 1 : -1;
      continue;
    }
    if (lNum !== null) return -1;
    if (rNum !== null) return 1;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

export function parseSdkRequirement(value: string): ParsedSdkRequirement | null {
  const trimmed = value.trim();
  const match = SDK_REQUIREMENT_RE.exec(trimmed);
  if (!match) return null;
  const version = normalizeVersion(match[1]);
  return version ? { raw: trimmed, minVersion: version } : null;
}

export function formatSdkRequirement(version: string): string {
  return `>=${version}`;
}

export function sdkRequirementSatisfied(
  requirement: string,
  currentVersion = TAGMA_SDK_VERSION,
): boolean {
  const parsed = parseSdkRequirement(requirement);
  if (!parsed) return false;
  return compareSemver(currentVersion, parsed.minVersion) >= 0;
}

export function validateDeclaredSdkRequirement(
  requires: unknown,
  path: string,
  documentLabel: 'pipeline' | 'workflow',
  currentVersion = TAGMA_SDK_VERSION,
): CompatibilityDiagnostic[] {
  if (requires === undefined) return [];
  const diagnostics: CompatibilityDiagnostic[] = [];
  if (!isRecord(requires)) {
    return [
      {
        path,
        message: `${path} must be an object with sdk: ">=x.y.z"`,
      },
    ];
  }
  for (const field of Object.keys(requires)) {
    if (field === 'sdk') continue;
    diagnostics.push({
      path: `${path}.${field}`,
      message: `Unknown ${path} field "${field}"`,
    });
  }
  const rawSdk = requires.sdk;
  if (rawSdk === undefined) {
    diagnostics.push({ path: `${path}.sdk`, message: `${path}.sdk is required` });
    return diagnostics;
  }
  if (typeof rawSdk !== 'string') {
    diagnostics.push({
      path: `${path}.sdk`,
      message: `${path}.sdk must be a version requirement like ">=0.8.0"`,
    });
    return diagnostics;
  }
  const parsed = parseSdkRequirement(rawSdk);
  if (!parsed) {
    diagnostics.push({
      path: `${path}.sdk`,
      message: `${path}.sdk must be a version requirement like ">=0.8.0"`,
    });
    return diagnostics;
  }
  if (compareSemver(currentVersion, parsed.minVersion) < 0) {
    diagnostics.push({
      path: `${path}.sdk`,
      message: `This ${documentLabel} requires @tagma/sdk >=${parsed.minVersion}, current is ${currentVersion}.`,
    });
  }
  return diagnostics;
}

export function inferPipelineCompatibility(
  config: RawPipelineConfig | PipelineConfig,
): TagmaYamlCompatibility {
  return buildCompatibility(config.requires, collectPipelineFeatures(config), 'pipeline');
}

export function inferWorkflowCompatibility(
  config: RawWorkflowConfig | PipelineGraphConfig,
): TagmaYamlCompatibility {
  return buildCompatibility(config.requires, collectWorkflowFeatures(config), 'workflow');
}

export function inferYamlCompatibility(content: string): TagmaYamlCompatibility {
  const doc = yaml.load(content);
  if (!isRecord(doc)) {
    throw new Error('YAML must contain a top-level "pipeline" or "workflow" key');
  }
  const hasPipeline = Object.prototype.hasOwnProperty.call(doc, 'pipeline');
  const hasWorkflow = Object.prototype.hasOwnProperty.call(doc, 'workflow');
  if (hasPipeline && hasWorkflow) {
    throw new Error('YAML must not contain both top-level "pipeline" and "workflow" keys');
  }
  if (hasPipeline) {
    if (!isRecord(doc.pipeline)) throw new Error('pipeline must be an object');
    return inferPipelineCompatibility(doc.pipeline as unknown as RawPipelineConfig);
  }
  if (hasWorkflow) {
    if (!isRecord(doc.workflow)) throw new Error('workflow must be an object');
    return inferWorkflowCompatibility(doc.workflow as unknown as RawWorkflowConfig);
  }
  throw new Error('YAML must contain a top-level "pipeline" or "workflow" key');
}

export function withInferredPipelineSdkRequirement<T extends RawPipelineConfig | PipelineConfig>(
  config: T,
): T {
  return withInferredSdkRequirement(config, inferPipelineCompatibility(config));
}

export function withInferredWorkflowSdkRequirement<
  T extends RawWorkflowConfig | PipelineGraphConfig,
>(config: T): T {
  return withInferredSdkRequirement(config, inferWorkflowCompatibility(config));
}

function buildCompatibility(
  requires: unknown,
  features: readonly YamlCompatibilityFeature[],
  documentLabel: 'pipeline' | 'workflow',
): TagmaYamlCompatibility {
  const declared = declaredSdkRequirement(requires);
  let minSdkVersion = maxFeatureVersion(features);
  if (declared) minSdkVersion = maxVersion(minSdkVersion, declared.minVersion);
  if (features.length > 0 || requires !== undefined) {
    minSdkVersion = maxVersion(minSdkVersion, YAML_REQUIRES_FIELD_MIN_SDK);
  }
  return {
    currentSdkVersion: TAGMA_SDK_VERSION,
    minSdkVersion,
    sdkRequirement: minSdkVersion ? formatSdkRequirement(minSdkVersion) : null,
    declaredSdkRequirement: declared?.raw ?? null,
    features,
    diagnostics: validateDeclaredSdkRequirement(requires, 'requires', documentLabel),
  };
}

function withInferredSdkRequirement<T extends { readonly requires?: TagmaSdkRequirements }>(
  config: T,
  compatibility: TagmaYamlCompatibility,
): T {
  if (!compatibility.minSdkVersion) return config;
  const declared = declaredSdkRequirement(config.requires);
  const existingSdk = config.requires?.sdk;
  if (existingSdk !== undefined && !declared) return config;
  const target =
    declared && compareSemver(declared.minVersion, compatibility.minSdkVersion) > 0
      ? declared.minVersion
      : compatibility.minSdkVersion;
  return {
    ...config,
    requires: {
      ...(isRecord(config.requires) ? config.requires : {}),
      sdk: formatSdkRequirement(target),
    },
  } as T;
}

function collectPipelineFeatures(
  config: RawPipelineConfig | PipelineConfig,
): YamlCompatibilityFeature[] {
  const features = new Map<string, YamlCompatibilityFeature>();
  if (config.requires !== undefined) addFeature(features, 'requires');
  if (config.mode !== undefined) addFeature(features, 'safe_mode');
  const tracks = Array.isArray(config.tracks) ? config.tracks : [];
  for (const track of tracks) {
    const tasks = Array.isArray(track.tasks) ? track.tasks : [];
    for (const task of tasks) {
      if (taskUsesBindings(task as RawTaskConfig)) addFeature(features, 'task_bindings');
    }
  }
  return [...features.values()];
}

function collectWorkflowFeatures(
  config: RawWorkflowConfig | PipelineGraphConfig,
): YamlCompatibilityFeature[] {
  const features = new Map<string, YamlCompatibilityFeature>();
  addFeature(features, 'workflow');
  if (config.requires !== undefined) addFeature(features, 'requires');
  const pipelines = Array.isArray(config.pipelines) ? config.pipelines : [];
  for (const pipeline of pipelines) {
    if (isRecord(pipeline) && pipeline.lifecycle !== undefined) {
      addFeature(features, 'workflow_lifecycle');
    }
    if (isRecord(pipeline) && isRecord(pipeline.config)) {
      for (const feature of collectPipelineFeatures(pipeline.config as unknown as PipelineConfig)) {
        features.set(feature.id, feature);
      }
    }
  }
  return [...features.values()];
}

function taskUsesBindings(task: RawTaskConfig): boolean {
  if (Object.prototype.hasOwnProperty.call(task, 'inputs')) return true;
  if (Object.prototype.hasOwnProperty.call(task, 'outputs')) return true;
  if (typeof task.command === 'string' && INPUT_PLACEHOLDER_RE.test(task.command)) return true;
  if (typeof task.prompt === 'string' && INPUT_PLACEHOLDER_RE.test(task.prompt)) return true;
  if (isRecord(task.command) && typeof task.command.shell === 'string') {
    return INPUT_PLACEHOLDER_RE.test(task.command.shell);
  }
  if (isRecord(task.command) && Array.isArray(task.command.argv)) {
    return task.command.argv.some(
      (arg) => typeof arg === 'string' && INPUT_PLACEHOLDER_RE.test(arg),
    );
  }
  return false;
}

function addFeature(
  features: Map<string, YamlCompatibilityFeature>,
  id: keyof typeof YAML_FEATURE_MIN_SDK,
): void {
  if (features.has(id)) return;
  features.set(id, {
    id,
    minSdkVersion: YAML_FEATURE_MIN_SDK[id],
    description: FEATURE_DESCRIPTIONS[id],
  });
}

function maxFeatureVersion(features: readonly YamlCompatibilityFeature[]): string | null {
  let max: string | null = null;
  for (const feature of features) max = maxVersion(max, feature.minSdkVersion);
  return max;
}

function maxVersion(a: string | null, b: string): string;
function maxVersion(a: string | null, b: string | null): string | null;
function maxVersion(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}

function declaredSdkRequirement(requires: unknown): ParsedSdkRequirement | null {
  if (!isRecord(requires) || typeof requires.sdk !== 'string') return null;
  return parseSdkRequirement(requires.sdk);
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function normalizeVersion(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = parseSemver(value);
  if (!parsed) return null;
  const prerelease = parsed.prerelease.length > 0 ? `-${parsed.prerelease.join('.')}` : '';
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${prerelease}`;
}

function readCurrentSdkVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parseSemver(parsed.version)) {
      return normalizeVersion(parsed.version) ?? SDK_PACKAGE_VERSION_FALLBACK;
    }
  } catch {
    // Fall through to the explicit fallback. This should only happen in
    // unusual test bundles that omit package.json.
  }
  return SDK_PACKAGE_VERSION_FALLBACK;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
