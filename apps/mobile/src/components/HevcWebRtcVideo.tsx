import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  type ImageStyle,
  StyleSheet,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { LiveStatus } from './VideoPlayers';
import { webRtcSessionIdentity } from '../utils/webrtc-recovery';

type Props = {
  whepUrl: string;
  posterUri?: string | null;
  videoStyle: StyleProp<ViewStyle>;
  posterStyle: StyleProp<ImageStyle>;
  emptyTextStyle: StyleProp<TextStyle>;
  onStatusChange?: (status: LiveStatus) => void;
  onFailover: (reason?: string) => void;
  muted?: boolean;
  contentFit?: 'contain' | 'cover';
  onAudioAvailable?: (available: boolean) => void;
};

type BridgeMessage = {
  type?: 'capability' | 'status' | 'audio' | 'error';
  supported?: boolean;
  value?: string | boolean;
  reason?: string;
};

const CONNECT_TIMEOUT_MS = 20_000;

function playerHtml(whepUrl: string, muted: boolean, contentFit: 'contain' | 'cover') {
  // JSON.stringify impede que URL/token encerrem a string JavaScript ou injetem HTML.
  const url = JSON.stringify(whepUrl).replace(/</g, '\\u003c');
  const initialMuted = muted ? 'true' : 'false';
  const fit = contentFit === 'cover' ? 'cover' : 'contain';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body,video{width:100%;height:100%;margin:0;background:#000;overflow:hidden}video{object-fit:${fit}}</style></head>
<body><video id="video" autoplay playsinline ${muted ? 'muted' : ''}></video><script>
(() => {
  'use strict';
  const whepUrl = ${url};
  const video = document.getElementById('video');
  let pc = null;
  let sessionUrl = null;
  let token = null;
  let closed = false;
  const controller = new AbortController();
  let statsTimer = null;
  let connectionTimer = null;
  let liveSent = false;
  let lastFrames = 0;
  let lastProgressAt = Date.now();

  const send = (payload) => {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (_) {}
  };
  const fail = (reason) => {
    if (closed) return;
    send({ type: 'error', reason: String(reason || 'WebRTC H.265 indisponível') });
  };
  window.s2camSetMuted = (value) => {
    video.muted = Boolean(value);
    const stream = video.srcObject;
    if (stream && stream.getAudioTracks) stream.getAudioTracks().forEach((track) => { track.enabled = !video.muted; });
  };
  window.s2camSetMuted(${initialMuted});

  function parseIceServers(header) {
    if (!header) return [];
    const entries = header.split(/,(?=\\s*<)/);
    const result = [];
    for (const entry of entries) {
      const target = /<([^>]+)>/.exec(entry)?.[1];
      if (!target || !/^(stun|stuns|turn|turns):/i.test(target) || !/rel\\s*=\\s*["']?ice-server/i.test(entry)) continue;
      const username = /username\\s*=\\s*["']([^"']+)["']/i.exec(entry)?.[1];
      const credential = /credential\\s*=\\s*["']([^"']+)["']/i.exec(entry)?.[1];
      result.push({ urls: target, ...(username ? { username } : {}), ...(credential ? { credential } : {}) });
    }
    return result;
  }
  function waitIce() {
    if (!pc || pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc?.removeEventListener('icegatheringstatechange', changed);
        resolve();
      };
      const changed = () => { if (pc?.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 2000);
      pc.addEventListener('icegatheringstatechange', changed);
    });
  }
  async function closeSession() {
    if (closed) return;
    closed = true;
    controller.abort();
    clearInterval(statsTimer);
    clearTimeout(connectionTimer);
    try { pc?.close(); } catch (_) {}
    video.srcObject = null;
    const cleanupController = new AbortController();
    const timeout = setTimeout(() => cleanupController.abort(), 3000);
    try {
      if (sessionUrl) await fetch(sessionUrl, { method: 'DELETE', signal: cleanupController.signal, keepalive: true, headers: token ? { Authorization: 'Bearer ' + token } : {} });
    } catch (_) {} finally { clearTimeout(timeout); }
  }
  async function start() {
    try {
      const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
      const hasHevc = codecs.some((codec) => /video\\/(h265|hevc)/i.test(codec.mimeType || ''));
      send({ type: 'capability', supported: hasHevc, value: codecs.map((codec) => codec.mimeType).join(',') });
      if (!hasHevc) throw new Error('Este Android WebView não anuncia H.265 no WebRTC.');

      try { token = new URL(whepUrl).searchParams.get('token'); } catch (_) {}
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      let iceServers = [];
      try {
        const options = await fetch(whepUrl, { method: 'OPTIONS', headers, signal: controller.signal });
        if (options.ok) iceServers = parseIceServers(options.headers.get('link'));
      } catch (_) {}
      if (closed) return;

      pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      const stream = new MediaStream();
      video.srcObject = stream;
      pc.ontrack = (event) => {
        stream.addTrack(event.track);
        if (event.track.kind === 'audio') send({ type: 'audio', value: true });
        window.s2camSetMuted(video.muted);
        video.play().catch(() => undefined);
      };
      pc.onconnectionstatechange = () => {
        if (pc?.connectionState === 'failed' || pc?.connectionState === 'closed') fail('A conexão WebRTC H.265 foi interrompida.');
      };

      const offer = await pc.createOffer();
      if (closed) return;
      await pc.setLocalDescription(offer);
      if (closed) return;
      await waitIce();
      if (closed) return;
      const response = await fetch(whepUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/sdp', ...headers },
        body: pc.localDescription?.sdp || offer.sdp,
      });
      if (!response.ok) throw new Error('Servidor recusou WebRTC H.265 (HTTP ' + response.status + ').');
      const location = response.headers.get('location');
      if (location) {
        const original = new URL(whepUrl);
        const resolved = new URL(location, whepUrl);
        if (resolved.origin !== original.origin) throw new Error('Sessão WebRTC inválida.');
        if (token && !resolved.searchParams.has('token')) resolved.searchParams.set('token', token);
        sessionUrl = resolved.toString();
      }
      const answer = await response.text();
      if (closed) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (closed) return;
      clearTimeout(connectionTimer);

      statsTimer = setInterval(async () => {
        if (closed || !pc) return;
        try {
          const stats = await pc.getStats();
          if (closed) return;
          let frames = 0;
          stats.forEach((report) => {
            if (report.type === 'inbound-rtp' && report.kind === 'video' && !report.isRemote) frames += Number(report.framesDecoded || 0);
          });
          if (frames > lastFrames) {
            lastFrames = frames;
            lastProgressAt = Date.now();
            if (!liveSent) { liveSent = true; send({ type: 'status', value: 'live' }); }
          } else if (liveSent && Date.now() - lastProgressAt > 15000) {
            fail('O vídeo H.265 parou de avançar.');
          }
        } catch (_) {}
      }, 2000);
    } catch (error) {
      fail('Não foi possível abrir o vídeo nesta qualidade. Tente novamente ou use a opção de economia de dados.');
      void closeSession();
    }
  }
  window.addEventListener('pagehide', closeSession);
  window.addEventListener('beforeunload', closeSession);
  connectionTimer = setTimeout(() => { fail('A conexão demorou demais. Tente novamente.'); void closeSession(); }, 15000);
  start();
})();
</script></body></html>`;
}

/**
 * Prova nativa-controlada: usa o Chromium do Android apenas quando ele realmente
 * anuncia H.265 em RTCRtpReceiver.getCapabilities(). A interface e os controles
 * continuam React Native; a WebView contém somente a superfície de vídeo WHEP.
 */
export function HevcWebRtcVideo({
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
}: Props) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [reload, setReload] = useState(0);
  const failedRef = useRef(false);
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;
  const failRef = useRef(onFailover);
  failRef.current = onFailover;
  const audioRef = useRef(onAudioAvailable);
  audioRef.current = onAudioAvailable;
  const identity = webRtcSessionIdentity(whepUrl);
  // Renovar somente o token não derruba a sessão ativa; ao voltar do background,
  // `reload` recompõe o documento com a URL/token mais recente.
  const html = useMemo(() => playerHtml(whepUrl, muted, contentFit), [identity, contentFit, reload]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const isActive = next === 'active';
      setActive(isActive);
      if (isActive) setReload((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    failedRef.current = false;
    setStatus('connecting');
    statusRef.current?.('connecting');
  }, [identity, reload]);

  const fail = (reason?: string) => {
    if (failedRef.current) return;
    failedRef.current = true;
    setStatus('offline');
    statusRef.current?.('offline');
    failRef.current(reason);
  };

  const onMessage = (event: WebViewMessageEvent) => {
    let message: BridgeMessage;
    try { message = JSON.parse(event.nativeEvent.data) as BridgeMessage; } catch { return; }
    if (message.type === 'status' && message.value === 'live') {
      setStatus('live');
      statusRef.current?.('live');
    } else if (message.type === 'audio') {
      audioRef.current?.(message.value === true);
    } else if (message.type === 'error') {
      fail(message.reason ?? 'WebRTC H.265 indisponível neste aparelho.');
    } else if (message.type === 'capability' && message.supported === false) {
      fail('Este aparelho não oferece H.265 pelo WebRTC do Android.');
    }
  };

  useEffect(() => {
    if (status === 'live') return;
    const timeout = setTimeout(() => fail('O WebRTC H.265 não entregou vídeo a tempo.'), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [identity, reload, status]);

  const webRef = useRef<WebView>(null);
  useEffect(() => {
    webRef.current?.injectJavaScript(`window.s2camSetMuted?.(${muted ? 'true' : 'false'}); true;`);
  }, [muted]);

  return (
    <View style={[videoStyle, local.container]}>
      {active ? (
        <WebView
          key={`${identity}:${reload}`}
          ref={webRef}
          source={{ html, baseUrl: new URL(whepUrl).origin }}
          style={StyleSheet.absoluteFill}
          originWhitelist={['https://*']}
          javaScriptEnabled
          domStorageEnabled={false}
          cacheEnabled={false}
          incognito
          mixedContentMode="never"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          setSupportMultipleWindows={false}
          androidLayerType="hardware"
          onMessage={onMessage}
          onError={() => fail('O componente de vídeo do Android não pôde ser iniciado.')}
          onRenderProcessGone={() => fail('O componente de vídeo do Android foi reiniciado.')}
        />
      ) : null}
      {status !== 'live' && posterUri ? <Image source={{ uri: posterUri }} style={[StyleSheet.absoluteFill, posterStyle]} /> : null}
      {status !== 'live' ? (
        <View style={[StyleSheet.absoluteFill, local.overlay]}>
          <ActivityIndicator color="#ffffff" />
          <Text style={[emptyTextStyle, local.overlayText]}>Preparando HD+ ao vivo…</Text>
        </View>
      ) : null}
    </View>
  );
}

const local = StyleSheet.create({
  container: { overflow: 'hidden', position: 'relative', backgroundColor: '#000' },
  overlay: { alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  overlayText: { marginTop: 4 },
});
