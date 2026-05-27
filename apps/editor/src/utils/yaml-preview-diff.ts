import yaml from 'js-yaml';
import type { RawPipelineConfig } from '../api/client';

export type YamlPreviewChangeSource = 'editor' | 'chat';

export type YamlDiffLineKind = 'context' | 'add' | 'remove';

export interface YamlDiffLine {
  kind: YamlDiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface YamlDiffHunk {
  oldStart: number;
  oldLineCount: number;
  newStart: number;
  newLineCount: number;
  lines: YamlDiffLine[];
  oldSegment: string[];
  newSegment: string[];
}

export interface YamlPreviewBlock {
  id: string;
  source: YamlPreviewChangeSource;
  changedAt: number;
  hunk: YamlDiffHunk;
  layoutBefore?: Record<string, { x: number }>;
  layoutAfter?: Record<string, { x: number }>;
  layoutChanged?: boolean;
}

export type YamlPreviewTarget =
  | {
      kind: 'track';
      trackId: string;
    }
  | {
      kind: 'task';
      trackId: string;
      taskId: string;
      qualifiedId: string;
    };

export type FullYamlPreviewRow =
  | {
      kind: 'line';
      key: string;
      blockId: string | null;
      line: YamlDiffLine;
    }
  | {
      kind: 'block-header';
      key: string;
      block: YamlPreviewBlock;
    };

export function serializePreviewYaml(config: RawPipelineConfig): string {
  return yaml.dump({ pipeline: config }, { lineWidth: 120, indent: 2 });
}

export function parsePreviewYaml(content: string): RawPipelineConfig {
  const parsed = yaml.load(content) as { pipeline?: RawPipelineConfig } | null;
  if (!parsed?.pipeline) throw new Error('Invalid YAML preview content: missing pipeline root');
  return parsed.pipeline;
}

function splitYamlLines(text: string): string[] {
  if (text.length === 0) return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.length === 0 ? [] : body.split('\n');
}

function findNextMatchingLine(
  lines: string[],
  startIndex: number,
  endIndex: number,
  pattern: RegExp,
): number {
  for (let i = startIndex; i < endIndex; i += 1) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

export function buildYamlPreviewLineTargets(
  config: RawPipelineConfig,
): Map<number, YamlPreviewTarget> {
  const lines = splitYamlLines(serializePreviewYaml(config));
  const targets = new Map<number, YamlPreviewTarget>();
  const trackStarts: Array<{ trackIndex: number; lineIndex: number }> = [];
  const tracksLine = findNextMatchingLine(lines, 0, lines.length, /^ {2}tracks:/);
  if (tracksLine < 0) return targets;
  let trackCursor = tracksLine + 1;

  for (let trackIndex = 0; trackIndex < config.tracks.length; trackIndex += 1) {
    const lineIndex = findNextMatchingLine(lines, trackCursor, lines.length, /^ {4}- /);
    if (lineIndex < 0) break;
    trackStarts.push({ trackIndex, lineIndex });
    trackCursor = lineIndex + 1;
  }

  for (let i = 0; i < trackStarts.length; i += 1) {
    const { trackIndex, lineIndex: trackStart } = trackStarts[i];
    const track = config.tracks[trackIndex];
    const trackEnd = trackStarts[i + 1]?.lineIndex ?? lines.length;
    const trackTarget: YamlPreviewTarget = { kind: 'track', trackId: track.id };

    for (let lineIndex = trackStart; lineIndex < trackEnd; lineIndex += 1) {
      targets.set(lineIndex + 1, trackTarget);
    }

    const taskStarts: Array<{ taskIndex: number; lineIndex: number }> = [];
    const tasksLine = findNextMatchingLine(lines, trackStart + 1, trackEnd, /^ {6}tasks:/);
    if (tasksLine < 0) continue;
    let taskCursor = tasksLine + 1;
    for (let taskIndex = 0; taskIndex < track.tasks.length; taskIndex += 1) {
      const taskStart = findNextMatchingLine(lines, taskCursor, trackEnd, /^ {8}- /);
      if (taskStart < 0) break;
      taskStarts.push({ taskIndex, lineIndex: taskStart });
      taskCursor = taskStart + 1;
    }

    for (let taskStartIndex = 0; taskStartIndex < taskStarts.length; taskStartIndex += 1) {
      const { taskIndex, lineIndex: taskStart } = taskStarts[taskStartIndex];
      const task = track.tasks[taskIndex];
      const taskEnd = taskStarts[taskStartIndex + 1]?.lineIndex ?? trackEnd;
      const taskTarget: YamlPreviewTarget = {
        kind: 'task',
        trackId: track.id,
        taskId: task.id,
        qualifiedId: `${track.id}.${task.id}`,
      };

      for (let lineIndex = taskStart; lineIndex < taskEnd; lineIndex += 1) {
        targets.set(lineIndex + 1, taskTarget);
      }
    }
  }

  return targets;
}

function joinYamlLines(lines: string[], trailingNewline: boolean): string {
  const body = lines.join('\n');
  return trailingNewline ? `${body}\n` : body;
}

function diffLines(before: string[], after: string[]): YamlDiffLine[] {
  const m = before.length;
  const n = after.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: YamlDiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < m || j < n) {
    if (i < m && j < n && before[i] === after[j]) {
      out.push({ kind: 'context', text: before[i], oldLine, newLine });
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
    } else if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push({ kind: 'remove', text: before[i], oldLine, newLine: null });
      i += 1;
      oldLine += 1;
    } else if (j < n) {
      out.push({ kind: 'add', text: after[j], oldLine: null, newLine });
      j += 1;
      newLine += 1;
    }
  }
  return out;
}

function buildHunk(lines: YamlDiffLine[]): YamlDiffHunk {
  const oldLines = lines.filter((line) => line.kind !== 'add');
  const newLines = lines.filter((line) => line.kind !== 'remove');
  const oldStart = oldLines[0]?.oldLine ?? lines[0]?.oldLine ?? 1;
  const newStart = newLines[0]?.newLine ?? lines[0]?.newLine ?? 1;
  return {
    oldStart,
    oldLineCount: oldLines.length,
    newStart,
    newLineCount: newLines.length,
    lines,
    oldSegment: oldLines.map((line) => line.text),
    newSegment: newLines.map((line) => line.text),
  };
}

export function buildYamlDiffHunks(
  beforeYaml: string,
  afterYaml: string,
  contextSize = 2,
): YamlDiffHunk[] {
  const lines = diffLines(splitYamlLines(beforeYaml), splitYamlLines(afterYaml));
  const ranges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].kind === 'context') continue;
    const start = Math.max(0, i - contextSize);
    const end = Math.min(lines.length - 1, i + contextSize);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range) => buildHunk(lines.slice(range.start, range.end + 1)));
}

function hunkSignature(hunk: YamlDiffHunk): string {
  return [
    hunk.oldStart,
    hunk.oldLineCount,
    hunk.newStart,
    hunk.newLineCount,
    hunk.oldSegment.join('\n'),
    hunk.newSegment.join('\n'),
  ].join('\0');
}

function hunkNewRange(hunk: YamlDiffHunk): { start: number; end: number } {
  const length = Math.max(hunk.newLineCount, 1);
  return { start: hunk.newStart, end: hunk.newStart + length - 1 };
}

function hunksTouch(a: YamlDiffHunk, b: YamlDiffHunk): boolean {
  const ar = hunkNewRange(a);
  const br = hunkNewRange(b);
  return ar.start <= br.end && br.start <= ar.end;
}

export function buildYamlPreviewBlocks(args: {
  baselineYaml: string;
  previousBlocks: YamlPreviewBlock[];
  beforeYaml: string;
  afterYaml: string;
  source: YamlPreviewChangeSource;
  changedAt: number;
  layoutBefore?: Record<string, { x: number }>;
  layoutAfter?: Record<string, { x: number }>;
  layoutChanged?: boolean;
}): YamlPreviewBlock[] {
  const nextHunks = buildYamlDiffHunks(args.baselineYaml, args.afterYaml);
  if (nextHunks.length === 0) return [];

  const operationHunks = buildYamlDiffHunks(args.beforeYaml, args.afterYaml);
  const previousBySignature = new Map(
    args.previousBlocks.map((block) => [hunkSignature(block.hunk), block]),
  );

  return nextHunks.map((hunk, index) => {
    const previous = previousBySignature.get(hunkSignature(hunk));
    const touched = operationHunks.some((op) => hunksTouch(hunk, op));
    if (previous && !touched) return { ...previous, hunk };
    return {
      id: previous?.id ?? `${args.changedAt}:${args.source}:${index}`,
      source: args.source,
      changedAt: args.changedAt,
      hunk,
      layoutBefore: args.layoutChanged ? args.layoutBefore : undefined,
      layoutAfter: args.layoutChanged ? args.layoutAfter : undefined,
      layoutChanged: args.layoutChanged,
    };
  });
}

function findSegment(lines: string[], segment: string[]): number {
  if (segment.length === 0) return -1;
  let found = -1;
  for (let i = 0; i <= lines.length - segment.length; i += 1) {
    let matches = true;
    for (let j = 0; j < segment.length; j += 1) {
      if (lines[i + j] !== segment[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (found !== -1) return -1;
    found = i;
  }
  return found;
}

export function revertYamlPreviewHunk(currentYaml: string, hunk: YamlDiffHunk): string | null {
  const currentLines = splitYamlLines(currentYaml);
  const start = findSegment(currentLines, hunk.newSegment);
  if (start < 0) return null;
  const nextLines = [
    ...currentLines.slice(0, start),
    ...hunk.oldSegment,
    ...currentLines.slice(start + hunk.newSegment.length),
  ];
  return joinYamlLines(nextLines, currentYaml.endsWith('\n'));
}

export function buildFullYamlPreviewRows(
  currentYaml: string,
  blocks: YamlPreviewBlock[],
): FullYamlPreviewRow[] {
  const rows: FullYamlPreviewRow[] = [];
  const lines = splitYamlLines(currentYaml);
  const sortedBlocks = [...blocks].sort((a, b) => {
    const delta = a.hunk.newStart - b.hunk.newStart;
    if (delta !== 0) return delta;
    return a.changedAt - b.changedAt;
  });
  let nextLineIndex = 0;

  for (const block of sortedBlocks) {
    const hunkStart = Math.max(0, block.hunk.newStart - 1);
    const hunkEnd = hunkStart + block.hunk.newLineCount;
    if (hunkStart < nextLineIndex) continue;

    for (let i = nextLineIndex; i < Math.min(hunkStart, lines.length); i += 1) {
      rows.push({
        kind: 'line',
        key: `context:${i + 1}`,
        blockId: null,
        line: { kind: 'context', text: lines[i], oldLine: null, newLine: i + 1 },
      });
    }

    rows.push({ kind: 'block-header', key: `header:${block.id}`, block });
    block.hunk.lines.forEach((line, index) => {
      rows.push({
        kind: 'line',
        key: `block:${block.id}:${index}`,
        blockId: block.id,
        line,
      });
    });
    nextLineIndex = Math.min(Math.max(hunkEnd, hunkStart), lines.length);
  }

  for (let i = nextLineIndex; i < lines.length; i += 1) {
    rows.push({
      kind: 'line',
      key: `context:${i + 1}`,
      blockId: null,
      line: { kind: 'context', text: lines[i], oldLine: null, newLine: i + 1 },
    });
  }

  return rows;
}
