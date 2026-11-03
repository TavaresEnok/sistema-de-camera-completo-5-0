import type { MotionNotice } from './motion-notices';

const active = new Map<string, Notification>();

export function closeDesktopNoticesForCamera(cameraId: string) {
  for (const [tag, notice] of active) if (tag.endsWith(`:${cameraId}`)) {
    notice.close(); active.delete(tag);
  }
}

export function desktopNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window;
}

export function closeDesktopNotices() {
  for (const notice of active.values()) notice.close();
  active.clear();
}

/** Notification clicks preserve the current URL and use the existing camera dialog. */
export function showDesktopDetection(notice: MotionNotice, userId: string, onOpen: (notice: MotionNotice) => void, description: string): boolean {
  if (!desktopNotificationsSupported() || Notification.permission !== 'granted' || !document.hidden) return false;
  const tag = `s2cam:detection:${userId}:${notice.cameraId}`;
  try {
    active.get(tag)?.close();
    const notification = new Notification(`S2Cam — ${notice.cameraName}`, {
      body: `${description} Clique para ver a câmera ao vivo.`,
      tag, silent: true, requireInteraction: true,
    });
    active.set(tag, notification);
    notification.onclose = () => { if (active.get(tag) === notification) active.delete(tag); };
    notification.onclick = () => {
      // Preserve the browser's default notification-click focus behavior too.
      window.focus();
      onOpen(notice);
      notification.close();
    };
    return true;
  } catch { return false; }
}
