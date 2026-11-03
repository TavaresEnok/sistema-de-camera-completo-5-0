import { create } from 'zustand';

const key = (userId: string) => `s2cam.desktop-notices.${userId}`;

export const useDesktopNoticeStore = create<{
  userId: string | null; enabled: boolean;
  loadForUser: (userId: string | null) => void;
  setEnabled: (enabled: boolean) => void;
}>((set, get) => ({
  userId: null, enabled: false,
  loadForUser: userId => {
    if (get().userId === userId) return;
    let enabled = false;
    try { enabled = Boolean(userId && window.localStorage.getItem(key(userId)) === '1'); } catch { /* Session-only fallback. */ }
    set({ userId, enabled });
  },
  setEnabled: enabled => {
    const userId = get().userId;
    if (!userId) return;
    try { window.localStorage.setItem(key(userId), enabled ? '1' : '0'); } catch { /* Session-only fallback. */ }
    set({ enabled });
  },
}));
