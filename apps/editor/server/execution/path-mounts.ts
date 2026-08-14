import { realpath as realpathCallback } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

function nativeRealpath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpathCallback.native(path, (error, resolvedPath) => {
      if (error) reject(error);
      else resolve(resolvedPath);
    });
  });
}

export type PathDialect = 'posix' | 'win32';

export type PathMountErrorCode =
  | 'invalid-dialect'
  | 'invalid-mount'
  | 'mount-already-registered'
  | 'invalid-root'
  | 'unknown-mount'
  | 'invalid-path-ref'
  | 'outside-mount'
  | 'native-resolution-failed';

export class PathMountError extends Error {
  constructor(
    readonly code: PathMountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PathMountError';
  }
}

export interface PathRef {
  readonly mount: string;
  readonly segments: readonly string[];
}

export interface PathMountTableOptions {
  readonly dialect: PathDialect;
}

export class PathMountTable {
  private readonly dialect: PathDialect;
  private readonly path: typeof posix;
  private readonly mounts = new Map<string, string>();

  constructor(options: PathMountTableOptions) {
    if (options.dialect !== 'win32' && options.dialect !== 'posix') {
      throw new PathMountError('invalid-dialect', 'Path dialect must be win32 or posix');
    }
    this.dialect = options.dialect;
    this.path = options.dialect === 'win32' ? win32 : posix;
  }

  register(mount: string, root: string): this {
    this.validateMountName(mount);
    if (this.mounts.has(mount)) {
      throw new PathMountError(
        'mount-already-registered',
        `Path mount is already registered: ${mount}`,
      );
    }
    if (
      typeof root !== 'string' ||
      root.length === 0 ||
      root.includes('\0') ||
      !this.path.isAbsolute(root)
    ) {
      throw new PathMountError(
        'invalid-root',
        'Path mount root must be an absolute path without NUL bytes',
      );
    }
    this.mounts.set(mount, this.path.normalize(root));
    return this;
  }

  /**
   * Resolves dialect rules only. Use this while compiling a plan that may target
   * another host; resolve() adds only a best-effort native pre-I/O check.
   */
  resolveLexical(ref: PathRef): string {
    this.validatePathRef(ref);
    const root = this.mounts.get(ref.mount);
    if (root === undefined) {
      throw new PathMountError('unknown-mount', `Path mount is not registered: ${ref.mount}`);
    }
    for (const segment of ref.segments) {
      this.validateSegment(segment);
    }
    const resolved = this.path.normalize(this.path.join(root, ...ref.segments));
    if (!this.isWithin(root, resolved)) {
      throw new PathMountError('outside-mount', `Resolved path escapes mount: ${ref.mount}`);
    }
    return resolved;
  }

  /**
   * Performs a best-effort pre-I/O containment check against the deepest existing
   * ancestor's native real path. Because this returns a string, an ancestor can be
   * swapped after the check; this method is not an authorization or sandbox boundary.
   * Final WorkspaceFs operations must use handle-bound/no-follow access with post-open
   * containment verification, or rely on stronger backend isolation.
   */
  async resolve(ref: PathRef): Promise<string> {
    const resolved = this.resolveLexical(ref);
    if (!this.isNativeDialect()) return resolved;

    const root = this.mounts.get(ref.mount);
    if (root === undefined) {
      throw new PathMountError('unknown-mount', `Path mount is not registered: ${ref.mount}`);
    }
    await this.assertNativeContainment(root, resolved);
    return resolved;
  }

  /** Reverse mapping is lexical and does not establish filesystem authorization. */
  async toPathRef(hostPath: string): Promise<PathRef | null> {
    if (
      typeof hostPath !== 'string' ||
      hostPath.length === 0 ||
      hostPath.includes('\0') ||
      !this.path.isAbsolute(hostPath)
    ) {
      throw new PathMountError(
        'invalid-path-ref',
        'Host path must be an absolute path without NUL bytes',
      );
    }
    const normalized = this.path.normalize(hostPath);
    const matches = [...this.mounts.entries()]
      .filter(([, root]) => this.isWithin(root, normalized))
      .sort((left, right) => right[1].length - left[1].length);
    const match = matches[0];
    if (!match) return null;

    const [mount, root] = match;
    const relative = this.path.relative(root, normalized);
    const segments = relative === '' ? [] : relative.split(this.path.sep);
    for (const segment of segments) {
      this.validateSegment(segment);
    }
    return { mount, segments };
  }

  private validateSegment(segment: string): void {
    if (
      typeof segment !== 'string' ||
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0') ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      throw new PathMountError(
        'invalid-path-ref',
        'PathRef segments must be non-empty portable atomic path names',
      );
    }
    if (
      this.dialect === 'win32' &&
      (segment.includes(':') || /[. ]$/u.test(segment) || WINDOWS_RESERVED_NAME.test(segment))
    ) {
      throw new PathMountError(
        'invalid-path-ref',
        'PathRef segment is not a valid Windows path name',
      );
    }
  }

  private validateMountName(mount: string): void {
    if (
      typeof mount !== 'string' ||
      mount.length === 0 ||
      mount === '.' ||
      mount === '..' ||
      mount.includes('\0') ||
      mount.includes('/') ||
      mount.includes('\\')
    ) {
      throw new PathMountError(
        'invalid-mount',
        'Path mount name must be a non-empty logical identifier',
      );
    }
  }

  private validatePathRef(ref: PathRef): void {
    if (typeof ref !== 'object' || ref === null || !Array.isArray(ref.segments)) {
      throw new PathMountError(
        'invalid-path-ref',
        'PathRef must contain a mount and an array of segments',
      );
    }
    this.validateMountName(ref.mount);
  }

  private isWithin(root: string, candidate: string): boolean {
    const comparisonRoot = this.dialect === 'win32' ? root.toLowerCase() : root;
    const comparisonCandidate = this.dialect === 'win32' ? candidate.toLowerCase() : candidate;
    const relative = this.path.relative(comparisonRoot, comparisonCandidate);
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith(`..${this.path.sep}`) &&
        !this.path.isAbsolute(relative))
    );
  }

  private isNativeDialect(): boolean {
    return this.dialect === (process.platform === 'win32' ? 'win32' : 'posix');
  }

  private async assertNativeContainment(root: string, candidate: string): Promise<void> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await nativeRealpath(root);
    } catch {
      throw new PathMountError(
        'native-resolution-failed',
        `Registered path mount root cannot be resolved: ${root}`,
      );
    }

    const existingAncestor = await this.findExistingAncestor(root, candidate);
    let canonicalAncestor: string;
    try {
      canonicalAncestor = await nativeRealpath(existingAncestor);
    } catch {
      throw new PathMountError(
        'native-resolution-failed',
        `Existing path ancestor cannot be resolved: ${existingAncestor}`,
      );
    }
    if (!this.isWithin(canonicalRoot, canonicalAncestor)) {
      throw new PathMountError(
        'outside-mount',
        `Native path resolves outside registered mount: ${candidate}`,
      );
    }
  }

  private async findExistingAncestor(root: string, candidate: string): Promise<string> {
    let current = candidate;
    while (true) {
      try {
        await lstat(current);
        return current;
      } catch (error) {
        if (!this.isMissingPathError(error)) {
          throw new PathMountError(
            'native-resolution-failed',
            `Path ancestor cannot be inspected: ${current}`,
          );
        }
      }
      if (this.pathsEqual(current, root)) {
        throw new PathMountError(
          'native-resolution-failed',
          `Registered path mount root disappeared: ${root}`,
        );
      }
      const parent = this.path.dirname(current);
      if (this.pathsEqual(parent, current)) {
        throw new PathMountError(
          'native-resolution-failed',
          `No existing path ancestor remains inside mount: ${candidate}`,
        );
      }
      current = parent;
    }
  }

  private pathsEqual(left: string, right: string): boolean {
    return this.dialect === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private isMissingPathError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false;
    return error.code === 'ENOENT' || error.code === 'ENOTDIR';
  }
}
