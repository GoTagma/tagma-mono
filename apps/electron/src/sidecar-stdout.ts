export interface SidecarReadyParser {
  push(chunk: Buffer | string): number | null;
}

export function createSidecarReadyParser(): SidecarReadyParser {
  let buffered = '';
  return {
    push(chunk: Buffer | string): number | null {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let readyPort: number | null = null;
      while (true) {
        const newlineIndex = buffered.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = buffered.slice(0, newlineIndex).replace(/\r$/, '');
        buffered = buffered.slice(newlineIndex + 1);
        const match = line.match(/^TAGMA_READY port=(\d+)$/);
        if (!match) continue;
        const port = Number(match[1]);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65535) {
          readyPort = port;
        }
      }
      return readyPort;
    },
  };
}
