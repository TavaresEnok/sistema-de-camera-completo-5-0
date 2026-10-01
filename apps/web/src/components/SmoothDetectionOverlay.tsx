/**
 * SmoothDetectionOverlay — as caixas de IA como componente PRÓPRIO.
 *
 * Motivo: o hook useSmoothTracks re-renderiza a 60 fps enquanto houver caixa
 * na tela. Se ele mora no LiveStreamPlayer, é o PLAYER inteiro (2000+ linhas
 * de JSX, grade, controles) que re-renderiza 60 vezes por segundo. Movendo o
 * hook para cá, o player só re-renderiza no ritmo do poller (2x/s) e este
 * componente — meia dúzia de divs — absorve sozinho o custo da animação.
 *
 * A matemática do posicionamento (letterbox object-contain × object-cover) é
 * a MESMA que estava inline no player, movida sem alteração, junto com o
 * getRenderedVideoRect.
 */
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import type { LiveDetection } from '../lib/live-detections-poller';
import { useSmoothTracks } from '../lib/use-smooth-tracks';

type VideoRefLike = { current: HTMLVideoElement | null };
type ContainerRefLike = { current: HTMLElement | null };

export function getRenderedVideoRect(
  video: HTMLVideoElement | null,
  containerWidth: number,
  containerHeight: number,
) {
  if (!video || containerWidth <= 0 || containerHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const videoWidth = video.videoWidth || 0;
  const videoHeight = video.videoHeight || 0;
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const objectFit = window.getComputedStyle(video).objectFit || 'contain';
  if (objectFit === 'fill') {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const scale = objectFit === 'cover'
    ? Math.max(containerWidth / videoWidth, containerHeight / videoHeight)
    : Math.min(containerWidth / videoWidth, containerHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function SmoothDetectionOverlay({
  detections,
  videoRef,
  containerRef,
}: {
  detections: LiveDetection[];
  videoRef: VideoRefLike;
  containerRef: ContainerRefLike;
}) {
  const visibleDetections = useMemo(() => detections.filter(d =>
    d.label !== 'motion' && !d.type.startsWith('MOTION')), [detections]);
  const smoothedDetections = useSmoothTracks(visibleDetections);
  const [geometry, setGeometry] = useState({ containerWidth: 0, containerHeight: 0,
    videoWidth: 320, videoHeight: 180, rect: { left: 0, top: 0, width: 0, height: 0 } });
  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    const update = () => {
      const containerWidth = container?.clientWidth ?? 0;
      const containerHeight = container?.clientHeight ?? 0;
      setGeometry({ containerWidth, containerHeight,
        videoWidth: video?.videoWidth || 320, videoHeight: video?.videoHeight || 180,
        rect: getRenderedVideoRect(video, containerWidth, containerHeight) });
    };
    update();
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (container) resize?.observe(container);
    if (video) resize?.observe(video);
    const mutations = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
    if (video) mutations?.observe(video, { attributes: true, attributeFilter: ['class', 'style'] });
    video?.addEventListener('resize', update);
    video?.addEventListener('loadedmetadata', update);
    window.addEventListener('resize', update);
    return () => {
      resize?.disconnect(); mutations?.disconnect();
      video?.removeEventListener('resize', update);
      video?.removeEventListener('loadedmetadata', update);
      window.removeEventListener('resize', update);
    };
  }, [videoRef, containerRef, visibleDetections.length > 0]);

  return (
    <>
      {smoothedDetections.map((detection) => {
        // MOVIMENTO NUNCA desenha caixa (decisão do dono do sistema — o MOG2
        // arma a gravação, não vira overlay). Mantido igual ao player.
        if (detection.label === 'motion' || detection.type.startsWith('MOTION')) return null;
        const [x1, y1, x2, y2] = detection.bbox;
        const fallbackVideoWidth = geometry.videoWidth;
        const fallbackVideoHeight = geometry.videoHeight;
        const frameWidth = detection.frameWidth && detection.frameWidth > 0 ? detection.frameWidth : fallbackVideoWidth;
        const frameHeight = detection.frameHeight && detection.frameHeight > 0 ? detection.frameHeight : fallbackVideoHeight;
        const { containerWidth, containerHeight } = geometry;
        let style: CSSProperties;
        if (containerWidth > 0 && containerHeight > 0) {
          const videoRect = geometry.rect;
          const leftPx = videoRect.left + (x1 / frameWidth) * videoRect.width;
          const topPx = videoRect.top + (y1 / frameHeight) * videoRect.height;
          const rightPx = videoRect.left + (x2 / frameWidth) * videoRect.width;
          const bottomPx = videoRect.top + (y2 / frameHeight) * videoRect.height;
          const visibleLeft = Math.max(0, Math.min(containerWidth, leftPx));
          const visibleTop = Math.max(0, Math.min(containerHeight, topPx));
          const visibleRight = Math.max(visibleLeft + 1, Math.min(containerWidth, rightPx));
          const visibleBottom = Math.max(visibleTop + 1, Math.min(containerHeight, bottomPx));
          style = {
            left: `${visibleLeft}px`,
            top: `${visibleTop}px`,
            width: `${visibleRight - visibleLeft}px`,
            height: `${visibleBottom - visibleTop}px`,
          };
        } else {
          const left = Math.max(0, Math.min(100, (x1 / frameWidth) * 100));
          const top = Math.max(0, Math.min(100, (y1 / frameHeight) * 100));
          const width = Math.max(1, Math.min(100 - left, ((x2 - x1) / frameWidth) * 100));
          const height = Math.max(1, Math.min(100 - top, ((y2 - y1) / frameHeight) * 100));
          style = { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` };
        }
        const isFace = detection.type.startsWith('FACE');
        const isTriangle = !isFace && detection.overlayMode === 'triangle';
        const label = detection.similarity != null
          ? `${detection.label} ${(detection.similarity * 100).toFixed(0)}%`
          : detection.confidence != null
            ? `${detection.label} ${(detection.confidence * 100).toFixed(0)}%`
            : detection.label;
        if (isTriangle) {
          return (
            <div key={detection.renderKey} className="pointer-events-none absolute z-30" style={style}>
              <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full">
                <span className="mx-auto block h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-[hsl(var(--status-warning)_/_0.9)] drop-shadow-[0_1px_1px_rgba(0,0,0,0.65)]" />
              </div>
            </div>
          );
        }
        return (
          <div
            key={detection.renderKey}
            className={`pointer-events-none absolute z-30 rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${
              isFace ? 'border-[hsl(var(--status-online))]' : 'border-[hsl(var(--status-warning))]'
            } ${detection.stationary ? 'border-dashed opacity-80' : ''}`}
            style={style}
          >
            <span
              className={`absolute -top-6 left-0 max-w-40 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-black ${
                isFace ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--status-warning))]'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </>
  );
}
