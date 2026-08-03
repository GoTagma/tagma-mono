import * as readline from 'readline';
import type { ApprovalEvent, ApprovalGateway, ApprovalRequest } from '@tagma/core';

export interface StdinApprovalAdapter {
  readonly detach: () => void;
}

type ReadResult =
  | { readonly kind: 'line'; readonly line: string }
  | { readonly kind: 'eof'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string };

interface ActiveRead {
  readonly promise: Promise<ReadResult>;
  readonly cancel: (reason: string) => void;
}

export function attachStdinApprovalAdapter(gateway: ApprovalGateway): StdinApprovalAdapter {
  const queue: ApprovalRequest[] = [];
  let processing = false;
  let rl: readline.Interface | null = null;
  let activeRequest: ApprovalRequest | null = null;
  let activeRead: ActiveRead | null = null;
  let inputClosed = false;
  let detached = false;

  function ensureReadline(): readline.Interface {
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, terminal: false });
    }
    return rl;
  }

  function readOneLine(): ActiveRead {
    let settled = false;
    let reader: readline.Interface | null = null;
    let resolveRead!: (result: ReadResult) => void;

    const promise = new Promise<ReadResult>((resolvePromise) => {
      resolveRead = resolvePromise;
    });

    const cleanup = (): void => {
      if (!reader) return;
      reader.off('line', onLine);
      reader.off('close', onClose);
      reader.off('error', onError);
    };

    const finish = (result: ReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveRead(result);
    };

    const onLine = (line: string): void => {
      finish({ kind: 'line', line });
    };
    const onClose = (): void => {
      finish({ kind: 'eof', reason: 'stdin reached EOF' });
    };
    const onError = (): void => {
      finish({ kind: 'eof', reason: 'stdin could not be read' });
    };

    reader = ensureReadline();
    reader.on('line', onLine);
    reader.on('close', onClose);
    reader.on('error', onError);

    return {
      promise,
      cancel: (reason: string) => finish({ kind: 'cancelled', reason }),
    };
  }

  function isPending(req: ApprovalRequest): boolean {
    return gateway.pending().some((pending) => pending.id === req.id);
  }

  function rejectRequest(req: ApprovalRequest, reason: string): void {
    if (!isPending(req)) return;
    gateway.resolve(req.id, {
      outcome: 'rejected',
      actor: 'cli',
      reason,
    });
  }

  function rejectQueuedRequests(reason: string): void {
    const queued = queue.splice(0);
    for (const req of queued) rejectRequest(req, reason);
  }

  async function processNext(): Promise<void> {
    if (processing || detached || inputClosed) return;
    processing = true;
    try {
      while (queue.length > 0 && !detached && !inputClosed) {
        const req = queue.shift()!;
        if (!isPending(req)) continue;

        activeRequest = req;
        process.stdout.write(
          '\n[APPROVAL REQUIRED] ' +
            req.message +
            '\n' +
            '  id:      ' +
            req.id +
            '\n' +
            '  task:    ' +
            req.taskId +
            (req.trackId ? ' (track: ' + req.trackId + ')' : '') +
            '\n' +
            '  approve / reject > ',
        );

        const read = readOneLine();
        activeRead = read;
        const readResult = await read.promise;
        if (activeRead === read) activeRead = null;
        activeRequest = null;

        if (!isPending(req)) continue;

        if (readResult.kind === 'eof') {
          rejectRequest(req, readResult.reason);
          inputClosed = true;
          rejectQueuedRequests(readResult.reason);
          break;
        }

        if (readResult.kind === 'cancelled') {
          rejectRequest(req, readResult.reason);
          continue;
        }

        const input = readResult.line.trim().toLowerCase();

        const approveAliases = new Set(['approve', 'yes', 'y', 'ok', 'true', '1']);
        const rejectAliases = new Set(['reject', 'no', 'n', 'deny', 'false', '0']);

        if (approveAliases.has(input)) {
          gateway.resolve(req.id, { outcome: 'approved', actor: 'cli' });
        } else if (rejectAliases.has(input)) {
          gateway.resolve(req.id, {
            outcome: 'rejected',
            actor: 'cli',
            reason: 'user rejected via CLI',
          });
        } else {
          process.stdout.write(`  unrecognized input "${input}" - treating as rejection\n`);
          gateway.resolve(req.id, {
            outcome: 'rejected',
            actor: 'cli',
            reason: `unrecognized CLI input: ${input}`,
          });
        }
      }
    } finally {
      processing = false;
      activeRequest = null;
      activeRead = null;
    }
  }

  const unsubscribe = gateway.subscribe((event: ApprovalEvent) => {
    switch (event.type) {
      case 'requested':
        if (detached || inputClosed) {
          rejectRequest(event.request, detached ? 'stdin adapter detached' : 'stdin reached EOF');
          return;
        }
        queue.push(event.request);
        void processNext();
        return;
      case 'resolved':
      case 'expired':
      case 'aborted': {
        const idx = queue.findIndex((r) => r.id === event.request.id);
        if (idx >= 0) queue.splice(idx, 1);
        if (activeRequest?.id === event.request.id) {
          activeRead?.cancel('approval ' + event.type);
        }
        return;
      }
    }
  });

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      unsubscribe();
      activeRead?.cancel('stdin adapter detached');
      rejectQueuedRequests('stdin adapter detached');
      for (const req of gateway.pending()) {
        rejectRequest(req, 'stdin adapter detached');
      }
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };
}
