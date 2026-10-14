import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { Maximize2, Minimize2, Radar, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { getApiBaseUrl } from '../lib/api-base';
import { detectionNoticeMessage, selectMotionNotices, type MotionNotice } from '../lib/motion-notices';
import { tocarSomDeAtencao } from '../lib/alert-sound';
import { useDetectionActivityStore } from '../store/detectionActivityStore';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { LiveStreamPlayer } from './LiveStreamPlayer';
import { Button } from './ui/button';

/** Mounted once, outside page layouts (including retained live layouts). */
export function MotionNotices() {
  const token = useAuthStore(s => s.accessToken);
  const initialPassword = useAuthStore(s => s.user?.mustChangePassword);
  const userId = useAuthStore(s => s.user?.id);
  const [preview, setPreview] = useState<MotionNotice | null>(null);
  const previewCamera = useVmsDataStore(s => s.cameras.find(c => c.id === preview?.cameraId));
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const enabled = useVmsDataStore(s => s.cameras.some(c => c.enabled !== false && (c.motionNoticeEnabled || c.objectNoticeEnabled)));
  const [notices, setNotices] = useState<MotionNotice[]>([]);
  const [portal, setPortal] = useState<HTMLElement>(() => document.fullscreenElement as HTMLElement ?? document.body);

  useEffect(() => {
    const update = () => {
      const fullscreen = document.fullscreenElement;
      const ownFullscreen = fullscreen === previewRef.current && fullscreen !== null;
      setPreviewFullscreen(ownFullscreen);
      // Keep the portal's parent stable when THIS dialog enters fullscreen.
      if (!ownFullscreen) setPortal(fullscreen as HTMLElement ?? document.body);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => { setPreview(null); useDetectionActivityStore.getState().reset(); }, [userId]);
  useEffect(() => {
    if (!token || initialPassword || !previewCamera || previewCamera.canViewContent === false) setPreview(null);
  }, [token, initialPassword, previewCamera]);

  const closePreview = () => {
    if (document.fullscreenElement === previewRef.current) void document.exitFullscreen().catch(() => undefined);
    setPreview(null);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement === previewRef.current) void document.exitFullscreen().catch(() => undefined);
    else void previewRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  useEffect(() => {
    setNotices([]);
    if (!token || !enabled || initialPassword) return;
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
        // Highlight all recent events, independently of toast throttling/limit.
        const now = Date.parse(data.cursor);
        for (const item of data.items) {
          const occurred = Date.parse(item.occurredAt);
          if (Number.isFinite(occurred) && occurred <= now + 1000 && now - occurred <= 5000) useDetectionActivityStore.getState().mark(item.cameraId);
        }
        const incoming = selectMotionNotices(data.items, seen, lastByCamera, Date.parse(data.cursor));
        if (incoming.length) {
          // Um som por lote: três câmeras detectadas no mesmo ciclo não viram ruído.
          tocarSomDeAtencao();
          setNotices(previous => [...incoming, ...previous].slice(0, 3));
        }
      } catch { /* Network failure must not create alarming or technical messages. */ }
      finally { if (!cancelled) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [token, enabled, initialPassword]);

  useEffect(() => {
    if (!notices.length) return;
    const timer = setTimeout(() => setNotices([]), 6000);
    return () => clearTimeout(timer);
  }, [notices]);

  return <>{createPortal(
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 max-w-[calc(100vw-2.5rem)] flex-col gap-2" role="status" aria-live="polite" aria-atomic="false">
      {notices.map(notice => (
        <div key={notice.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg">
          <Radar className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <button type="button" aria-label={`Abrir câmera ${notice.cameraName}`} onClick={() => setPreview(notice)} className="min-w-0 flex-1 rounded text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="block break-words">{detectionNoticeMessage(notice)}</span>
            <span className="mt-1 block text-xs text-muted-foreground">Ver câmera</span>
          </button>
          <button type="button" aria-label="Fechar aviso" onClick={() => setNotices(previous => previous.filter(n => n.id !== notice.id))} className="rounded p-1 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>, portal,
  )}
    <Dialog open={Boolean(preview && previewCamera && previewCamera.canViewContent !== false && token && !initialPassword)} onOpenChange={open => { if (!open) closePreview(); }}>
      <DialogContent ref={previewRef} portalContainer={portal} data-detection-preview="true" className="flex max-h-[calc(100dvh-24px)] max-w-5xl flex-col gap-3 overflow-hidden p-4 sm:p-5">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="break-words text-base leading-snug">{previewCamera?.name ?? preview?.cameraName}</DialogTitle>
          <DialogDescription>{preview ? detectionNoticeMessage(preview) : ''} Vídeo ao vivo.</DialogDescription>
        </DialogHeader>
        {preview && previewCamera && previewCamera.canViewContent !== false && (
          <div className="min-h-0 flex-1 aspect-video overflow-hidden rounded-md bg-black">
            <LiveStreamPlayer key={preview.cameraId} cameraId={preview.cameraId} cameraName={previewCamera.name} className="h-full w-full" liveViewMode="selected" muted showAudioControl showEssentialStatus showOverlay={previewCamera.aiEnabled} aiEnabled={previewCamera.aiEnabled} />
          </div>
        )}
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={toggleFullscreen} className="gap-2">{previewFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}{previewFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}</Button>
          <Button type="button" onClick={closePreview}>Fechar câmera</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
