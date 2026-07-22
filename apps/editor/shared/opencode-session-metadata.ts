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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasTagmaSessionMarker(metadata: unknown): boolean {
  return isRecord(metadata) && Object.prototype.hasOwnProperty.call(metadata, 'tagma');
}

export function parseTagmaSessionMetadata(metadata: unknown): TagmaSessionMetadata | null {
  if (!isRecord(metadata) || !isRecord(metadata.tagma)) return null;
  const tagma = metadata.tagma;
  const schema = tagma.schema;
  const source = tagma.source;
  if (
    typeof schema !== 'number' ||
    !Number.isInteger(schema) ||
    schema < 1 ||
    (source !== 'desktop-chat' && source !== 'bot-bridge' && source !== 'platform-export')
  ) {
    return null;
  }
  const workspacePath =
    typeof tagma.workspacePath === 'string' && tagma.workspacePath.trim()
      ? tagma.workspacePath.trim()
      : undefined;
  return { schema, source, ...(workspacePath ? { workspacePath } : {}) };
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
