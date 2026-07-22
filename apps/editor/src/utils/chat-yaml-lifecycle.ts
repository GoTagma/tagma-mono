export interface ChatYamlLifecycleCancellationGuard {
  stopIfRequested: () => Promise<boolean>;
  cleanupStarted: () => boolean;
}

export function createChatYamlLifecycleCancellationGuard(input: {
  isCancellationRequested: () => boolean;
  discardStage: () => Promise<void>;
  clearPostChatAction: () => void;
}): ChatYamlLifecycleCancellationGuard {
  let started = false;
  let cleanup: Promise<void> | null = null;

  return {
    async stopIfRequested() {
      if (!input.isCancellationRequested()) return false;
      if (!cleanup) {
        started = true;
        cleanup = (async () => {
          try {
            await input.discardStage();
          } finally {
            input.clearPostChatAction();
          }
        })();
      }
      await cleanup;
      return true;
    },
    cleanupStarted: () => started,
  };
}
