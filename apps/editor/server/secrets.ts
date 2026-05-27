import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { assertPipelineYamlPath, tagmaDirOf } from './pipeline-paths.js';
import { atomicWriteFileSync, errorMessage, isPathWithin } from './path-utils.js';

export type SecretScope = 'workspace' | 'pipeline';

export interface CredentialBackendInfo {
  platform: NodeJS.Platform;
  kind: 'macos-keychain' | 'windows-credential-manager' | 'linux-secret-service' | 'unsupported';
  available: boolean;
  message: string;
}

export interface CredentialBackend {
  info(): CredentialBackendInfo;
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string, label: string): void;
  delete(service: string, account: string): void;
}

export interface SecretEntry {
  id: string;
  envName: string;
  scope: SecretScope;
  pipelinePath: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SecretsManifest {
  version: 1;
  workspaceId: string;
  entries: SecretEntry[];
}

export interface SecretListEntry extends SecretEntry {
  hasValue: boolean;
}

export interface SecretsListResult {
  backend: CredentialBackendInfo;
  secrets: SecretListEntry[];
}

export interface SecretWriteInput {
  envName: unknown;
  value: unknown;
  pipelinePath?: unknown;
  description?: unknown;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET_VALUE_LENGTH = 8192;
const MANIFEST_VERSION = 1;
const CREDENTIAL_SERVICE_PREFIX = 'tagma-pipeline-secrets';
const POWERSHELL_NOT_FOUND_EXIT = 44;

function secretsManifestPath(workDir: string): string {
  return resolve(workDir, '.tagma', 'secrets.json');
}

function workspaceRelativePath(workDir: string, absPath: string): string {
  const root = resolve(workDir);
  const target = resolve(absPath);
  if (!isPathWithin(target, root)) {
    throw new Error('Path is outside the workspace directory.');
  }
  return relative(root, target).replace(/\\/g, '/');
}

function normalizePipelinePath(workDir: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('pipelinePath must be a string or null.');
  const raw = value.trim();
  if (!raw) return null;
  const abs = resolve(workDir, raw);
  const validated = assertPipelineYamlPath(workDir, abs, 'Secret pipeline binding');
  if (!existsSync(validated)) {
    throw new Error('Secret pipeline binding must point at an existing YAML file.');
  }
  return workspaceRelativePath(workDir, validated);
}

export function normalizeSecretEnvName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('envName must be a string.');
  const envName = value.trim();
  if (!ENV_NAME_RE.test(envName)) {
    throw new Error('Environment variable name must match /^[A-Za-z_][A-Za-z0-9_]*$/.');
  }
  return envName;
}

function normalizeDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('description must be a string or null.');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 240) throw new Error('description must be 240 characters or fewer.');
  return trimmed;
}

function normalizeSecretValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('value must be a string.');
  if (value.length === 0) throw new Error('Secret value must not be empty.');
  if (value.includes('\0')) throw new Error('Secret value must not contain null bytes.');
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    throw new Error(`Secret value must be ${MAX_SECRET_VALUE_LENGTH} characters or fewer.`);
  }
  return value;
}

function coerceEntry(raw: unknown): SecretEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' && value.id ? value.id : null;
  const envName =
    typeof value.envName === 'string' && ENV_NAME_RE.test(value.envName) ? value.envName : null;
  const pipelinePath =
    typeof value.pipelinePath === 'string' && value.pipelinePath ? value.pipelinePath : null;
  const scope = pipelinePath ? 'pipeline' : 'workspace';
  const createdAt =
    typeof value.createdAt === 'string' && value.createdAt
      ? value.createdAt
      : new Date(0).toISOString();
  const updatedAt =
    typeof value.updatedAt === 'string' && value.updatedAt ? value.updatedAt : createdAt;
  if (!id || !envName) return null;
  return {
    id,
    envName,
    scope,
    pipelinePath: scope === 'pipeline' ? pipelinePath : null,
    description:
      typeof value.description === 'string' && value.description ? value.description : null,
    createdAt,
    updatedAt,
  };
}

function readManifest(workDir: string, createIfMissing = false): SecretsManifest {
  const path = secretsManifestPath(workDir);
  if (!existsSync(path)) {
    return {
      version: MANIFEST_VERSION,
      workspaceId: createIfMissing ? randomUUID() : '',
      entries: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to read .tagma/secrets.json: ${errorMessage(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.tagma/secrets.json must contain a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;
  const workspaceId =
    typeof raw.workspaceId === 'string' && raw.workspaceId.trim()
      ? raw.workspaceId.trim()
      : createIfMissing
        ? randomUUID()
        : '';
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(coerceEntry).filter((entry): entry is SecretEntry => entry !== null)
    : [];
  return { version: MANIFEST_VERSION, workspaceId, entries };
}

function writeManifest(workDir: string, manifest: SecretsManifest): void {
  const dir = tagmaDirOf(workDir);
  mkdirSync(dir, { recursive: true });
  const body = {
    version: MANIFEST_VERSION,
    workspaceId: manifest.workspaceId,
    entries: manifest.entries
      .slice()
      .sort(
        (a, b) =>
          a.envName.localeCompare(b.envName) ||
          (a.pipelinePath ?? '').localeCompare(b.pipelinePath ?? ''),
      ),
  };
  atomicWriteFileSync(secretsManifestPath(workDir), JSON.stringify(body, null, 2) + '\n');
}

function credentialService(workDir: string, manifest: SecretsManifest): string {
  const workspacePathHash = createHash('sha256').update(resolve(workDir)).digest('hex');
  const stable = manifest.workspaceId || 'no-workspace-id';
  return `${CREDENTIAL_SERVICE_PREFIX}:${workspacePathHash}:${stable}`;
}

function secretLabel(entry: SecretEntry): string {
  return entry.pipelinePath
    ? `Tagma ${entry.envName} for ${entry.pipelinePath}`
    : `Tagma ${entry.envName} for workspace`;
}

function commandAvailable(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: 'ignore',
    });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const bundled = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return existsSync(bundled) ? bundled : 'powershell.exe';
}

function runCredentialCommand(
  command: string,
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;

public static class TagmaCredMan {
  public const int CRED_TYPE_GENERIC = 1;
  public const int CRED_PERSIST_LOCAL_MACHINE = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);

  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

$target = [string]$payload.target
$account = [string]$payload.account
$action = [string]$payload.action

if ($action -eq 'set') {
  $value = [string]$payload.value
  $bytes = [Text.Encoding]::Unicode.GetBytes($value)
  $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $cred = New-Object TagmaCredMan+CREDENTIAL
    $cred.Type = [TagmaCredMan]::CRED_TYPE_GENERIC
    $cred.TargetName = $target
    $cred.UserName = $account
    $cred.Persist = [TagmaCredMan]::CRED_PERSIST_LOCAL_MACHINE
    $cred.CredentialBlobSize = $bytes.Length
    $cred.CredentialBlob = $blob
    if (-not [TagmaCredMan]::CredWrite([ref]$cred, 0)) {
      throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
  }
  exit 0
}

if ($action -eq 'get') {
  $ptr = [IntPtr]::Zero
  if (-not [TagmaCredMan]::CredRead($target, [TagmaCredMan]::CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) { exit 44 }
    throw (New-Object ComponentModel.Win32Exception($code))
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][TagmaCredMan+CREDENTIAL])
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
    # Emit the raw UTF-16LE blob as base64. Writing the decoded string via
    # [Console]::Out.Write would re-encode through Windows PowerShell's OEM
    # console code page (Node reads stdout as UTF-8), corrupting any non-ASCII
    # secret on round-trip. base64 is ASCII-safe across every code page; the
    # Node side decodes it back to the exact stored bytes.
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  } finally {
    [TagmaCredMan]::CredFree($ptr)
  }
  exit 0
}

if ($action -eq 'delete') {
  if (-not [TagmaCredMan]::CredDelete($target, [TagmaCredMan]::CRED_TYPE_GENERIC, 0)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) { exit 44 }
    throw (New-Object ComponentModel.Win32Exception($code))
  }
  exit 0
}

throw "Unknown action: $action"
`;

function windowsCredentialRequest(
  action: 'get' | 'set' | 'delete',
  service: string,
  account: string,
  value?: string,
): string | null {
  const payload = JSON.stringify({
    action,
    target: `${service}:${account}`,
    account,
    ...(value !== undefined ? { value } : {}),
  });
  const result = runCredentialCommand(
    powershellPath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_CREDENTIAL_SCRIPT,
    ],
    payload,
  );
  if (result.status === POWERSHELL_NOT_FOUND_EXIT) return null;
  if (result.status !== 0 || result.error) {
    throw new Error(
      result.error?.message ||
        result.stderr.trim() ||
        `Windows Credential Manager exited ${result.status}`,
    );
  }
  if (action !== 'get') return null;
  // The script base64-encodes the raw UTF-16LE credential blob (see the
  // get branch in WINDOWS_CREDENTIAL_SCRIPT). Decode it back to the exact
  // string that was stored, independent of the console code page.
  const b64 = result.stdout.trim();
  return b64 ? Buffer.from(b64, 'base64').toString('utf16le') : '';
}

export function defaultCredentialBackend(): CredentialBackend {
  return {
    info(): CredentialBackendInfo {
      if (process.platform === 'darwin') {
        const available = existsSync('/usr/bin/security');
        return {
          platform: process.platform,
          kind: 'macos-keychain',
          available: false,
          message: available
            ? 'macOS Keychain writes are disabled until Tagma has a native keychain adapter that does not expose secrets in process arguments'
            : 'security command is unavailable',
        };
      }
      if (process.platform === 'win32') {
        return {
          platform: process.platform,
          kind: 'windows-credential-manager',
          available: true,
          message: 'Windows Credential Manager',
        };
      }
      if (process.platform === 'linux') {
        const available = commandAvailable('secret-tool', ['--version']);
        return {
          platform: process.platform,
          kind: 'linux-secret-service',
          available,
          message: available
            ? 'Linux Secret Service via secret-tool'
            : 'secret-tool is unavailable; install libsecret tools for OS-backed secrets',
        };
      }
      return {
        platform: process.platform,
        kind: 'unsupported',
        available: false,
        message: `No OS credential backend is configured for ${process.platform}`,
      };
    },
    get(service, account) {
      const info = this.info();
      if (!info.available) return null;
      if (process.platform === 'darwin') {
        const result = runCredentialCommand('/usr/bin/security', [
          'find-generic-password',
          '-a',
          account,
          '-s',
          service,
          '-w',
        ]);
        if (result.status !== 0 || result.error) return null;
        return result.stdout;
      }
      if (process.platform === 'win32') {
        return windowsCredentialRequest('get', service, account);
      }
      if (process.platform === 'linux') {
        const result = runCredentialCommand('secret-tool', [
          'lookup',
          'tagma.service',
          service,
          'tagma.account',
          account,
        ]);
        if (result.status !== 0 || result.error) return null;
        return result.stdout;
      }
      return null;
    },
    set(service, account, value, label) {
      const info = this.info();
      if (!info.available) throw new Error(info.message);
      if (process.platform === 'darwin') {
        throw new Error(info.message);
      }
      if (process.platform === 'win32') {
        windowsCredentialRequest('set', service, account, value);
        return;
      }
      if (process.platform === 'linux') {
        const result = runCredentialCommand(
          'secret-tool',
          ['store', '--label', label, 'tagma.service', service, 'tagma.account', account],
          value,
        );
        if (result.status !== 0 || result.error) {
          throw new Error(
            result.error?.message || result.stderr.trim() || 'Failed to write Secret Service item',
          );
        }
        return;
      }
      throw new Error(info.message);
    },
    delete(service, account) {
      const info = this.info();
      if (!info.available) return;
      if (process.platform === 'darwin') {
        runCredentialCommand('/usr/bin/security', [
          'delete-generic-password',
          '-a',
          account,
          '-s',
          service,
        ]);
        return;
      }
      if (process.platform === 'win32') {
        windowsCredentialRequest('delete', service, account);
        return;
      }
      if (process.platform === 'linux') {
        runCredentialCommand('secret-tool', [
          'clear',
          'tagma.service',
          service,
          'tagma.account',
          account,
        ]);
      }
    },
  };
}

export function listSecrets(
  workDir: string,
  backend: CredentialBackend = defaultCredentialBackend(),
): SecretsListResult {
  const manifest = readManifest(workDir, false);
  const service = manifest.workspaceId ? credentialService(workDir, manifest) : '';
  const backendInfo = backend.info();
  const secrets = manifest.entries.map((entry) => {
    let hasValue = false;
    if (service && backendInfo.available) {
      try {
        hasValue = backend.get(service, entry.id) !== null;
      } catch {
        hasValue = false;
      }
    }
    return { ...entry, hasValue };
  });
  return { backend: backendInfo, secrets };
}

export function upsertSecret(
  workDir: string,
  input: SecretWriteInput,
  backend: CredentialBackend = defaultCredentialBackend(),
): SecretEntry {
  const envName = normalizeSecretEnvName(input.envName);
  const value = normalizeSecretValue(input.value);
  const pipelinePath = normalizePipelinePath(workDir, input.pipelinePath);
  const description = normalizeDescription(input.description);
  const now = new Date().toISOString();
  const manifest = readManifest(workDir, true);
  const existing = manifest.entries.find(
    (entry) => entry.envName === envName && (entry.pipelinePath ?? null) === pipelinePath,
  );
  const entry: SecretEntry = existing
    ? { ...existing, description, updatedAt: now }
    : {
        id: randomUUID(),
        envName,
        scope: pipelinePath ? 'pipeline' : 'workspace',
        pipelinePath,
        description,
        createdAt: now,
        updatedAt: now,
      };
  const service = credentialService(workDir, manifest);
  backend.set(service, entry.id, value, secretLabel(entry));
  if (existing) {
    manifest.entries = manifest.entries.map((item) => (item.id === existing.id ? entry : item));
  } else {
    manifest.entries.push(entry);
  }
  writeManifest(workDir, manifest);
  return entry;
}

export function deleteSecret(
  workDir: string,
  id: string,
  backend: CredentialBackend = defaultCredentialBackend(),
): boolean {
  const manifest = readManifest(workDir, false);
  const entry = manifest.entries.find((item) => item.id === id);
  if (!entry) return false;
  if (manifest.workspaceId) {
    backend.delete(credentialService(workDir, manifest), entry.id);
  }
  manifest.entries = manifest.entries.filter((item) => item.id !== id);
  writeManifest(workDir, manifest);
  return true;
}

export function deletePipelineSecretBindings(
  workDir: string,
  yamlPath: string,
  backend: CredentialBackend = defaultCredentialBackend(),
): number {
  const manifest = readManifest(workDir, false);
  if (!manifest.workspaceId || manifest.entries.length === 0) return 0;
  const pipelinePath = workspaceRelativePath(
    workDir,
    assertPipelineYamlPath(workDir, yamlPath, 'Secret pipeline binding'),
  );
  const removed = manifest.entries.filter((entry) => entry.pipelinePath === pipelinePath);
  if (removed.length === 0) return 0;
  const service = credentialService(workDir, manifest);
  for (const entry of removed) {
    backend.delete(service, entry.id);
  }
  manifest.entries = manifest.entries.filter((entry) => entry.pipelinePath !== pipelinePath);
  writeManifest(workDir, manifest);
  return removed.length;
}

function secretAppliesToPipeline(entry: SecretEntry, pipelinePath: string): boolean {
  return entry.scope === 'workspace' || entry.pipelinePath === pipelinePath;
}

function entryPriority(entry: SecretEntry, pipelinePath: string): number {
  if (entry.pipelinePath === pipelinePath) return 2;
  if (entry.scope === 'workspace') return 1;
  return 0;
}

export function buildPipelineSecretEnv(
  workDir: string,
  yamlPath: string,
  envKeys?: readonly string[],
  backend: CredentialBackend = defaultCredentialBackend(),
): Record<string, string> {
  const info = backend.info();
  if (!info.available) return {};
  const manifest = readManifest(workDir, false);
  if (!manifest.workspaceId) return {};
  const pipelinePath = workspaceRelativePath(
    workDir,
    assertPipelineYamlPath(workDir, yamlPath, 'Secret pipeline binding'),
  );
  const requested = envKeys ? new Set(envKeys.filter((name) => ENV_NAME_RE.test(name))) : null;
  const selected = new Map<string, SecretEntry>();
  for (const entry of manifest.entries) {
    if (requested && !requested.has(entry.envName)) continue;
    if (!secretAppliesToPipeline(entry, pipelinePath)) continue;
    const current = selected.get(entry.envName);
    if (
      !current ||
      entryPriority(entry, pipelinePath) > entryPriority(current, pipelinePath) ||
      (entryPriority(entry, pipelinePath) === entryPriority(current, pipelinePath) &&
        entry.updatedAt > current.updatedAt)
    ) {
      selected.set(entry.envName, entry);
    }
  }
  const service = credentialService(workDir, manifest);
  const out: Record<string, string> = {};
  for (const entry of selected.values()) {
    const value = backend.get(service, entry.id);
    if (value !== null && value.length > 0) out[entry.envName] = value;
  }
  return out;
}
