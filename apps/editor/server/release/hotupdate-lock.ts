export type HotupdateKind = 'editor' | 'sidecar' | 'opencode' | 'release';

export type HotupdateStatus =
  | { active: false }
  | { active: true; kind: HotupdateKind; startedAt: string };

let activeHotupdate: {
  kind: HotupdateKind;
  controller: AbortController;
  startedAt: string;
} | null = null;

export function tryBeginHotupdate(
  kind: HotupdateKind,
  controller: AbortController,
): { ok: true } | { ok: false; activeKind: HotupdateKind } {
  if (activeHotupdate) {
    return { ok: false, activeKind: activeHotupdate.kind };
  }
  activeHotupdate = { kind, controller, startedAt: new Date().toISOString() };
  return { ok: true };
}

export function endHotupdate(controller: AbortController): void {
  if (activeHotupdate?.controller === controller) {
    activeHotupdate = null;
  }
}

export function cancelHotupdate(kind: HotupdateKind): boolean {
  if (!activeHotupdate || activeHotupdate.kind !== kind) return false;
  activeHotupdate.controller.abort();
  return true;
}

export function getHotupdateStatus(): HotupdateStatus {
  if (!activeHotupdate) return { active: false };
  return {
    active: true,
    kind: activeHotupdate.kind,
    startedAt: activeHotupdate.startedAt,
  };
}
