import { create } from 'zustand';
import type { ConfirmInfo } from '../components/ConfirmModal';

// Global confirm-modal channel for callers that don't live inside App's
// component tree (e.g. DesktopWindowControls renders into the toolbar / title
// strip, not as an App child, so it can't reach App's local confirmInfo state).
// App subscribes to this store and renders the shared ConfirmModal.
interface UIStoreState {
  confirm: ConfirmInfo | null;
  requestConfirm: (info: ConfirmInfo) => void;
  dismissConfirm: () => void;
}

export const useUIStore = create<UIStoreState>((set) => ({
  confirm: null,
  requestConfirm: (info) => set({ confirm: info }),
  dismissConfirm: () => set({ confirm: null }),
}));
