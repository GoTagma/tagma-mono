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
