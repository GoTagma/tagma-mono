import { randomUUID } from 'crypto';
import { nowISO } from './utils';

// Approval types (ApprovalRequest, ApprovalDecision, ApprovalOutcome,
// ApprovalEvent, ApprovalListener, ApprovalGateway) live in the shared
// @tagma/types package so trigger plugins can import them without
// depending on the engine's runtime implementation. This module keeps
// only the in-memory implementation. Internal SDK imports go through
// ./types (the engine-side re-export) for consistency with the rest of
// the SDK source.
import type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalEvent,
  ApprovalListener,
  ApprovalGateway,
  ApprovalRequestHandle,
} from './types';

// Re-export for existing engine-side consumers that import from this file.
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalEvent,
  ApprovalListener,
  ApprovalGateway,
  ApprovalRequestHandle,
} from './types';

// ═══ Default In-Memory Implementation ═══

interface PendingEntry {
  readonly request: ApprovalRequest;
  readonly settle: (decision: ApprovalDecision) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

export class InMemoryApprovalGateway implements ApprovalGateway {
  private readonly pendingMap = new Map<string, PendingEntry>();
  private readonly listeners = new Set<ApprovalListener>();

  request(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequestHandle {
    const full: ApprovalRequest = {
      id: randomUUID(),
      createdAt: nowISO(),
      runId: req.runId,
      taskId: req.taskId,
      trackId: req.trackId,
      message: req.message,
      timeoutMs: req.timeoutMs,
      metadata: req.metadata,
    };

    const decision = new Promise<ApprovalDecision>((resolvePromise) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (full.timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.pendingMap.get(full.id);
          if (!entry) return;
          this.pendingMap.delete(full.id);
          const decision: ApprovalDecision = {
            approvalId: full.id,
            outcome: 'timeout',
            reason: `Approval timed out after ${full.timeoutMs}ms`,
            decidedAt: nowISO(),
          };
          this.emit({ type: 'expired', request: full });
          resolvePromise(decision);
        }, full.timeoutMs);
      }

      this.pendingMap.set(full.id, { request: full, settle: resolvePromise, timer });
      this.emit({ type: 'requested', request: full });
    });

    return {
      request: full,
      decision,
      abort: (reason: string) => {
        const entry = this.pendingMap.get(full.id);
        if (!entry) return;
        this.pendingMap.delete(full.id);
        if (entry.timer) clearTimeout(entry.timer);
        this.emit({ type: 'aborted', request: full, reason });
        entry.settle({
          approvalId: full.id,
          outcome: 'aborted',
          reason,
          decidedAt: nowISO(),
        });
      },
    };
  }

  resolve(
    approvalId: string,
    decision: Omit<ApprovalDecision, 'approvalId' | 'decidedAt'>,
  ): boolean {
    const entry = this.pendingMap.get(approvalId);
    if (!entry) return false;
    this.pendingMap.delete(approvalId);
    if (entry.timer) clearTimeout(entry.timer);

    const full: ApprovalDecision = {
      approvalId,
      outcome: decision.outcome,
      actor: decision.actor,
      reason: decision.reason,
      decidedAt: nowISO(),
    };
    this.emit({ type: 'resolved', request: entry.request, decision: full });
    entry.settle(full);
    return true;
  }

  pending(): readonly ApprovalRequest[] {
    return Array.from(this.pendingMap.values()).map((e) => e.request);
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  abortAll(reason: string): void {
    this.abortEntries(Array.from(this.pendingMap.entries()), reason);
  }

  abortRun(runId: string, reason: string): void {
    const entries = Array.from(this.pendingMap.entries()).filter(
      ([, entry]) => entry.request.runId === runId,
    );
    this.abortEntries(entries, reason);
  }

  private abortEntries(entries: readonly (readonly [string, PendingEntry])[], reason: string): void {
    for (const [id, entry] of entries) {
      this.pendingMap.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      this.emit({ type: 'aborted', request: entry.request, reason });
      entry.settle({
        approvalId: id,
        outcome: 'aborted',
        reason,
        decidedAt: nowISO(),
      });
    }
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[approval gateway] listener error:', err);
      }
    }
  }
}

export function scopeApprovalGateway(gateway: ApprovalGateway, runId: string): ApprovalGateway {
  return {
    request(req) {
      return gateway.request({ ...req, runId });
    },
    resolve(approvalId, decision) {
      return gateway.resolve(approvalId, decision);
    },
    pending() {
      return gateway.pending().filter((request) => request.runId === runId);
    },
    subscribe(listener) {
      return gateway.subscribe((event) => {
        if (event.request.runId === runId) listener(event);
      });
    },
    abortRun(targetRunId, reason) {
      if (targetRunId !== runId) return;
      if (gateway.abortRun) {
        gateway.abortRun(runId, reason);
      } else {
        gateway.abortAll(reason);
      }
    },
    abortAll(reason) {
      if (gateway.abortRun) {
        gateway.abortRun(runId, reason);
      } else {
        gateway.abortAll(reason);
      }
    },
  };
}
