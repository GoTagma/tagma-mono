export type TagmaSessionSource = 'desktop-chat' | 'bot-bridge' | 'platform-export';

export interface TagmaSessionModel {
  providerID: string;
  modelID: string;
}

export interface TagmaSessionMetadataInput {
  source: TagmaSessionSource;
  workspacePath?: string | null;
  yamlPath?: string | null;
  model?: TagmaSessionModel | null;
  /** OpenCode model variant; null explicitly selects the model/provider default. */
  variant?: string | null;
  reason?: string | null;
  title?: string | null;
  bot?: {
    platform?: string | null;
    chatID?: string | null;
  } | null;
  platformExport?: {
    sourceName?: string | null;
    sourcePlatform?: string | null;
    targetPlatform?: string | null;
  } | null;
}

export interface TagmaSessionMetadata {
  schema: number;
  source: TagmaSessionSource;
  workspacePath?: string;
  yamlPath?: string;
  model?: TagmaSessionModel;
  /** Present and null when the session explicitly uses the provider default. */
  variant?: string | null;
}

export interface OpencodeSessionOwnershipFields {
  directory?: unknown;
  metadata?: unknown;
  parentID?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isTagmaSessionSource(value: unknown): value is TagmaSessionSource {
  return value === 'desktop-chat' || value === 'bot-bridge' || value === 'platform-export';
}

export function normalizeOpencodeSessionPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function sameOpencodeSessionPath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeOpencodeSessionPath(left);
  const normalizedRight = normalizeOpencodeSessionPath(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

export function hasTagmaSessionMarker(metadata: unknown): boolean {
  return (
    isRecord(metadata) &&
    (hasOwn(metadata, 'tagma') ||
      hasOwn(metadata, 'tagmaSurface') ||
      hasOwn(metadata, 'tagmaWorkspace'))
  );
}

export function parseTagmaSessionMetadata(metadata: unknown): TagmaSessionMetadata | null {
  if (!isRecord(metadata)) return null;

  if (hasOwn(metadata, 'tagma')) {
    if (!isRecord(metadata.tagma)) return null;
    const tagma = metadata.tagma;
    const schema = tagma.schema;
    const source = tagma.source;
    if (
      typeof schema !== 'number' ||
      !Number.isInteger(schema) ||
      schema < 1 ||
      !isTagmaSessionSource(source)
    ) {
      return null;
    }
    const workspacePath =
      typeof tagma.workspacePath === 'string' && tagma.workspacePath.trim()
        ? tagma.workspacePath.trim()
        : undefined;
    const yamlPath =
      typeof tagma.yamlPath === 'string' && tagma.yamlPath.trim()
        ? tagma.yamlPath.trim()
        : undefined;
    const rawModel = tagma.model;
    const providerID = isRecord(rawModel) ? rawModel.providerID : undefined;
    const modelID = isRecord(rawModel) ? rawModel.modelID : undefined;
    const model =
      typeof providerID === 'string' &&
      providerID.trim() &&
      typeof modelID === 'string' &&
      modelID.trim()
        ? { providerID: providerID.trim(), modelID: modelID.trim() }
        : undefined;
    const variant =
      tagma.variant === null
        ? null
        : typeof tagma.variant === 'string' && tagma.variant.trim()
          ? tagma.variant.trim()
          : undefined;
    return {
      schema,
      source,
      ...(workspacePath ? { workspacePath } : {}),
      ...(yamlPath ? { yamlPath } : {}),
      ...(model ? { model } : {}),
      ...(variant !== undefined ? { variant } : {}),
    };
  }

  // Early desktop builds stored ownership fields flat on `metadata`.
  // Schema 0 is an in-memory compatibility marker; new writes always use
  // the nested schema-1 envelope built by buildTagmaSessionMetadata().
  const source = metadata.tagmaSurface;
  if (!isTagmaSessionSource(source)) return null;
  const workspacePath =
    typeof metadata.tagmaWorkspace === 'string' && metadata.tagmaWorkspace.trim()
      ? metadata.tagmaWorkspace.trim()
      : undefined;
  return { schema: 0, source, ...(workspacePath ? { workspacePath } : {}) };
}

export function isWorkspaceRootOpencodeSession(
  value: unknown,
  directory: string,
  workspaceKey: string,
): boolean {
  if (!isRecord(value)) return false;
  const fields = value as OpencodeSessionOwnershipFields;
  if (fields.parentID) return false;

  const inManagedDirectory = sameOpencodeSessionPath(fields.directory, directory);
  if (!hasTagmaSessionMarker(fields.metadata)) return inManagedDirectory;

  const tagma = parseTagmaSessionMetadata(fields.metadata);
  if (!tagma || (tagma.source !== 'desktop-chat' && tagma.source !== 'bot-bridge')) return false;
  return tagma.workspacePath
    ? sameOpencodeSessionPath(tagma.workspacePath, workspaceKey)
    : inManagedDirectory;
}

function putString(target: Record<string, unknown>, key: string, value: string | null | undefined) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed) target[key] = trimmed;
}

export function buildTagmaSessionMetadata(
  input: TagmaSessionMetadataInput,
): Record<string, unknown> {
  const tagma: Record<string, unknown> = {
    schema: 1,
    source: input.source,
  };

  putString(tagma, 'workspacePath', input.workspacePath);
  putString(tagma, 'yamlPath', input.yamlPath);
  putString(tagma, 'reason', input.reason);
  putString(tagma, 'title', input.title);

  if (input.model?.providerID && input.model.modelID) {
    tagma.model = {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
    };
  }
  if (input.variant === null) tagma.variant = null;
  else putString(tagma, 'variant', input.variant);

  if (input.bot) {
    const bot: Record<string, unknown> = {};
    putString(bot, 'platform', input.bot.platform);
    putString(bot, 'chatID', input.bot.chatID);
    if (Object.keys(bot).length > 0) tagma.bot = bot;
  }

  if (input.platformExport) {
    const platformExport: Record<string, unknown> = {};
    putString(platformExport, 'sourceName', input.platformExport.sourceName);
    putString(platformExport, 'sourcePlatform', input.platformExport.sourcePlatform);
    putString(platformExport, 'targetPlatform', input.platformExport.targetPlatform);
    if (Object.keys(platformExport).length > 0) tagma.platformExport = platformExport;
  }

  return { tagma };
}
