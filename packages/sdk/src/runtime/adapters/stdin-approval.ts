import * as readline from 'readline';
import type { ApprovalGateway, ApprovalRequest } from '../../approval';

export interface StdinApprovalAdapter {
  readonly detach: () => void;
}

export function attachStdinApprovalAdapter(gateway: ApprovalGateway): StdinApprovalAdapter {
  const queue: ApprovalRequest[] = [];
  let processing = false;
  let rl: readline.Interface | null = null;

  function ensureReadline(): readline.Interface {
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, terminal: false });
    }
    return rl;
  }

  function readOneLine(): Promise<string> {
    return new Promise((resolvePromise) => {
      const reader = ensureReadline();
      const handler = (line: string): void => {
        reader.off('line', handler);
        resolvePromise(line);
      };
      reader.on('line', handler);
    });
  }

  async function processNext(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const req = queue.shift()!;
        if (!gateway.pending().some((p) => p.id === req.id)) continue;

        process.stdout.write(
          `\n[APPROVAL REQUIRED] ${req.message}\n` +
            `  id:      ${req.id}\n` +
            `  task:    ${req.taskId}${req.trackId ? ` (track: ${req.trackId})` : ''}\n` +
            `  approve / reject > `,
        );

        const input = (await readOneLine()).trim().toLowerCase();

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
    }
  }

  const unsubscribe = gateway.subscribe((event) => {
    switch (event.type) {
      case 'requested':
        queue.push(event.request);
        void processNext();
        return;
      case 'resolved':
      case 'expired':
      case 'aborted': {
        const idx = queue.findIndex((r) => r.id === event.request.id);
        if (idx >= 0) queue.splice(idx, 1);
        return;
      }
    }
  });

  return {
    detach: () => {
      unsubscribe();
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };
}
