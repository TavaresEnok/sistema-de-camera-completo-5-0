import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, type ImageStyle, StyleSheet, type StyleProp, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import { RTCPeerConnection, RTCSessionDescription, RTCView } from 'react-native-webrtc';
import type { LiveStatus } from './VideoPlayers';
import { discoverWhepIceServers } from '../services/whep-ice-servers';
import { webRtcSessionIdentity } from '../utils/webrtc-recovery';

const CONNECT_TIMEOUT_MS = 30_000;
const ICE_GATHER_TIMEOUT_MS = 2_000;
const MEDIA_STALL_TIMEOUT_MS = 15_000;
const MEDIA_WATCHDOG_INTERVAL_MS = 3_000;

// react-native-webrtc expõe addEventListener em runtime (EventTarget do event-target-shim),
// mas os tipos publicados não declaram. Tipamos só os eventos que usamos e fazemos cast.
type RtcAudioTrack = { kind: string; enabled: boolean };
type RtcMediaStream = { toURL: () => string; getAudioTracks?: () => RtcAudioTrack[] };
type RtcTrackEvent = { streams?: RtcMediaStream[] };
type PcEvents = {
  addEventListener(type: 'track', listener: (event: RtcTrackEvent) => void): void;
  addEventListener(type: 'connectionstatechange' | 'icegatheringstatechange', listener: () => void): void;
  removeEventListener(type: 'icegatheringstatechange', listener: () => void): void;
};

type WebRtcVideoProps = {
  whepUrl: string;
  posterUri?: string | null;
  videoStyle: StyleProp<ViewStyle>;
  posterStyle: StyleProp<ImageStyle>;
  emptyTextStyle: StyleProp<TextStyle>;
  onStatusChange?: (status: LiveStatus) => void;
  onFailover: (reason?: string) => void;
  muted?: boolean;
  contentFit?: 'contain' | 'cover';
  /** Informa se o stream recebido tem faixa de áudio (câmeras sem microfone → false). */
  onAudioAvailable?: (available: boolean) => void;
  onNeedRefresh?: () => void;
};

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const ev = pc as unknown as PcEvents;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ev.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    ev.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Player WebRTC ao vivo (recvonly) via WHEP, conectando direto no MediaMTX — mesma
 * estratégia do web. Se não conectar (timeout/erro), chama onFailover para o pai cair
 * para HLS. Renderiza o MediaStream com RTCView do react-native-webrtc.
 */
export function WebRtcVideo({
  whepUrl,
  posterUri,
  videoStyle,
  posterStyle,
  emptyTextStyle,
  onStatusChange,
  onFailover,
  muted = false,
  contentFit = 'contain',
  onAudioAvailable,
  onNeedRefresh,
}: WebRtcVideoProps) {
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const liveRef = useRef(false);
  const streamRef = useRef<RtcMediaStream | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const sessionIdentity = webRtcSessionIdentity(whepUrl);

  // Aplica o estado de mudo à trilha de áudio recebida (botão "Áudio").
  const applyMuted = (stream: RtcMediaStream | null) => {
    try {
      stream?.getAudioTracks?.().forEach((track) => { track.enabled = !mutedRef.current; });
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    applyMuted(streamRef.current);
  }, [muted]);
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const onFailoverRef = useRef(onFailover);
  onFailoverRef.current = onFailover;
  const onAudioRef = useRef(onAudioAvailable);
  onAudioRef.current = onAudioAvailable;
  const onNeedRefreshRef = useRef(onNeedRefresh);
  onNeedRefreshRef.current = onNeedRefresh;

  const apply = (next: LiveStatus) => {
    setStatus(next);
    onStatusRef.current?.(next);
    liveRef.current = next === 'live';
  };

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let pc: RTCPeerConnection | null = null;
    let sessionUrl: string | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
    let mediaWatchdog: ReturnType<typeof setInterval> | undefined;
    let appActive = AppState.currentState === 'active';
    let connectionLost = false;
    let connectionReady = false;
    let mediaReady = false;
    let mediaToken: string | null = null;
    try { mediaToken = new URL(whepUrl).searchParams.get('token'); } catch { /* URL inválida cairá no failover */ }

    const failover = (reason?: string) => {
      if (cancelled) return;
      cancelled = true;
      apply('offline');
      onNeedRefreshRef.current?.();
      onFailoverRef.current?.(reason);
    };

    const start = async () => {
      apply('connecting');
      timeout = setTimeout(() => {
        if (!cancelled && !liveRef.current) failover('Tempo esgotado sem receber vídeo por WebRTC (30 s).');
      }, CONNECT_TIMEOUT_MS);
      try {
        // MediaMTX anuncia as credenciais TURN temporárias no Link do OPTIONS
        // WHEP. Sem lê-lo, o app só enxerga o candidato privado 10.10.0.x e
        // falha em toda instalação atrás da Gateway/NAT.
        const authorization = mediaToken ? `Bearer ${mediaToken}` : null;
        const iceServers = await discoverWhepIceServers(whepUrl, authorization, abort.signal);
        if (cancelled) return;
        pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        // ICE "connected" não garante vídeo avançando. Algumas quedas de NAT,
        // encoder ou relay deixam a sessão viva com a última imagem congelada.
        // Só frames decodificados confirmam vídeo e sustentam a sessão.
        let lastMediaProgressAt = Date.now();
        let lastFrames = -1;
        let statsPolling = false;
        mediaWatchdog = setInterval(() => {
          if (cancelled || !pc || !connectionReady || !appActive || statsPolling) return;
          statsPolling = true;
          void pc.getStats().then((stats: any) => {
            if (cancelled) return;
            let frames = 0;
            let found = false;
            stats?.forEach?.((report: any) => {
              if (report?.type === 'inbound-rtp' && report?.kind === 'video' && !report?.isRemote) {
                found = true;
                frames += Number(report.framesDecoded || 0);
              }
            });
            if (!found) return;
            if (frames > 0 && mediaReady && !liveRef.current) {
              if (timeout) clearTimeout(timeout);
              apply('live');
              onAudioRef.current?.((streamRef.current?.getAudioTracks?.().length ?? 0) > 0);
            }
            if (frames > lastFrames) {
              lastFrames = frames;
              lastMediaProgressAt = Date.now();
              return;
            }
            if (liveRef.current && Date.now() - lastMediaProgressAt >= MEDIA_STALL_TIMEOUT_MS) failover('O vídeo parou de chegar pela conexão WebRTC.');
          }).catch(() => undefined).finally(() => { statsPolling = false; });
        }, MEDIA_WATCHDOG_INTERVAL_MS);

        const ev = pc as unknown as PcEvents;
        ev.addEventListener('track', (event) => {
          const stream = event.streams?.[0];
          if (stream && !cancelled) {
            streamRef.current = stream;
            applyMuted(stream);
            setStreamUrl(stream.toURL());
            mediaReady = true;
          }
        });
        ev.addEventListener('connectionstatechange', () => {
          if (cancelled || !pc) return;
          const state = pc.connectionState;
          if (state === 'connected') {
            connectionReady = true;
            connectionLost = false;
            if (disconnectedTimer) clearTimeout(disconnectedTimer);
            disconnectedTimer = undefined;
            // Só o avanço de framesDecoded confirma vídeo, não o evento track.
          } else if (state === 'disconnected') {
            connectionReady = false;
            connectionLost = true;
            if (!disconnectedTimer) disconnectedTimer = setTimeout(() => {
              disconnectedTimer = undefined;
              if (appActive && !cancelled) failover('A conexão WebRTC foi interrompida.');
            }, 4_000);
          } else if (state === 'failed' || state === 'closed') {
            connectionReady = false;
            failover('A conexão WebRTC falhou.');
          }
        });

        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        await waitIceGathering(pc);
        if (cancelled) return;

        const response = await fetch(whepUrl, {
          method: 'POST',
          signal: abort.signal,
          headers: {
            'Content-Type': 'application/sdp',
            ...(mediaToken ? { Authorization: `Bearer ${mediaToken}` } : {}),
          },
          body: pc.localDescription?.sdp ?? offer.sdp,
        });
        if (!response.ok) throw new Error(`WHEP ${response.status}`);
        sessionUrl = response.headers.get('location');
        if (sessionUrl) {
          const original = new URL(whepUrl);
          const resolved = new URL(sessionUrl, whepUrl);
          // A resposta WHEP controla a URL usada no DELETE e esse request leva
          // o token de reprodução. Nunca siga Location para outro host: um
          // proxy comprometido ou mal configurado poderia capturar o token.
          if (resolved.origin !== original.origin) {
            throw new Error('WHEP devolveu sessão em origem diferente');
          }
          if (mediaToken && !resolved.searchParams.has('token')) resolved.searchParams.set('token', mediaToken);
          sessionUrl = resolved.toString();
        }
        const answer = await response.text();
        if (cancelled) return;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer }));
      } catch (error) {
        // Só exibe o status HTTP conhecido; nunca mostra URL, resposta ou token.
        const status = error instanceof Error ? /^WHEP (\d{3})$/.exec(error.message)?.[1] : null;
        failover(status ? `Servidor recusou WHEP (HTTP ${status}).` : 'Falha na negociação WHEP/WebRTC.');
      }
    };

    void start();
    const appSub = AppState.addEventListener('change', (next) => {
      appActive = next === 'active';
      if (appActive && (connectionLost || !liveRef.current) && !cancelled) failover('A conexão WebRTC foi interrompida.');
    });

    return () => {
      cancelled = true;
      abort.abort();
      if (timeout) clearTimeout(timeout);
      if (disconnectedTimer) clearTimeout(disconnectedTimer);
      if (mediaWatchdog) clearInterval(mediaWatchdog);
      appSub.remove();
      if (sessionUrl) {
        fetch(sessionUrl, {
          method: 'DELETE',
          headers: mediaToken ? { Authorization: `Bearer ${mediaToken}` } : undefined,
        }).catch(() => undefined);
      }
      if (pc) {
        try {
          pc.close();
        } catch {
          // ignore
        }
      }
    };
  }, [sessionIdentity]);

  const showPoster = status !== 'live' && Boolean(posterUri);

  return (
    <View style={[videoStyle, local.container]}>
      {streamUrl ? (
        <RTCView streamURL={streamUrl} style={StyleSheet.absoluteFill} objectFit={contentFit} />
      ) : null}

      {showPoster ? <Image source={{ uri: posterUri ?? undefined }} style={[StyleSheet.absoluteFill, posterStyle]} /> : null}

      {status !== 'live' ? (
        <View style={[StyleSheet.absoluteFill, local.overlay]}>
          <ActivityIndicator color="#ffffff" />
          <Text style={[emptyTextStyle, local.overlayText]}>Conectando ao vivo…</Text>
        </View>
      ) : null}
    </View>
  );
}

const local = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative' },
  overlay: { alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  overlayText: { marginTop: 4 },
});
