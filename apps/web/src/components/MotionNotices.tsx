import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { Radar, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { getApiBaseUrl } from '../lib/api-base';
import { detectionNoticeMessage, selectMotionNotices, type MotionNotice } from '../lib/motion-notices';

/** Mounted once, outside page layouts (including retained live layouts). */
export function MotionNotices() {
  const token = useAuthStore(s => s.accessToken);
  const enabled = useVmsDataStore(s => s.cameras.some(c => c.enabled !== false && (c.motionNoticeEnabled || c.objectNoticeEnabled)));
  const [notices, setNotices] = useState<MotionNotice[]>([]);
  const [portal, setPortal] = useState<Element>(() => document.fullscreenElement ?? document.body);

  useEffect(() => {
    const update = () => setPortal(document.fullscreenElement ?? document.body);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    setNotices([]);
    if (!token || !enabled) return;
    let cancelled = false;
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const seen = new Set<string>();
    const lastByCamera = new Map<string, number>();
    const poll = async () => {
      try {
        if (document.visibilityState !== 'visible') { cursor = undefined; return; }
        const { data } = await axios.get<{ items: MotionNotice[]; cursor: string }>(`${getApiBaseUrl()}/cameras/detection-notices`, {
          params: { since: cursor }, headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, timeout: 10_000,
        });
        if (cancelled) return;
        cursor = data.cursor;
        const incoming = selectMotionNotices(data.items, seen, lastByCamera, Date.parse(data.cursor));
        if (incoming.length) setNotices(previous => [...incoming, ...previous].slice(0, 3));
      } catch { /* Network failure must not create alarming or technical messages. */ }
      finally { if (!cancelled) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [token, enabled]);

  useEffect(() => {
    if (!notices.length) return;
    const timer = setTimeout(() => setNotices([]), 6000);
    return () => clearTimeout(timer);
  }, [notices]);

  return createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2" role="status" aria-live="polite" aria-atomic="false">
      {notices.map(notice => (
        <div key={notice.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg">
          <Radar className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p className="min-w-0 flex-1 break-words text-sm">{detectionNoticeMessage(notice)}</p>
          <button type="button" aria-label="Fechar aviso" onClick={() => setNotices(previous => previous.filter(n => n.id !== notice.id))} className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>, portal,
  );
}
