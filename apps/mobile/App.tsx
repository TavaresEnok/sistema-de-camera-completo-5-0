// PRIMEIRO import de propósito: o patch de tipografia precisa estar ativo antes de as
// telas rodarem seus StyleSheet.create (que acontecem no import delas).
import './src/theme/applyFonts';
import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import * as ScreenOrientation from 'expo-screen-orientation';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Pressable, SafeAreaView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { isRedesign } from './src/theme/redesign';
import { ALLOW_CLEARTEXT_TRAFFIC, DEFAULT_API_URL, TOP_SAFE } from './src/config';
import { BottomTabs } from './src/components/BottomTabs';
import { AlarmsScreen } from './src/screens/AlarmsScreen';
import { CentralScreen } from './src/screens/CentralScreen';
import { HomeRedesign } from './src/screens/redesign/HomeRedesign';
import { CamerasRedesign } from './src/screens/redesign/CamerasRedesign';
import { EventsRedesign } from './src/screens/redesign/EventsRedesign';
import { SettingsRedesign } from './src/screens/redesign/SettingsRedesign';
import { BottomTabsRedesign } from './src/components/BottomTabsRedesign';
import { LiveScreen } from './src/screens/LiveScreen';
import { LiveScreenRedesign } from './src/screens/redesign/LiveScreenRedesign';
import { LoginScreen } from './src/screens/LoginScreen';
import { MosaicScreen } from './src/screens/MosaicScreen';
import { PlaybackScreen } from './src/screens/PlaybackScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { request, normalizeServerUrl, setTokenRefreshHandler, setUnauthorizedHandler, invalidateAuthRequests } from './src/services/api';
import { authenticatedMediaUrl, isSecureMediaUrl } from './src/services/media-urls';
import { fetchBranding, isLightColor, loadCachedBranding, saveCachedBranding } from './src/services/branding';
import { clearStreamUrlsCache, requestCachedStreamUrls, type ModoDeEntrega } from './src/services/stream-urls-cache';
import { RondaScreen } from './src/screens/RondaScreen';
import { lerPreferenciaDePush, salvarPreferenciaDePush } from './src/services/pushPreference';
import type { MosaicoDoApp, RondaDoApp } from './src/utils/ronda';
import {
  saveToGallery, addClip, listClips, removeClip, createClipThumbnail,
  listPendingClips, savePendingClip, removePendingClip,
  type PendingClip, type SavedClip,
} from './src/services/clips';
import {
  cleanApiUrl, clearStoredSession, isBiometricLoginEnabled, loadStoredSession,
  saveStoredSession, setBiometricLoginEnabled,
} from './src/services/sessionStore';
import { authenticateWithBiometrics, getBiometricSupport } from './src/services/biometrics';
import { registerForPush, subscribeToNotificationTaps, unregisterFromPush } from './src/services/push';
import Constants from 'expo-constants';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { AppNoticeHost } from './src/components/AppNoticeHost';
import { showAppNotice } from './src/services/app-notice';
import { userFacingError } from './src/services/user-facing-error';
import { loadCachedPosters, savePoster } from './src/services/poster-cache';
import { iniciarRelatorioDeTravamento, marcarInstalacao } from './src/services/crash-reporting';
import { useAlarms } from './src/hooks/useAlarms';
import { useLiveDetections } from './src/hooks/useLiveDetections';
import { downloadAuthenticated } from './src/services/authenticated-download';
import { flushPushRemovals } from './src/services/push-revocation';
import { findAlarmRecording } from './src/services/alarm-recording';
import { loadCameraList } from './src/services/camera-list';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { LibraryProvider, useLibrary } from './src/state/LibraryProvider';
import { localDateKey, localDayIsoRange, shiftDateKey } from './src/utils/format';
import { buildOperationalMessages } from './src/utils/operational';
import { cameraPosterUrl, clipDownloadUrl, recordingThumbnailUrl } from './src/utils/media-endpoints';
import type { ActivePlayback, Alarm, Camera, Direction, MobileCapabilities, Recording, Session, StreamUrls, Tab, User } from './src/types';
import { montarUrlDeReproducao } from './src/utils/playback-source';

// O play-token vale 5 min no servidor; renovar aos 4 dá folga para a
// requisição e a troca de fonte acontecerem antes de vencer.
const PLAY_TOKEN_RENEW_MS = 4 * 60 * 1000;
// O servidor também impõe este teto. O timer no app encerra um pouco antes
// para finalizar e baixar o clipe sem disputar com a parada de segurança.
const MANUAL_CLIP_MAX_MS = 5 * 60 * 1000;

const RECORDINGS_PAGE_SIZE = 50;
const POSTER_REFRESH_BATCH = 30;

// Antes de qualquer render: um travamento na inicialização é justamente o que
// não se descobre por telefonema.
iniciarRelatorioDeTravamento();
marcarInstalacao(String(Constants.expoConfig?.extra?.client ?? 'default'));

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <LibraryProvider>
            <View style={{ flex: 1 }}>
              <AppInner />
              <AppNoticeHost />
            </View>
          </LibraryProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const { theme, branding, applyBranding } = useTheme();
  const { setScope: setLibraryScope } = useLibrary();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [session, setSession] = useState<Session | null>(null);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoringSession, setRestoringSession] = useState(true);
  const [pendingBiometricSession, setPendingBiometricSession] = useState<Session | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Biometria');
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('central');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [liveCamera, setLiveCamera] = useState<Camera | null>(null);
  const [highlightedAlarmId, setHighlightedAlarmId] = useState<string | null>(null);
  // Câmera pedida por um push tocado antes da lista de câmeras carregar (cold start).
  const [pendingPushCameraId, setPendingPushCameraId] = useState<string | null>(null);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  // ÁUDIO AO VIVO: o som só existe se PEDIRMOS o perfil com áudio ao servidor
  // (no WebRTC o áudio só é convertido sob demanda). Antes o botão da tela
  // mexia no volume de um stream que vinha sem faixa de áudio nenhuma.
  const [audioAoVivo, setAudioAoVivo] = useState(false);
  const audioAoVivoRef = useRef(false);
  const audioPreparadoCameraRef = useRef<string | null>(null);
  useEffect(() => { audioAoVivoRef.current = audioAoVivo; }, [audioAoVivo]);
  // GRAVAÇÃO NO SISTEMA (acervo) — diferente do clipe local do botão "Gravar".
  const [gravacaoSistemaAtiva, setGravacaoSistemaAtiva] = useState(false);
  const [gravacaoSistemaConhecida, setGravacaoSistemaConhecida] = useState(false);
  const [gravacaoSistemaOcupada, setGravacaoSistemaOcupada] = useState(false);
  const gravacaoSistemaLock = useRef(false);
  // Alertas neste aparelho: o push já funcionava, mas não havia como desligar.
  const [pushHabilitado, setPushHabilitado] = useState(true);
  const [pushSuportado, setPushSuportado] = useState(true);
  const pushHabilitadoRef = useRef(true);
  useEffect(() => { pushHabilitadoRef.current = pushHabilitado; }, [pushHabilitado]);
  useEffect(() => { void lerPreferenciaDePush().then(setPushHabilitado); }, []);
  useEffect(() => {
    setGravacaoSistemaConhecida(false);
    if (!liveCamera) {
      setGravacaoSistemaAtiva(false);
      setAudioAoVivo(false);
      audioAoVivoRef.current = false;
      audioPreparadoCameraRef.current = null;
      return;
    }
    if (session?.user.role === 'VIEWER' || liveCamera.canRecord !== true || liveCamera.recordingMode === 'continuous') return;
    void carregarEstadoGravacao(liveCamera.id);
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void carregarEstadoGravacao(liveCamera.id);
    }, 15_000);
    return () => clearInterval(timer);
  }, [liveCamera?.id, session?.token]);
  // RONDA: o servidor já marcava quais aparecem no celular e o app ignorava.
  const [rondas, setRondas] = useState<RondaDoApp[]>([]);
  const [mosaicos, setMosaicos] = useState<MosaicoDoApp[]>([]);
  const [canManageAlarms, setCanManageAlarms] = useState(false);
  const [streamUrls, setStreamUrls] = useState<Record<string, string | null>>({});
  const [streamWhep, setStreamWhep] = useState<Record<string, string | null>>({});
  const [streamPosters, setStreamPosters] = useState<Record<string, string | null>>({});
  // Fontes de MÁXIMA QUALIDADE. WebRTC original é o caminho prioritário de
  // baixa latência; HLS original permanece como recuperação de compatibilidade.
  const [hdUrl, setHdUrl] = useState<string | null>(null);
  const [hdWhepUrl, setHdWhepUrl] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [recordingsTotal, setRecordingsTotal] = useState(0);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingsLoadingMore, setRecordingsLoadingMore] = useState(false);
  const [recordingsError, setRecordingsError] = useState<string | null>(null);
  const [activePlayback, setActivePlayback] = useState<ActivePlayback | null>(null);
  /** Gravação cujo play-token está sendo emitido — dá retorno ao toque. */
  const [abrindoGravacaoId, setAbrindoGravacaoId] = useState<string | null>(null);
  // Espelho para os timers lerem o playback VIGENTE sem stale closure.
  const activePlaybackRef = useRef<ActivePlayback | null>(null);
  useEffect(() => { activePlaybackRef.current = activePlayback; }, [activePlayback]);
  const [ptzActive, setPtzActive] = useState<Direction | null>(null);
  const [ptzFeedback, setPtzFeedback] = useState<string | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  // Id do clipe em gravação no servidor (gravação "no celular": o servidor grava
  // o trecho EXATO start→stop e o app baixa o arquivo ao parar).
  const [clipId, setClipId] = useState<string | null>(null);
  // "Minhas gravações" — índice local dos clipes gravados pelo app.
  const [savedClips, setSavedClips] = useState<SavedClip[]>([]);
  const [recordingDate, setRecordingDate] = useState(() => localDateKey());
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<MobileCapabilities>({ liveView: true, playback: true, exportEvidence: false, alarmAck: false, ptzControl: false });
  // Permissões podem ser alteradas enquanto o usuário está logado. Este contador
  // força uma nova leitura ao voltar ao app, sem obrigá-lo a sair e entrar.
  const [permissionsRefreshNonce, setPermissionsRefreshNonce] = useState(0);
  const [downloadingIds, setDownloadingIds] = useState<string[]>([]);
  const selectedCamera = cameras.find((camera) => camera.id === selectedCameraId) ?? cameras[0] ?? null;
  const sessionScope = session ? `${session.apiUrl}|${session.user.id}` : 'anonymous';
  const sessionTokenRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const recordingDateRef = useRef(recordingDate);
  const recordingDateCameraRef = useRef<string | null>(null);
  const recordingsRef = useRef<Recording[]>([]);
  const clipPhaseRef = useRef<'idle' | 'starting' | 'recording' | 'stopping'>('idle');
  const clipIdRef = useRef<string | null>(null);
  const clipCameraRef = useRef<Camera | null>(null);
  const clipStartedAtRef = useRef<string | null>(null);
  const clipStartPromiseRef = useRef<Promise<void> | null>(null);
  const clipStopPromiseRef = useRef<Promise<void> | null>(null);
  const clipCancelRequestedRef = useRef(false);
  const clipFinalizeSilentRef = useRef(false);
  const clipLimitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRequestRef = useRef(0);
  const playbackRequestRef = useRef(0);
  const hdRequestRef = useRef(0);
  const brandingRequestRef = useRef(0);
  const posterRequestRef = useRef(0);
  const posterBatchCursorRef = useRef(0);
  const lastThumbnailRefreshRef = useRef(0);
  const camerasRequestRef = useRef(0);
  const streamRequestRef = useRef(new Map<string, number>());
  const downloadingRef = useRef(new Set<string>());
  const pendingClipDownloadsRef = useRef(new Set<string>());
  const appStateRef = useRef(AppState.currentState);
  const liveCameraIdRef = useRef<string | null>(null);
  const selectedCameraIdRef = useRef<string | null>(null);
  liveCameraIdRef.current = liveCamera?.id ?? null;
  selectedCameraIdRef.current = selectedCameraId;
  recordingDateRef.current = recordingDate;
  recordingsRef.current = recordings;

  const { alarms, total: alarmsTotal, loadMore: loadMoreAlarms, openAlarmCount, reload: reloadAlarms, ack: ackAlarm, resolve: resolveAlarm, erro: alarmesErro, carregando: alarmesCarregando } = useAlarms(session);
  const liveDetections = useLiveDetections(session, liveCamera != null && !activePlayback, liveCamera?.id ?? null);

  const operationalMessages = buildOperationalMessages(cameras, lastSyncError);
  const statusBarStyle = isLightColor(theme.bg) ? 'dark' : 'light';

  // A marca baixada com sucesso é guardada por instalação. Ao ficar offline, o
  // APK conserva logo, nome e paleta já aprovados — em vez de voltar ao azul
  // padrão. Ela só muda quando uma nova autenticação consegue buscá-la.
  const restoreCachedBranding = (url: string) => {
    if (!url) return;
    const generation = ++brandingRequestRef.current;
    void loadCachedBranding(url).then((cached) => {
      if (cached && brandingRequestRef.current === generation) applyBranding(cached);
    });
  };

  const loadBranding = (url: string) => {
    if (!url) return;
    const generation = ++brandingRequestRef.current;
    fetchBranding(url)
      .then((next) => {
        if (brandingRequestRef.current !== generation) return;
        applyBranding(next);
        void saveCachedBranding(url, next).catch(() => undefined);
      })
      .catch(() => undefined);
  };

  const activateSession = (next: Session) => {
    invalidateAuthRequests();
    sessionGenerationRef.current++;
    sessionTokenRef.current = next.token;
    setSession(next);
    setApiUrl(next.apiUrl);
    setEmail(next.user.email);
    setPendingBiometricSession(null);
    loadBranding(next.apiUrl);
  };

  const renewStoredSession = async (stored: Session): Promise<Session | null> => {
    if (!stored.refreshToken) return stored;
    try {
      const data = await request<{
        accessToken: string;
        refreshToken: string;
        refreshExpiresAt: string;
        user: User;
      }>(stored.apiUrl, '/auth/refresh', undefined, {
        method: 'POST',
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      });
      const renewed: Session = {
        apiUrl: stored.apiUrl,
        token: data.accessToken,
        refreshToken: data.refreshToken,
        refreshExpiresAt: data.refreshExpiresAt,
        user: data.user,
      };
      await saveStoredSession(renewed);
      return renewed;
    } catch (error) {
      // Falha de rede não elimina uma sessão ainda utilizável. Apenas uma recusa
      // explícita da API significa sete dias de inatividade/revogação.
      if ((error as { status?: number })?.status === 401) {
        await clearStoredSession();
        return null;
      }
      return stored;
    }
  };

  const unlockPendingSession = async () => {
    const stored = pendingBiometricSession;
    if (!stored) return;
    setLoading(true);
    try {
      if (!(await authenticateWithBiometrics('Confirme sua identidade para entrar'))) return;
      const renewed = await renewStoredSession(stored);
      if (renewed) activateSession(renewed);
      else showAppNotice('Sessão expirada', 'Entre novamente com sua senha.', 'warning');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Antes de qualquer rede, restaura a última identidade válida. Isso mantém
    // inclusive a tela de login correta durante uma queda da instalação.
    if (DEFAULT_API_URL) restoreCachedBranding(DEFAULT_API_URL);

    void (async () => {
      try {
        const [raw, enabled, support] = await Promise.all([
          loadStoredSession(),
          isBiometricLoginEnabled(),
          getBiometricSupport().catch(() => ({ available: false, label: 'Biometria' })),
        ]);
        setBiometricAvailable(support.available);
        setBiometricLabel(support.label);
        setBiometricEnabled(enabled);
        if (!raw) return;
        const stored = JSON.parse(raw) as Session;
        const normalized = { ...stored, apiUrl: cleanApiUrl(stored.apiUrl) };
        if (/^http:\/\//i.test(normalized.apiUrl) && !ALLOW_CLEARTEXT_TRAFFIC) {
          await clearStoredSession();
          return;
        }
        setApiUrl(normalized.apiUrl);
        setEmail(normalized.user.email);
        restoreCachedBranding(normalized.apiUrl);
        if (normalized.apiUrl !== stored.apiUrl) await saveStoredSession(normalized);

        if (enabled) {
          setPendingBiometricSession(normalized);
          if (!support.available) return;
          if (!(await authenticateWithBiometrics('Confirme sua identidade para entrar'))) return;
        }
        const renewed = await renewStoredSession(normalized);
        if (renewed) activateSession(renewed);
      } catch {
        // Mantém a tela de login utilizável mesmo se o armazenamento local falhar.
      } finally {
        setRestoringSession(false);
      }
    })();
  }, []);

  useEffect(() => {
    sessionTokenRef.current = session?.token ?? null;
    setLibraryScope(sessionScope);
    if (!session) {
      setSavedClips([]);
      return;
    }
    let cancelled = false;
    void listClips(sessionScope).then((items) => {
      if (!cancelled && sessionTokenRef.current === session.token) setSavedClips(items);
    });
    void resumePendingClips(session);
    return () => { cancelled = true; };
  }, [sessionScope, session?.token, setLibraryScope]);

  useEffect(() => {
    if (!session?.refreshToken) {
      setTokenRefreshHandler(null);
      return;
    }
    const generation = sessionGenerationRef.current;
    setTokenRefreshHandler(async (expiredToken, origin) => {
      // Outra requisição pode já ter renovado a sessão enquanto esta aguardava.
      if (generation !== sessionGenerationRef.current || origin !== session.apiUrl || expiredToken !== session.token) throw new Error('Operação cancelada.');
      if (expiredToken !== sessionTokenRef.current) return sessionTokenRef.current;
      try {
        const data = await request<{
          accessToken: string;
          refreshToken: string;
          refreshExpiresAt: string;
          user: User;
        }>(session.apiUrl, '/auth/refresh', undefined, {
          method: 'POST',
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        const renewed: Session = {
          ...session,
          token: data.accessToken,
          refreshToken: data.refreshToken,
          refreshExpiresAt: data.refreshExpiresAt,
          user: data.user,
        };
        if (generation !== sessionGenerationRef.current) throw new Error('Operação cancelada.');
        await saveStoredSession(renewed);
        if (generation !== sessionGenerationRef.current) throw new Error('Operação cancelada.');
        sessionTokenRef.current = renewed.token;
        setSession(renewed);
        return renewed.token;
      } catch (error) {
        if ((error as { status?: number })?.status === 401) return null;
        throw error;
      }
    });
    return () => setTokenRefreshHandler(null);
  }, [session?.token, session?.refreshToken, session?.apiUrl]);

  useEffect(() => {
    if (session) void loadAll();
  }, [session?.token]);

  useEffect(() => {
    if (!session) { setCanManageAlarms(false); return; }
    const token = session.token;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // A chamada é pequena, mas não pode determinar silenciosamente que o
    // operador perdeu PTZ: uma renovação de token ou retomada da rede podia
    // falhar uma vez e esconder o botão até o próximo login.
    const loadCapabilities = async (attempt = 0): Promise<void> => {
      try {
        const data = await request<{ permissions?: Partial<MobileCapabilities> }>(session.apiUrl, '/role-permissions/me', token);
        if (cancelled || sessionTokenRef.current !== token) return;
        const next = {
          liveView: data.permissions?.liveView !== false,
          playback: data.permissions?.playback !== false,
          exportEvidence: data.permissions?.exportEvidence === true,
          alarmAck: data.permissions?.alarmAck === true,
          ptzControl: data.permissions?.ptzControl === true,
        };
        setCapabilities(next);
        setCanManageAlarms(next.alarmAck);
      } catch {
        if (cancelled || sessionTokenRef.current !== token) return;
        // Duas novas tentativas curtas cobrem a troca de rede/refresh do token.
        // Mantemos a última permissão conhecida enquanto isso; nunca a elevamos.
        if (attempt < 2) {
          retryTimer = setTimeout(() => { void loadCapabilities(attempt + 1); }, 1_500 * (attempt + 1));
          return;
        }
        setCanManageAlarms(false);
      }
    };

    void loadCapabilities();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [session?.token, session?.apiUrl, permissionsRefreshNonce]);

  // Push de alarmes + sessão expirada. Ao autenticar: registra o handler de 401
  // (logout gracioso quando o token morre) e o aparelho para push; ao tocar na
  // notificação, abre Alarmes e recarrega. Falha de push nunca quebra o app.
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let disposed = false;
    setUnauthorizedHandler((requestToken) => {
      if (requestToken === sessionTokenRef.current) void logout(false);
    });
    if (pushHabilitadoRef.current) {
      void registerForPush(session.apiUrl, session.token, controller.signal).then((expoToken) => {
        if (disposed && expoToken) void unregisterFromPush(session.apiUrl, session.token, expoToken);
        // Token nulo = aparelho sem push (emulador, permissão negada). A tela
        // diz isso, em vez de mostrar um botão que não faria nada.
        if (!disposed) setPushSuportado(Boolean(expoToken));
      });
    }
    const unsubscribe = subscribeToNotificationTaps((data) => {
      setHighlightedAlarmId(data.alarmId ?? null);
      setTab('alarmes');
      void reloadAlarms();
      // O toque leva ao evento; vídeo atual não representa a ocorrência passada.
    });
    return () => {
      disposed = true;
      controller.abort();
      setUnauthorizedHandler(null);
      unsubscribe();
    };
  }, [session?.token]);

  // Orientação: o app é retrato; SÓ a tela ao vivo libera paisagem (gira ao deitar
  // o aparelho) e volta a travar em retrato ao sair.
  useEffect(() => {
    if (liveCamera) {
      ScreenOrientation.unlockAsync().catch(() => undefined);
      void loadNotificationMute(liveCamera.id);
    } else {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
    }
  }, [liveCamera]);

  useEffect(() => {
    if (selectedCamera && session && capabilities.playback) {
      if (recordingDateCameraRef.current !== selectedCamera.id) {
        recordingDateCameraRef.current = selectedCamera.id;
        void loadLatestRecordingDate(selectedCamera.id);
      } else {
        void loadRecordings(selectedCamera.id, recordingDate);
      }
    } else if (!capabilities.playback) {
      recordingRequestRef.current += 1;
      setRecordings([]);
      setRecordingsTotal(0);
      setRecordingsLoading(false);
      setRecordingsLoadingMore(false);
      setRecordingsError('Você não possui permissão para visualizar gravações.');
      playbackRequestRef.current += 1;
      setActivePlayback(null);
    }
  }, [selectedCamera?.id, session?.token, recordingDate, capabilities.playback]);

  // A URL de máxima qualidade é por câmera; não vaza entre telas.
  useEffect(() => {
    setHdUrl(null);
    setHdWhepUrl(null);
  }, [liveCamera?.id]);

  // Máxima qualidade é sempre a primeira fonte da tela individual. Depois que
  // ela abre, preparamos Economia em segundo plano para a troca ser imediata.
  const loadHdStream = async (cameraId: string): Promise<boolean> => {
    if (!session) return false;
    const token = session.token;
    const generation = ++hdRequestRef.current;
    try {
      const data = await requestCachedStreamUrls<StreamUrls>(
        session.apiUrl,
        cameraId,
        session.token,
        { headers: { 'X-S2Cam-Native-WebRTC': 'hevc' } },
        modoMaxima(),
      );
      if (sessionTokenRef.current !== token || hdRequestRef.current !== generation || liveCameraIdRef.current !== cameraId) return false;
      const whepRaw = data.protocols?.whepUrl
        ?? (data.protocols?.webrtcUrl ? `${data.protocols.webrtcUrl.replace(/\/+$/, '')}/whep` : null);
      const whep = authenticatedMediaUrl(whepRaw, session.apiUrl, data.streamToken);
      const hls = authenticatedMediaUrl(data.protocols?.hlsUrl ?? null, session.apiUrl, data.streamToken);
      if (!whep && !hls) throw new Error('sem URL de máxima qualidade');
      // Guardamos os dois caminhos do MESMO stream original. WHEP continua
      // prioritário; HLS só é usado quando a negociação comprova que o codec
      // original (ex.: H.265) não existe na oferta WebRTC deste Android.
      setHdUrl(hls);
      setHdWhepUrl(whep);
      void loadStream(cameraId, modoDaGrade());
      return true;
    } catch {
      if (sessionTokenRef.current !== token || hdRequestRef.current !== generation || liveCameraIdRef.current !== cameraId) return false;
      setHdUrl(null);
      setHdWhepUrl(null);
      // O modo HD+ exibe a falha WHEP; Economia só abre por escolha do usuário.
      void loadStream(cameraId, modoDaGrade(), true);
      return false;
    }
  };

  const login = async () => {
    setLoading(true);
    try {
      const nextApiUrl = cleanApiUrl(apiUrl);
      if (!nextApiUrl) throw new Error('Informe o endereço de acesso.');
      if (/^http:\/\//i.test(nextApiUrl) && !ALLOW_CLEARTEXT_TRAFFIC) {
        throw new Error('Use o endereço de acesso seguro informado pela sua equipe.');
      }
      const data = await request<{
        accessToken: string;
        refreshToken: string;
        refreshExpiresAt: string;
        user: User;
      }>(nextApiUrl, '/auth/login', undefined, {
        method: 'POST',
        body: JSON.stringify({ username: email, password }),
      });
      const nextSession: Session = {
        apiUrl: nextApiUrl,
        token: data.accessToken,
        refreshToken: data.refreshToken,
        refreshExpiresAt: data.refreshExpiresAt,
        user: data.user,
      };
      await saveStoredSession(nextSession);
      clearStreamUrlsCache();
      // Um login manual sempre começa no Início. A resposta de push que o SO
      // deixou guardada pode ser antiga; limpá-la antes de montar a sessão evita
      // que ela abra Eventos logo após autenticar.
      await Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      setTab('central');
      activateSession(nextSession);
      setPassword('');
      if (biometricAvailable && !biometricEnabled) {
        Alert.alert(
          'Ativar acesso por biometria?',
          `Nos próximos acessos, use ${biometricLabel.toLowerCase()} sem digitar a senha.`,
          [
            { text: 'Agora não', style: 'cancel' },
            {
              text: 'Ativar',
              onPress: () => {
                void (async () => {
                  if (!(await authenticateWithBiometrics('Confirme a biometria para ativar'))) return;
                  await setBiometricLoginEnabled(true);
                  setBiometricEnabled(true);
                })();
              },
            },
          ],
        );
      }
    } catch (error) {
      showAppNotice('Não foi possível entrar', userFacingError(error, 'Confira seus dados e tente novamente.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const forgotPassword = async () => {
    const targetEmail = email.trim();
    if (!targetEmail) {
      showAppNotice('Informe seu e-mail', 'Digite o e-mail cadastrado no campo de usuário e tente novamente.', 'warning');
      return;
    }
    let nextApiUrl = '';
    try { nextApiUrl = cleanApiUrl(apiUrl); }
    catch (error) {
      showAppNotice('Não foi possível recuperar a senha', userFacingError(error, 'Confira o endereço de acesso e tente novamente.'), 'error');
      return;
    }
    if (!nextApiUrl) {
      showAppNotice('Não foi possível recuperar a senha', 'O endereço de acesso não está configurado.', 'error');
      return;
    }
    if (/^http:\/\//i.test(nextApiUrl) && !ALLOW_CLEARTEXT_TRAFFIC) {
      showAppNotice('Conexão segura necessária', 'Atualize o endereço de acesso para HTTPS.', 'warning');
      return;
    }
    try {
      await request(nextApiUrl, '/auth/forgot-password', undefined, {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail }),
      });
    } catch {
      // O backend responde igual existindo ou não a conta (evita enumeração de e-mails).
    }
    showAppNotice('Verifique seu e-mail', 'Se houver uma conta cadastrada, enviaremos as instruções para redefinir a senha.', 'success', 6500);
  };

  const logout = async (revokeServer = true) => {
    sessionGenerationRef.current++;
    invalidateAuthRequests();
    const previous = session;
    void stopActiveClip(true);
    sessionTokenRef.current = null;
    setUnauthorizedHandler(null);
    setTokenRefreshHandler(null);
    clearStreamUrlsCache();
    setSession(null);
    setCameras([]);
    setSelectedCameraId(null);
    recordingDateCameraRef.current = null;
    setRecordings([]);
    setRecordingsTotal(0);
    setRecordingsLoading(false);
    setRecordingsLoadingMore(false);
    setRecordingsError(null);
    setStreamUrls({});
    setStreamWhep({});
    setStreamPosters({});
    setHdUrl(null);
    setHdWhepUrl(null);
    setActivePlayback(null);
    setNotificationsMuted(false);
    setCanManageAlarms(false);
    setCapabilities({ liveView: true, playback: true, exportEvidence: false, alarmAck: false, ptzControl: false });
    downloadingRef.current.clear();
    pendingClipDownloadsRef.current.clear();
    setDownloadingIds([]);
    recordingRequestRef.current += 1;
    playbackRequestRef.current += 1;
    hdRequestRef.current += 1;
    posterRequestRef.current += 1;
    camerasRequestRef.current += 1;
    streamRequestRef.current.clear();
    setHighlightedAlarmId(null);
    setLiveCamera(null);
    setTab('central');
    setRefreshing(false);
    setLastSyncError(null);
    await clearStoredSession();
    if (previous) {
      void unregisterFromPush(previous.apiUrl, previous.token);
      if (revokeServer) {
        void request(previous.apiUrl, '/auth/logout', previous.token, { method: 'POST' }).catch(() => undefined);
      }
    }
  };

  const confirmLogout = () => Alert.alert(
    'Sair da conta?',
    'Esta ação também encerra suas sessões nos outros aparelhos quando o servidor recebe o pedido. Sem conexão, a saída será apenas neste aplicativo.',
    [{ text: 'Cancelar', style: 'cancel' }, { text: 'Sair', style: 'destructive', onPress: () => { void logout(); } }],
  );

  const changeBiometricPreference = async (enabled: boolean) => {
    if (!enabled) {
      await setBiometricLoginEnabled(false);
      setBiometricEnabled(false);
      return;
    }
    const support = await getBiometricSupport().catch(() => ({ available: false, label: 'Biometria' }));
    setBiometricAvailable(support.available);
    setBiometricLabel(support.label);
    if (!support.available) {
      showAppNotice('Biometria indisponível', 'Cadastre uma impressão digital ou reconhecimento facial nos ajustes do aparelho.', 'warning');
      return;
    }
    if (!(await authenticateWithBiometrics('Confirme a biometria para ativar'))) return;
    await setBiometricLoginEnabled(true);
    setBiometricEnabled(true);
  };

  const loadAll = async (quiet = false) => {
    if (!session) return;
    const token = session.token;
    const generation = ++camerasRequestRef.current;
    if (!quiet) setRefreshing(true);
    try {
      const raw = await loadCameraList(session);
      if (sessionTokenRef.current !== token || camerasRequestRef.current !== generation) return;
      // Câmeras DESATIVADAS no sistema não aparecem no app (o servidor também
      // recusa o stream delas; some da lista para não virar "câmera quebrada").
      const data = raw.filter((camera) => camera.enabled !== false);
      setCameras(data);
      setLastSyncError(null);
      setSelectedCameraId((current) => (current && data.some((camera) => camera.id === current) ? current : data[0]?.id ?? null));
      void reloadAlarms();
      void carregarRondas();
      // Status sonda a cada 30s; posters têm renovação própria (3,5 min) para
      // não forçar dezenas de frames a cada ciclo silencioso.
      if (!quiet) void loadAllPosters(data);
    } catch (error) {
      if (sessionTokenRef.current !== token || camerasRequestRef.current !== generation) return;
      const status = (error as { status?: number })?.status;
      const message = userFacingError(error, 'Não foi possível atualizar as câmeras. Verifique a conexão e tente novamente.');
      const isAuthError = status === 401 || /\b401\b|unauthorized|não autorizado/i.test(message);
      setLastSyncError(isAuthError ? 'Sessão expirada. Entre novamente.' : `Servidor indisponível: ${message}`);
      if (isAuthError) {
        await logout(false);
        showAppNotice('Sessão expirada', 'Entre novamente para continuar.', 'warning');
      } else if (!quiet) {
        showAppNotice('Não foi possível atualizar as câmeras', message, 'error');
      }
    } finally {
      if (!quiet && sessionTokenRef.current === token && camerasRequestRef.current === generation) setRefreshing(false);
    }
  };

  /** Perfil da grade, com ou sem áudio conforme o operador pediu. */
  const modoDaGrade = (): ModoDeEntrega => (audioAoVivoRef.current || (audioPreparadoCameraRef.current !== null && audioPreparadoCameraRef.current === liveCameraIdRef.current) ? 'grid-audio' : 'grid');
  /** Perfil de máxima qualidade, idem. */
  const modoMaxima = (): ModoDeEntrega => (audioAoVivoRef.current || (audioPreparadoCameraRef.current !== null && audioPreparadoCameraRef.current === liveCameraIdRef.current) ? 'original-audio' : 'original');

  /**
   * Rondas e mosaicos do usuário. Best-effort: instalação antiga (sem estas
   * rotas) apenas fica sem a aba, em vez de quebrar o carregamento.
   */
  const carregarRondas = async () => {
    if (!session) return;
    const token = session.token;
    const vazio = { items: [] as never[] };
    const compatible = (error: unknown) => {
      if ((error as { status?: number })?.status === 404) return vazio;
      throw error;
    };
    try {
      const [listaRondas, listaMosaicos] = await Promise.all([
        request<{ items: RondaDoApp[] }>(session.apiUrl, '/rondas', session.token).catch(compatible),
        request<{ items: MosaicoDoApp[] }>(session.apiUrl, '/live-layouts', session.token).catch(compatible),
      ]);
      if (sessionTokenRef.current !== token) return;
      setRondas(listaRondas?.items ?? []);
      setMosaicos(listaMosaicos?.items ?? []);
    } catch {
      if (sessionTokenRef.current === token) showAppNotice('Rondas não atualizadas', 'Não foi possível consultar as rondas e os mosaicos. Tente atualizar novamente.', 'warning');
    }
  };

  const loadStream = async (cameraId: string, viewMode: ModoDeEntrega = 'original', force = false) => {
    if (!session) return;
    const token = session.token;
    const generation = (streamRequestRef.current.get(cameraId) ?? 0) + 1;
    streamRequestRef.current.set(cameraId, generation);
    try {
      if (force) clearStreamUrlsCache(cameraId);
      const data = await requestCachedStreamUrls<StreamUrls>(session.apiUrl, cameraId, session.token, undefined, viewMode);
      if (sessionTokenRef.current !== token || streamRequestRef.current.get(cameraId) !== generation) return;
      const hlsUrl = authenticatedMediaUrl(data.protocols?.hlsUrl, session.apiUrl, data.streamToken);
      const whepRaw =
        data.protocols?.whepUrl
        ?? (data.protocols?.webrtcUrl ? `${data.protocols.webrtcUrl.replace(/\/+$/, '')}/whep` : null);
      const whepUrl = authenticatedMediaUrl(whepRaw, session.apiUrl, data.streamToken);
      // Poster montado a partir do session.apiUrl (alcançável pelo celular), não
      // do host que a API devolve (pode ser interno do Docker atrás do nginx).
      const posterUrl = data.streamToken ? cameraPosterUrl(session.apiUrl, cameraId, data.streamToken) : null;
      setStreamUrls((current) => ({ ...current, [cameraId]: hlsUrl }));
      setStreamWhep((current) => ({ ...current, [cameraId]: whepUrl }));
      // O token do poster expira rapidamente. Preserve o arquivo persistente
      // já salvo no aparelho para a lista não voltar a depender da rede.
      setStreamPosters((current) => current[cameraId]
        ? current
        : ({ ...current, [cameraId]: posterUrl }));
      if (session.apiUrl.startsWith('https://') && ((hlsUrl && !isSecureMediaUrl(hlsUrl)) || (whepUrl && !isSecureMediaUrl(whepUrl)))) {
        setLastSyncError('A mídia ao vivo precisa ser publicada por HTTPS nesta instalação.');
      }
    } catch (error) {
      if (sessionTokenRef.current !== token || streamRequestRef.current.get(cameraId) !== generation) return;
      if (viewMode === 'grid-audio' && audioPreparadoCameraRef.current === cameraId) {
        audioPreparadoCameraRef.current = null;
      }
      setStreamUrls((current) => ({ ...current, [cameraId]: null }));
      setStreamWhep((current) => ({ ...current, [cameraId]: null }));
      // Falhar ao abrir o vídeo não apaga o último snapshot válido. Assim a
      // câmera não vira um quadro quebrado durante uma oscilação passageira.
      // O servidor explica o motivo (ex.: "Câmera desativada. Reative-a nas
      // configurações"). Engolir isso deixava o operador diante de um quadro
      // preto sem saber que a câmera havia sido desligada de propósito.
      const motivo = userFacingError(error, 'Não foi possível concluir esta ação agora. Tente novamente.');
      if (motivo && liveCameraIdRef.current === cameraId && !/\b(401|403)\b/.test(motivo)) {
        setLastSyncError(motivo);
      }
    }
  };

  // Posters ficam em cache local por 3 dias. Somente um lote pequeno é renovado
  // por ciclo; centenas de câmeras nunca disputam rede/CPU ao abrir o app.
  const loadAllPosters = async (cams: Camera[]) => {
    if (!session || cams.length === 0) return;
    const scope = `${session.apiUrl}|${session.user.id}`;
    const posterSessionGeneration = sessionGenerationRef.current;
    const cached = await loadCachedPosters(scope, cams.map((camera) => camera.id));
    if (posterSessionGeneration !== sessionGenerationRef.current) return;
    setStreamPosters((current) => ({ ...current, ...cached.posters }));
    const stale = new Set(cached.staleIds);
    const candidates = cams
      .filter((camera) => camera.status?.toUpperCase() === 'ONLINE' && stale.has(camera.id));
    const start = candidates.length ? posterBatchCursorRef.current % candidates.length : 0;
    const rotated = [...candidates.slice(start), ...candidates.slice(0, start)];
    const onlineCameras = rotated.slice(0, POSTER_REFRESH_BATCH);
    // Garante progresso mesmo se uma câmera ONLINE não conseguir gerar frame:
    // a próxima rodada começa depois dela, sem bloquear o restante da frota.
    posterBatchCursorRef.current = candidates.length
      ? (start + onlineCameras.length) % candidates.length
      : 0;
    if (!onlineCameras.length) return;
    const token = session.token;
    const generation = ++posterRequestRef.current;
    try {
      const { items } = await request<{ items: { cameraId: string; streamToken: string }[] }>(
        session.apiUrl,
        '/camera-stream/poster-tokens',
        session.token,
        { method: 'POST', body: JSON.stringify({ cameraIds: onlineCameras.map((c) => c.id) }) },
      );
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          if (sessionTokenRef.current !== token || posterRequestRef.current !== generation) return;
          const url = `${cameraPosterUrl(session.apiUrl, item.cameraId, item.streamToken)}&fresh=1`;
          try {
            const localUri = await savePoster(scope, item.cameraId, url);
            if (sessionTokenRef.current !== token || posterRequestRef.current !== generation) return;
            setStreamPosters((current) => ({ ...current, [item.cameraId]: localUri }));
          } catch {
            // Mantém o último frame conhecido, mesmo offline.
          }
        }
      };
      // Um por vez também evita corrida no índice persistido do cache.
      await worker();
    } catch {
      // sem posters: os tiles caem no gradiente placeholder.
    }
  };

  const refreshPoster = async (cameraId: string, captureNow = false): Promise<string | null> => {
    if (!session) return null;
    const token = session.token;
    try {
      const { items } = await request<{ items: { cameraId: string; streamToken: string }[] }>(
        session.apiUrl,
        '/camera-stream/poster-tokens',
        token,
        { method: 'POST', body: JSON.stringify({ cameraIds: [cameraId] }) },
      );
      if (sessionTokenRef.current !== token) return null;
      const item = items[0];
      if (!item) return null;
      const url = `${cameraPosterUrl(session.apiUrl, cameraId, item.streamToken)}&fresh=1${captureNow ? '&capture=1' : ''}`;
      const scope = `${session.apiUrl}|${session.user.id}`;
      const localUri = await savePoster(scope, cameraId, url);
      if (sessionTokenRef.current === token) {
        setStreamPosters((current) => ({ ...current, [cameraId]: localUri }));
        return localUri;
      }
      return null;
    } catch { return null; }
  };

  const applyThumbnailTokens = async (items: Recording[], generation?: number) => {
    if (!session || !items.length) return;
    const token = session.token;
    const thumbnailTokens = await request<Record<string, string>>(
      session.apiUrl,
      '/recordings/thumbnail-tokens',
      token,
      { method: 'POST', body: JSON.stringify({ recordingIds: items.map((item) => item.id) }) },
    );
    if (sessionTokenRef.current !== token || (generation != null && recordingRequestRef.current !== generation)) return;
    setRecordings((current) => current.map((item) => {
      const thumbnailToken = thumbnailTokens[item.id];
      return thumbnailToken ? {
        ...item,
        thumbnailUrl: recordingThumbnailUrl(session.apiUrl, item.id, thumbnailToken),
      } : item;
    }));
  };

  const refreshExpiredThumbnails = () => {
    const now = Date.now();
    if (now - lastThumbnailRefreshRef.current < 5_000) return;
    lastThumbnailRefreshRef.current = now;
    if (recordingsRef.current.length) {
      void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
    }
  };

  const loadRecordings = async (cameraId: string, date = recordingDate, append = false) => {
    if (!session) return;
    const token = session.token;
    const generation = ++recordingRequestRef.current;
    const offset = append ? recordingsRef.current.length : 0;
    if (append) setRecordingsLoadingMore(true);
    else {
      setRecordingsLoading(true);
      setRecordingsError(null);
      setRecordings([]);
      setRecordingsTotal(0);
    }
    try {
      const { from, to } = localDayIsoRange(date);
      const data = await request<{ items: Recording[]; total?: number }>(
        session.apiUrl,
        `/recordings?cameraId=${encodeURIComponent(cameraId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${RECORDINGS_PAGE_SIZE}&offset=${offset}&sort=desc`,
        token,
      );
      if (
        sessionTokenRef.current !== token
        || recordingRequestRef.current !== generation
        || selectedCameraIdRef.current !== cameraId
        || recordingDateRef.current !== date
      ) return;
      const items = Array.isArray(data.items) ? data.items.map((item) => ({ ...item, thumbnailUrl: null })) : [];
      setRecordings((current) => append
        ? [...current, ...items.filter((item) => !current.some((existing) => existing.id === item.id))]
        : items);
      setRecordingsTotal(Number.isFinite(data.total)
        ? Number(data.total)
        : offset + items.length + (items.length === RECORDINGS_PAGE_SIZE ? 1 : 0));
      setRecordingsError(null);
      if (!append) setActivePlayback(null);
      try { await applyThumbnailTokens(items, generation); } catch { /* lista permanece funcional */ }
    } catch (error) {
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation) return;
      const status = (error as { status?: number })?.status;
      setRecordingsError(status === 403
        ? 'Você não possui permissão para visualizar estas gravações.'
        : userFacingError(error, 'Não foi possível carregar as gravações. Tente novamente.'));
    } finally {
      if (recordingRequestRef.current === generation) {
        setRecordingsLoading(false);
        setRecordingsLoadingMore(false);
      }
    }
  };

  const loadMoreRecordings = () => {
    if (!selectedCamera || recordingsLoading || recordingsLoadingMore || recordingsRef.current.length >= recordingsTotal) return;
    void loadRecordings(selectedCamera.id, recordingDateRef.current, true);
  };

  const loadLatestRecordingDate = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    const generation = ++recordingRequestRef.current;
    setRecordingsLoading(true);
    setRecordingsError(null);
    setRecordings([]);
    setRecordingsTotal(0);
    setActivePlayback(null);
    try {
      const data = await request<{ items: Recording[] }>(
        session.apiUrl,
        `/recordings?cameraId=${encodeURIComponent(cameraId)}&limit=1&sort=desc`,
        session.token,
      );
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation || recordingDateCameraRef.current !== cameraId) return;
      const latest = Array.isArray(data.items) ? data.items[0] : null;
      const latestDate = latest?.startedAt ? localDateKey(new Date(latest.startedAt)) : localDateKey();
      if (recordingDateRef.current === latestDate) {
        await loadRecordings(cameraId, latestDate);
      } else {
        setRecordingDate(latestDate);
      }
    } catch (error) {
      if (sessionTokenRef.current !== token || recordingRequestRef.current !== generation || recordingDateCameraRef.current !== cameraId) return;
      const status = (error as { status?: number })?.status;
      setRecordingsError(status === 403
        ? 'Você não possui permissão para visualizar estas gravações.'
        : userFacingError(error, 'Não foi possível localizar a gravação mais recente. Tente novamente.'));
    } finally {
      if (recordingRequestRef.current === generation) setRecordingsLoading(false);
    }
  };

  // Silenciamento de notificações por câmera (por usuário). Busca o estado ao
  // abrir a câmera e alterna com o botão "Alertas".
  const loadNotificationMute = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    try {
      const r = await request<{ muted: boolean }>(session.apiUrl, `/notifications/camera/${cameraId}/mute`, session.token);
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setNotificationsMuted(Boolean(r?.muted));
    } catch {
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setNotificationsMuted(false);
    }
  };

  const toggleNotifications = async (camera: Camera) => {
    if (!session) return;
    const next = !notificationsMuted;
    setNotificationsMuted(next); // otimista
    try {
      await request(session.apiUrl, `/notifications/camera/${camera.id}/mute`, session.token, {
        method: 'POST',
        body: JSON.stringify({ muted: next }),
      });
    } catch {
      if (liveCameraIdRef.current === camera.id) setNotificationsMuted(!next); // reverte em erro
    }
  };

  const shiftRecordingDate = (days: number) => {
    playbackRequestRef.current += 1;
    setRecordingDate((current) => shiftDateKey(current, days));
    setActivePlayback(null);
    setRecordings([]);
    setRecordingsError(null);
  };

  const sendPtz = async (direction: Direction) => {
    const target = liveCamera;
    if (!session || !target) return;
    if (target.canControl === false) {
      showAppNotice('Controle PTZ indisponível', 'Seu usuário não tem permissão para controlar esta câmera.', 'warning');
      return;
    }
    if (!capabilities.ptzControl) {
      showAppNotice('Controle PTZ sem permissão', 'Peça ao administrador para liberar o controle PTZ para o seu perfil.', 'warning');
      return;
    }
    setPtzActive(direction);
    setPtzFeedback(direction);
    // Mensagem SEMPRE limpa (nunca o erro técnico cru): o PTZ falha tanto com
    // HTTP 200 { status:'error' } (câmera recusa) quanto lançando exceção
    // (ONVIF indisponível). Nos dois casos o usuário só precisa saber isto:
    const isZoom = direction === 'ZoomIn' || direction === 'ZoomOut';
    const ptzFail = (message?: string) => {
      setPtzFeedback(null);
      showAppNotice(
        isZoom ? 'Zoom indisponível' : 'Controle PTZ indisponível',
        isZoom
          ? (/zoom/i.test(message ?? '') ? message! : 'Não foi possível usar o zoom desta câmera. Ela pode não oferecer zoom óptico.')
          : message || 'Não foi possível enviar o comando para a câmera. Tente novamente em alguns segundos.',
        'warning',
      );
    };
    try {
      const data = await request<{ status?: string; message?: string }>(
        session.apiUrl,
        `/ptz/${target.id}/move`,
        session.token,
        { method: 'POST', body: JSON.stringify({ action: 'step', direction, angleDegrees: 3 }) },
      );
      // A API já distingue equipamento fixo, credencial, perfil e rede. Não
      // descarte essa resposta e culpe senha/ONVIF quando a câmera não tem zoom.
      if (data?.status === 'error') { ptzFail(data.message); return; }
      setTimeout(() => setPtzFeedback(null), 650);
    } catch {
      ptzFail();
    } finally {
      setTimeout(() => setPtzActive(null), 220);
    }
  };

  const resetClipState = () => {
    if (clipLimitTimerRef.current) clearTimeout(clipLimitTimerRef.current);
    clipLimitTimerRef.current = null;
    clipPhaseRef.current = 'idle';
    clipIdRef.current = null;
    clipCameraRef.current = null;
    clipStartedAtRef.current = null;
    clipCancelRequestedRef.current = false;
    clipFinalizeSilentRef.current = false;
    setClipId(null);
    setRecordingActive(false);
    setRecordingBusy(false);
  };

  /**
   * Baixa um clipe já encerrado e persistido na fila local. O arquivo usa nome
   * determinístico para que retries não criem órfãos ou cópias duplicadas.
   */
  const downloadPendingClip = async (currentSession: Session, pending: PendingClip, silent = false): Promise<boolean> => {
    if (pendingClipDownloadsRef.current.has(pending.id)) return false;
    pendingClipDownloadsRef.current.add(pending.id);
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    const safeId = pending.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = `${FileSystem.documentDirectory}clip-${safeId}.mp4`;
    try {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      const url = clipDownloadUrl(currentSession.apiUrl, pending.id);
      const result = await downloadAuthenticated(currentSession.apiUrl, currentSession.token, url, target);
      if (result.status && result.status >= 400) throw new Error(`Falha ao baixar o clipe (HTTP ${result.status}).`);
      const thumbnailUri = await createClipThumbnail(result.uri, safeId);
      let savedToGallery = false;
      try { savedToGallery = await saveToGallery(result.uri); } catch { /* o clipe local continua válido */ }
      const next = await addClip(scope, {
        id: pending.id,
        cameraId: pending.cameraId,
        cameraName: pending.cameraName,
        uri: result.uri,
        thumbnailUri,
        createdAt: pending.createdAt,
      });
      await removePendingClip(scope, pending.id);
      if (sessionTokenRef.current === currentSession.token) setSavedClips(next);
      if (!silent && sessionTokenRef.current === currentSession.token) {
        showAppNotice('Gravação salva', savedToGallery
          ? 'Clipe salvo na galeria e em "Minhas gravações".'
          : 'Clipe salvo em "Minhas gravações". A galeria não concedeu permissão.', 'success');
      }
      return true;
    } catch (error) {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      if ([403, 404, 410].includes(Number((error as { status?: number })?.status))) {
        await removePendingClip(scope, pending.id);
        if (sessionTokenRef.current === currentSession.token) showAppNotice('Clipe indisponível', 'O prazo para baixar este clipe terminou ou seu acesso foi removido.', 'warning');
        return false;
      }
      if (!silent && sessionTokenRef.current === currentSession.token) {
        showAppNotice('Gravação pendente', `${userFacingError(error, 'Não foi possível salvar a gravação.')} Tentaremos novamente em breve.`, 'warning', 6500);
      }
      return false;
    } finally {
      pendingClipDownloadsRef.current.delete(pending.id);
    }
  };

  const resumePendingClips = async (currentSession: Session) => {
    if (AppState.currentState !== 'active') return;
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    const pending = await listPendingClips(scope);
    for (const item of pending) {
      if (AppState.currentState !== 'active' || sessionTokenRef.current !== currentSession.token) return;
      if (item.id === clipIdRef.current && clipStopPromiseRef.current) {
        await clipStopPromiseRef.current;
        continue;
      }
      let ready = item;
      if (item.status === 'recording') {
        try {
          await request(currentSession.apiUrl, `/camera-stream/clip/${encodeURIComponent(item.id)}/stop`, currentSession.token, {
            method: 'POST', body: JSON.stringify({}),
          });
          ready = { ...item, status: 'stopped' };
          await savePendingClip(scope, ready);
        } catch {
          // Mantém como recording para a próxima retomada; não tenta baixar um
          // arquivo que o servidor ainda pode estar escrevendo.
          continue;
        }
      }
      await downloadPendingClip(currentSession, ready, true);
    }
  };

  /** Encerra, persiste e indexa um clipe. A Promise compartilhada impede stop duplo. */
  const finalizeClip = async (camera: Camera, id: string, silent = false) => {
    if (clipStopPromiseRef.current) return clipStopPromiseRef.current;
    if (!session) { resetClipState(); return; }
    const currentSession = session;
    const scope = `${currentSession.apiUrl}|${currentSession.user.id}`;
    clipPhaseRef.current = 'stopping';
    setRecordingBusy(true);
    setRecordingActive(false);
    if (!silent) showAppNotice('Salvando gravação…', 'O clipe está sendo finalizado. Você pode continuar usando o app.', 'info', 6000);

    const run = (async () => {
      try {
        await request(currentSession.apiUrl, `/camera-stream/clip/${id}/stop`, currentSession.token, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const pending: PendingClip = {
          id,
          cameraId: camera.id,
          cameraName: camera.name,
          createdAt: clipStartedAtRef.current ?? new Date().toISOString(),
          status: 'stopped',
        };
        await savePendingClip(scope, pending);
        // Em background/logout, termina o processo do servidor e deixa a etapa
        // pesada de download/thumbnail para o próximo foreground.
        if (AppState.currentState === 'active' && sessionTokenRef.current === currentSession.token) {
          await downloadPendingClip(currentSession, pending, silent);
        }
      } catch (error) {
        if (!silent) showAppNotice('Não foi possível salvar a gravação', userFacingError(error, 'Tente novamente.'), 'error');
      } finally {
        clipStopPromiseRef.current = null;
        resetClipState();
      }
    })();
    clipStopPromiseRef.current = run;
    return run;
  };

  const startClip = async (camera: Camera) => {
    if (!session || clipPhaseRef.current !== 'idle') return;
    const currentSession = session;
    clipPhaseRef.current = 'starting';
    clipCameraRef.current = camera;
    clipCancelRequestedRef.current = false;
    setRecordingBusy(true);
    showAppNotice('Preparando gravação…', 'Aguarde um instante enquanto iniciamos o clipe.', 'info', 4000);

    const run = (async () => {
      try {
        const data = await request<{ clipId: string }>(
          currentSession.apiUrl,
          `/camera-stream/${camera.id}/clip/start`,
          currentSession.token,
          { method: 'POST', body: JSON.stringify({}) },
        );
        clipIdRef.current = data.clipId;
        const startedAt = new Date().toISOString();
        clipStartedAtRef.current = startedAt;
        setClipId(data.clipId);
        try {
          await savePendingClip(`${currentSession.apiUrl}|${currentSession.user.id}`, {
            id: data.clipId,
            cameraId: camera.id,
            cameraName: camera.name,
            createdAt: startedAt,
            status: 'recording',
          });
        } catch {
          await request(currentSession.apiUrl, `/camera-stream/clip/${encodeURIComponent(data.clipId)}/stop`, currentSession.token, {
            method: 'POST', body: JSON.stringify({}),
          }).catch(() => undefined);
          throw new Error('Não foi possível preparar o armazenamento local da gravação.');
        }
        if (clipCancelRequestedRef.current || sessionTokenRef.current !== currentSession.token) {
          await finalizeClip(camera, data.clipId, clipFinalizeSilentRef.current);
          return;
        }
        clipPhaseRef.current = 'recording';
        setRecordingActive(true);
        setRecordingBusy(false);
        showAppNotice('Gravação iniciada', 'Ela será encerrada automaticamente em 5 minutos. Você pode parar antes quando quiser.', 'success', 6000);
        clipLimitTimerRef.current = setTimeout(() => {
          if (clipPhaseRef.current === 'recording' && clipIdRef.current === data.clipId) {
            void finalizeClip(camera, data.clipId, false);
          }
        }, MANUAL_CLIP_MAX_MS - 1000);
      } catch (error) {
        const shouldNotify = sessionTokenRef.current === currentSession.token && !clipFinalizeSilentRef.current;
        resetClipState();
        if (shouldNotify) {
          showAppNotice('Não foi possível iniciar a gravação', userFacingError(error, 'Tente novamente.'), 'error');
        }
      } finally {
        clipStartPromiseRef.current = null;
      }
    })();
    clipStartPromiseRef.current = run;
    return run;
  };

  const stopActiveClip = async (silent = false) => {
    if (clipPhaseRef.current === 'idle') return;
    clipCancelRequestedRef.current = true;
    clipFinalizeSilentRef.current = silent;
    if (clipStartPromiseRef.current) await clipStartPromiseRef.current;
    if (clipStopPromiseRef.current) return clipStopPromiseRef.current;
    const camera = clipCameraRef.current;
    const id = clipIdRef.current;
    if (camera && id) return finalizeClip(camera, id, silent);
    resetClipState();
  };

  // Botão Gravar (SÓ celular): grava no servidor o trecho EXATO start→stop e,
  // ao parar, baixa o arquivo pro aparelho. Transições são bloqueadas para evitar
  // starts/stops concorrentes e clipes sem referência.
  /** Liga/desliga o som da câmera aberta pedindo ao servidor o perfil certo. */
  const definirAudioAoVivo = (ligado: boolean) => {
    setAudioAoVivo(ligado);
    audioAoVivoRef.current = ligado;
    const cameraId = liveCameraIdRef.current;
    if (!cameraId || !ligado || audioPreparadoCameraRef.current === cameraId) return;
    audioPreparadoCameraRef.current = cameraId;
    void loadStream(cameraId, 'grid-audio', true);
    if (hdWhepUrl) void loadHdStream(cameraId);
  };

  /** Estado da gravação da câmera NO SISTEMA (a que vai para o acervo). */
  const carregarEstadoGravacao = async (cameraId: string) => {
    if (!session) return;
    const token = session.token;
    try {
      const r = await request<{ manualRecordingActive?: boolean }>(
        session.apiUrl, `/cameras/${encodeURIComponent(cameraId)}/recording/status`, session.token,
      );
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setGravacaoSistemaAtiva(r.manualRecordingActive === true);
      setGravacaoSistemaConhecida(true);
    } catch {
      if (sessionTokenRef.current !== token || liveCameraIdRef.current !== cameraId) return;
      setGravacaoSistemaConhecida(false);
    }
  };

  /**
   * Arma ou para a gravação da câmera no sistema. Até aqui o app só sabia
   * capturar um clipe para o aparelho: quem estava em campo via a cena e não
   * conseguia mandar gravar no acervo.
   */
  const toggleGravacaoSistema = async (camera: Camera) => {
    if (!session || session.user.role === 'VIEWER' || gravacaoSistemaLock.current || !gravacaoSistemaConhecida || camera.canRecord !== true || camera.recordingMode === 'continuous') return;
    const generation = sessionGenerationRef.current;
    gravacaoSistemaLock.current = true;
    const alvo = !gravacaoSistemaAtiva;
    setGravacaoSistemaOcupada(true);
    try {
      await request(
        session.apiUrl,
        `/cameras/${encodeURIComponent(camera.id)}/recording/${alvo ? 'start' : 'stop'}`,
        session.token,
        { method: 'POST', body: JSON.stringify({}) },
      );
      await carregarEstadoGravacao(camera.id);
    } catch (error) {
      if (generation !== sessionGenerationRef.current) return;
      const motivo = userFacingError(error, 'Não foi possível alterar a gravação. Tente novamente.');
      showAppNotice(alvo ? 'Não foi possível gravar' : 'Não foi possível parar', motivo, 'error');
    } finally {
      gravacaoSistemaLock.current = false;
      setGravacaoSistemaOcupada(false);
    }
  };

  const mudarPreferenciaDePush = (habilitado: boolean) => {
    setPushHabilitado(habilitado);
    pushHabilitadoRef.current = habilitado;
    void salvarPreferenciaDePush(habilitado);
    if (!session) return;
    if (habilitado) void registerForPush(session.apiUrl, session.token).then((t) => setPushSuportado(Boolean(t)));
    else void unregisterFromPush(session.apiUrl, session.token);
  };

  const toggleRecording = async (camera: Camera) => {
    if (!session || recordingBusy) return;
    if (clipPhaseRef.current === 'recording') await finalizeClip(camera, clipIdRef.current!, false);
    else if (clipPhaseRef.current === 'idle') await startClip(camera);
  };

  const leaveLive = (afterLeave?: () => void) => {
    const finish = () => {
      playbackRequestRef.current += 1;
      setActivePlayback(null);
      setLiveCamera(null);
      afterLeave?.();
    };
    if (clipPhaseRef.current === 'idle') { finish(); return; }
    Alert.alert(
      'Gravação em andamento',
      'Deseja parar e salvar o clipe antes de sair da câmera?',
      [
        { text: 'Continuar gravando', style: 'cancel' },
        { text: 'Parar e sair', onPress: () => { void stopActiveClip(false).then(finish); } },
      ],
    );
  };

  // Reproduz um clipe local ("Minhas gravações") no mesmo player, sem servidor.
  const playLocalClip = (clip: SavedClip) => {
    playbackRequestRef.current += 1;
    setActivePlayback({
      recording: { id: clip.id, cameraId: clip.cameraId, startedAt: clip.createdAt, thumbnailUrl: clip.thumbnailUri },
      url: clip.uri,
      // Arquivo local: não passa pelo servidor, então não há fonte a negociar
      // nem token a renovar (o efeito de renovação ignora URLs `file:`).
      fonte: 'direta',
    });
  };

  const deleteLocalClip = async (clip: SavedClip) => {
    if (activePlayback?.recording.id === clip.id) {
      playbackRequestRef.current += 1;
      setActivePlayback(null);
    }
    setSavedClips(await removeClip(sessionScope, clip.id));
  };

  // Abre a reprodução pedindo a fonte DIRETA (arquivo original, pass-through).
  // `fonte` e `retomarEm` existem para o degrau de codec e para a renovação do
  // play-token, que trocam a URL sem o usuário perder o ponto do vídeo.
  const openPlayback = async (
    recording: Recording,
    opcoes: { fonte?: 'direta' | 'compativel'; retomarEm?: number; silencioso?: boolean } = {},
  ) => {
    if (!session || !capabilities.playback) return;
    const fonte = opcoes.fonte ?? 'direta';
    const token = session.token;
    const generation = ++playbackRequestRef.current;
    // Feedback IMEDIATO: o POST do play-token levava 2–4s em 3G e nada mudava
    // na tela nesse intervalo — o operador tocava de novo achando que falhou.
    if (!opcoes.silencioso) setAbrindoGravacaoId(recording.id);
    try {
      const data = await request<{ playToken: string }>(session.apiUrl, `/recordings/${recording.id}/play-token`, session.token, { method: 'POST' });
      const url = normalizeServerUrl(
        montarUrlDeReproducao(session.apiUrl, recording.id, data.playToken, fonte),
        session.apiUrl,
      );
      if (!url) throw new Error('URL de reprodução indisponível.');
      if (
        sessionTokenRef.current !== token
        || playbackRequestRef.current !== generation
        || selectedCameraIdRef.current !== recording.cameraId
      ) return;
      setActivePlayback({ recording, url, fonte, retomarEm: opcoes.retomarEm });
    } catch (error) {
      if (sessionTokenRef.current !== token || playbackRequestRef.current !== generation) return;
      // Renovação silenciosa não pode virar alerta: o vídeo está tocando.
      if (opcoes.silencioso) return;
      showAppNotice('Não foi possível abrir a gravação', userFacingError(error, 'Tente novamente.'), 'error');
    } finally {
      if (playbackRequestRef.current === generation) setAbrindoGravacaoId(null);
    }
  };

  const openAlarmRecording = async (alarm: Alarm) => {
    if (!session || !capabilities.playback) return;
    const generation = sessionGenerationRef.current;
    try {
      const target = await findAlarmRecording(session, alarm);
      if (generation !== sessionGenerationRef.current) return;
      if (!target) {
        showAppNotice('Sem gravação deste instante', 'Não há vídeo disponível para esta ocorrência. O vídeo ao vivo mostra apenas o momento atual.', 'warning');
        return;
      }
      selectedCameraIdRef.current = target.recording.cameraId;
      setSelectedCameraId(target.recording.cameraId);
      setTab('reproducao');
      await openPlayback(target.recording, { retomarEm: target.offset });
    } catch (error) {
      if (generation === sessionGenerationRef.current) showAppNotice('Não foi possível abrir a ocorrência', userFacingError(error, 'Tente novamente.'), 'error');
    }
  };

  // ── RENOVAÇÃO DO PLAY-TOKEN DURANTE A REPRODUÇÃO ──────────────────────────
  //
  // O token de reprodução vale 5 minutos e era emitido UMA vez, congelado na
  // URL. Pausar o vídeo (ou esgotar o buffer) por mais que isso e dar play/seek
  // levava 401 → "Não foi possível reproduzir". O web renova a cada 15s; aqui
  // basta reemitir antes de vencer, preservando o ponto em que o usuário está.
  const posicaoDoPlaybackRef = useRef(0);
  useEffect(() => {
    if (!activePlayback || activePlayback.url.startsWith('file:')) return;
    const timer = setInterval(() => {
      const atual = activePlaybackRef.current;
      if (!atual || atual.url.startsWith('file:')) return;
      void openPlayback(atual.recording, {
        fonte: atual.fonte,
        retomarEm: posicaoDoPlaybackRef.current,
        silencioso: true,
      });
    }, PLAY_TOKEN_RENEW_MS);
    return () => clearInterval(timer);
  }, [activePlayback?.recording.id, activePlayback?.fonte]);

  // Degrau de codec: o player não conseguiu decodificar o arquivo original
  // (codec exótico, ou aparelho sem HEVC por hardware). Aí sim vale pagar o
  // transcode — e só nesse caso.
  const tentarFonteCompativel = () => {
    const atual = activePlaybackRef.current;
    if (!atual || atual.fonte !== 'direta') return false;
    void openPlayback(atual.recording, {
      fonte: 'compativel',
      retomarEm: posicaoDoPlaybackRef.current,
    });
    return true;
  };

  const closePlayback = () => {
    playbackRequestRef.current += 1;
    setActivePlayback(null);
  };

  const retryPlayback = () => {
    const current = activePlayback;
    if (!current) return;
    if (current.url.startsWith('file:')) {
      closePlayback();
      const clip = savedClips.find((item) => item.id === current.recording.id);
      if (clip) setTimeout(() => playLocalClip(clip), 0);
      return;
    }
    // Ao repetir manualmente, volta para a fonte direta: se o problema era
    // token vencido, não há motivo para pagar transcode.
    void openPlayback(current.recording, { fonte: current.fonte, retomarEm: posicaoDoPlaybackRef.current });
  };

  const downloadRecording = async (recording: Recording) => {
    if (!session || !capabilities.exportEvidence || downloadingRef.current.has(recording.id)) return;
    const currentSession = session;
    downloadingRef.current.add(recording.id);
    setDownloadingIds(Array.from(downloadingRef.current));
    const safeId = recording.id.replace(/[^a-zA-Z0-9_-]/g, '-');
    const target = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}download-${safeId}-${Date.now()}.mp4`;
    try {
      const url = normalizeServerUrl(`${currentSession.apiUrl}/recordings/${encodeURIComponent(recording.id)}/download`, currentSession.apiUrl);
      if (!url) throw new Error('URL de download indisponível.');
      const result = await downloadAuthenticated(currentSession.apiUrl, currentSession.token, url, target);
      if (result.status && result.status >= 400) throw new Error(`Falha no download (HTTP ${result.status}).`);
      const ok = await saveToGallery(result.uri);
      if (sessionTokenRef.current === currentSession.token) {
        showAppNotice(ok ? 'Gravação salva' : 'Permissão necessária', ok ? 'A gravação está na galeria.' : 'Permita o acesso à galeria para salvar gravações.', ok ? 'success' : 'warning');
      }
    } catch (error) {
      if (sessionTokenRef.current === currentSession.token) {
        showAppNotice('Não foi possível baixar', userFacingError(error, 'Tente novamente.'), 'error');
      }
    } finally {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      downloadingRef.current.delete(recording.id);
      if (sessionTokenRef.current === currentSession.token) setDownloadingIds(Array.from(downloadingRef.current));
    }
  };

  const takeSnapshot = async (camera: Camera) => {
    if (!session || snapshotBusy) return;
    const currentSession = session;
    setSnapshotBusy(true);
    showAppNotice('Capturando foto…', 'Buscando a imagem mais recente da câmera.', 'info', 3500);
    // Emite token novo e pede ao endpoint um frame fresco; não reutiliza o
    // snapshot que pode estar há minutos visível no tile.
    const poster = await refreshPoster(camera.id, true);
    if (!poster) {
      showAppNotice('Imagem indisponível', 'Aguarde a câmera carregar e tente novamente.', 'warning');
      setSnapshotBusy(false);
      return;
    }
    const target = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}snapshot-${camera.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}.jpg`;
    try {
      // `refreshPoster` já pediu um frame atual e o guardou localmente. Copiar
      // esse arquivo evita uma segunda captura e também funciona offline.
      if (poster.startsWith('file:')) await FileSystem.copyAsync({ from: poster, to: target });
      else {
        const result = await FileSystem.downloadAsync(poster, target);
        if (result.status && result.status >= 400) throw new Error(`Falha ao capturar a imagem (HTTP ${result.status}).`);
      }
      const ok = await saveToGallery(target);
      if (sessionTokenRef.current === currentSession.token) {
        showAppNotice(ok ? 'Foto salva' : 'Permissão necessária', ok ? 'A foto está na galeria.' : 'Permita o acesso à galeria para salvar fotos.', ok ? 'success' : 'warning');
      }
    } catch (error) {
      if (sessionTokenRef.current === currentSession.token) {
        showAppNotice('Não foi possível salvar a foto', userFacingError(error, 'Tente novamente.'), 'error');
      }
    } finally {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
      if (sessionTokenRef.current === currentSession.token) setSnapshotBusy(false);
    }
  };

  const openLive = (camera: Camera) => {
    if (!capabilities.liveView) {
      showAppNotice('Acesso não permitido', 'Seu usuário não pode visualizar câmeras ao vivo.', 'warning');
      return;
    }
    closePlayback();
    setSelectedCameraId(camera.id);
    setLiveCamera(camera);
  };

  // Deep link do push: quando as câmeras estiverem carregadas, abre AO VIVO a
  // câmera do alarme tocado (funciona também no cold start pelo push).
  useEffect(() => {
    if (!pendingPushCameraId || cameras.length === 0) return;
    const target = cameras.find((camera) => camera.id === pendingPushCameraId);
    setPendingPushCameraId(null);
    if (target && target.enabled !== false) openLive(target);
  }, [pendingPushCameraId, cameras]);

  // Rede de segurança da orientação: fora da câmera aberta o app é SEMPRE
  // retrato. A tela cheia trava paisagem; se qualquer caminho de saída pular o
  // destravamento (back físico, crash da tela, troca de aba), aqui conserta.
  useEffect(() => {
    if (!isRedesign || liveCamera) return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => undefined);
  }, [liveCamera?.id]);

  // Voltar físico respeita a confirmação de gravação em vez de encerrar o app.
  useEffect(() => {
    if (!liveCamera) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      leaveLive();
      return true;
    });
    return () => sub.remove();
  }, [liveCamera?.id]);

  // Se o app perde o primeiro plano, finaliza o clipe para não deixar FFmpeg
  // rodando no servidor sem feedback no aparelho.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state === 'active') {
        void flushPushRemovals();
        if (session && pushHabilitadoRef.current) void registerForPush(session.apiUrl, session.token);
        // Revalida permissões concedidas/revogadas pela Central sem exigir logout.
        if (session) setPermissionsRefreshNonce((current) => current + 1);
        if (session && !refreshing) void loadAll(true);
        if (cameras.length) void loadAllPosters(cameras);
        if (session) void resumePendingClips(session);
        if (capabilities.playback && recordingsRef.current.length) {
          void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
        }
      } else if (clipPhaseRef.current !== 'idle') {
        void stopActiveClip(true);
      }
    });
    return () => sub.remove();
  }, [session?.token, refreshing, capabilities.playback, cameras]);

  // Atualiza estados ONLINE/OFFLINE sem exigir pull-to-refresh. Timers ficam
  // suspensos no background para poupar bateria e evitar requests inúteis.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active' && !refreshing) void loadAll(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [session?.token, refreshing]);

  // Verifica o cache em intervalos leves; só imagens com 3 dias entram no lote.
  useEffect(() => {
    if (!session || !cameras.length) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active') void loadAllPosters(cameras);
    }, 20 * 60 * 1000);
    return () => clearInterval(timer);
  }, [session?.token, cameras]);

  // Tokens das miniaturas também expiram. Renova apenas quando alguma tela que
  // mostra gravações está ativa.
  useEffect(() => {
    if (!session || !capabilities.playback || (!liveCamera && tab !== 'reproducao')) return;
    const timer = setInterval(() => {
      if (appStateRef.current === 'active' && recordingsRef.current.length) {
        void applyThumbnailTokens(recordingsRef.current).catch(() => undefined);
      }
    }, 3.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [session?.token, capabilities.playback, liveCamera?.id, tab]);

  if (restoringSession) {
    return (
      <SafeAreaView style={[styles.screen, styles.restoring, { backgroundColor: theme.bg }]}>
        <StatusBar style={statusBarStyle} />
        <ActivityIndicator size="large" color={theme.accent} />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
        <StatusBar style={statusBarStyle} />
        <LoginScreen
          apiUrl={apiUrl}
          email={email}
          password={password}
          loading={loading}
          onApiUrlChange={setApiUrl}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={login}
          onForgotPassword={forgotPassword}
          biometricLabel={biometricLabel}
          biometricAvailable={Boolean(pendingBiometricSession && biometricEnabled && biometricAvailable)}
          onBiometric={() => { void unlockPendingSession(); }}
        />
      </SafeAreaView>
    );
  }

  // Ao vivo: overlay em tela cheia, sem BottomTabs.
  if (liveCamera) {
    const live = cameras.find((c) => c.id === liveCamera.id) ?? liveCamera;
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: '#070809' }]}>
        <StatusBar style="light" />
        {isRedesign ? (
          <LiveScreenRedesign
            camera={live}
            topInset={TOP_SAFE}
            streamUrl={streamUrls[live.id] ?? null}
            whepUrl={streamWhep[live.id] ?? null}
            posterUrl={streamPosters[live.id] ?? null}
            hdUrl={hdUrl}
            hdWhepUrl={hdWhepUrl}
            onRequestHd={() => loadHdStream(live.id)}
            onExitHd={() => { void loadStream(live.id, 'grid'); }}
            recordings={recordings}
            recordingsLoading={recordingsLoading}
            recordingsLoadingMore={recordingsLoadingMore}
            recordingsError={recordingsError}
            recordingsTotal={recordingsTotal}
            recordingDate={recordingDate}
            activePlayback={activePlayback}
            recordingActive={recordingActive}
            recordingBusy={recordingBusy}
            snapshotBusy={snapshotBusy}
            ptzActive={ptzActive}
            ptzFeedback={ptzFeedback}
            // A câmera já vem marcada pela API com o nível de acesso efetivo.
            // Não escondemos o controle por uma leitura temporária de perfil:
            // o endpoint PTZ continua sendo a autoridade final e devolve uma
            // mensagem clara se a permissão tiver sido revogada.
            canPtz={live.canControl !== false}
            detections={liveDetections}
            canPlayback={capabilities.playback}
            canDownload={capabilities.exportEvidence}
            downloadingIds={downloadingIds}
            myRecordings={savedClips.filter((c) => c.cameraId === live.id)}
            notificationsMuted={notificationsMuted}
            onToggleNotifications={toggleNotifications}
            onBack={() => leaveLive()}
            onSendPtz={sendPtz}
            onToggleRecording={toggleRecording}
            systemRecordingActive={gravacaoSistemaAtiva}
            systemRecordingBusy={gravacaoSistemaOcupada || !gravacaoSistemaConhecida}
            onToggleSystemRecording={session.user.role !== 'VIEWER' && live.canRecord === true && live.recordingMode !== 'continuous' ? c => { void toggleGravacaoSistema(c); } : undefined}
            audioLigado={audioAoVivo}
            onAudioLigadoChange={definirAudioAoVivo}
            onSnapshot={takeSnapshot}
            onOpenPlayback={(recording, initialPositionSeconds) => openPlayback(recording, { retomarEm: initialPositionSeconds })}
            onClosePlayback={closePlayback}
            onRetryPlayback={retryPlayback}
            onNaoDecodificou={tentarFonteCompativel}
            onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
            onPreviousDate={() => shiftRecordingDate(-1)}
            onNextDate={() => shiftRecordingDate(1)}
            onSelectDate={(key) => setRecordingDate(key)}
            onDownloadRecording={downloadRecording}
            onLoadMoreRecordings={loadMoreRecordings}
            onRetryRecordings={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
            onThumbnailError={refreshExpiredThumbnails}
            onPlayLocal={playLocalClip}
            onDeleteLocal={deleteLocalClip}
            onRefreshStream={() => { void loadStream(live.id, 'grid', true); }}
            abrindoGravacaoId={abrindoGravacaoId}
          />
        ) : (
        <LiveScreen
          camera={live}
          topInset={TOP_SAFE}
          streamUrl={streamUrls[live.id] ?? null}
          whepUrl={streamWhep[live.id] ?? null}
          posterUrl={streamPosters[live.id] ?? null}
          hdUrl={hdUrl}
          hdWhepUrl={hdWhepUrl}
          onRequestHd={() => loadHdStream(live.id)}
          onExitHd={() => { void loadStream(live.id, 'grid'); }}
          detections={liveDetections}
          ptzActive={ptzActive}
          ptzFeedback={ptzFeedback}
          recordings={recordings}
          recordingsTotal={recordingsTotal}
          recordingsLoading={recordingsLoading}
          recordingsLoadingMore={recordingsLoadingMore}
          recordingsError={recordingsError}
          myRecordings={savedClips.filter((c) => c.cameraId === live.id)}
          onPlayLocal={playLocalClip}
          onDeleteLocal={deleteLocalClip}
          recordingDate={recordingDate}
          activePlayback={activePlayback}
          recordingActive={recordingActive}
          recordingBusy={recordingBusy}
          snapshotBusy={snapshotBusy}
          onBack={() => leaveLive()}
          onSendPtz={sendPtz}
          onToggleRecording={toggleRecording}
          audioLigado={audioAoVivo}
          onAudioLigadoChange={definirAudioAoVivo}
          gravacaoSistemaAtiva={gravacaoSistemaAtiva}
          gravacaoSistemaOcupada={gravacaoSistemaOcupada || !gravacaoSistemaConhecida}
          onToggleGravacaoSistema={session.user.role !== 'VIEWER' && live.canRecord === true && live.recordingMode !== 'continuous' ? (c) => { void toggleGravacaoSistema(c); } : undefined}
          onSnapshot={takeSnapshot}
          onOpenPlayback={openPlayback}
          onClosePlayback={closePlayback}
          onRetryPlayback={retryPlayback}
          onNaoDecodificou={tentarFonteCompativel}
          onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
          onDownloadRecording={downloadRecording}
          onPreviousDate={() => shiftRecordingDate(-1)}
          onNextDate={() => shiftRecordingDate(1)}
          onLoadMoreRecordings={loadMoreRecordings}
          onRetryRecordings={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
          onThumbnailError={refreshExpiredThumbnails}
          onRefreshStream={() => { void loadStream(live.id, 'grid', true); }}
          canPlayback={capabilities.playback}
          canDownload={capabilities.exportEvidence}
          downloadingIds={downloadingIds}
          notificationsMuted={notificationsMuted}
          onToggleNotifications={toggleNotifications}
          abrindoGravacaoId={abrindoGravacaoId}
          />
        )}
        {/* Menu inferior também na câmera aberta — tocar numa aba sai do vídeo e
            vai pra ela. Escondido em paisagem (vídeo em tela cheia usa a área).
            No redesign a tela da câmera é cheia (tem o próprio "voltar"). */}
        {!isRedesign && winWidth <= winHeight ? (
          <BottomTabs
            active={tab}
            alarmCount={openAlarmCount}
            onChange={(next) => leaveLive(() => setTab(next))}
          />
        ) : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style={statusBarStyle} />
      {/* Fundo em GRADIENTE quando o branding define 2 cores (bg != bg2); senão
          o backgroundColor sólido do SafeAreaView aparece. As telas são
          transparentes, então o gradiente é visível atrás delas. */}
      {theme.bg2 !== theme.bg ? (
        <LinearGradient colors={[theme.bg, theme.bg2]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      ) : null}
      {/* BARREIRA POR ABA. Um erro numa tela não deve derrubar a live que o
          operador está assistindo. A `resetKey` limpa o erro ao trocar de aba. */}
      <View style={[styles.body, { paddingTop: TOP_SAFE }]}>
        <ErrorBoundary resetKey={tab}>
        {tab === 'central' && (
          isRedesign ? (
            <HomeRedesign
              cameras={cameras}
              user={session.user}
              streamPosters={streamPosters}
              alarms={alarms}
              alarmCount={openAlarmCount}
              refreshing={refreshing}
              onRefresh={loadAll}
              onOpenCamera={openLive}
              onOpenAlarms={() => setTab('alarmes')}
              onOpenMosaic={() => setTab('mosaico')}
              onOpenPlayback={() => setTab('reproducao')}
              facilityName={branding.facilityName}
              onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
              apiUrl={session.apiUrl}
              token={session.token}
              onCamerasChanged={() => { void loadAll(true); }}
            />
          ) : (
          <CentralScreen
            cameras={cameras}
            user={session.user}
            streamPosters={streamPosters}
            operationalMessages={operationalMessages}
            alarms={alarms}
            alarmCount={openAlarmCount}
            refreshing={refreshing}
            onRefresh={loadAll}
            onOpenCamera={openLive}
            onOpenAlarms={() => setTab('alarmes')}
            onOpenMosaic={() => setTab('mosaico')}
            onOpenPlayback={() => setTab('reproducao')}
            onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
            apiUrl={session.apiUrl}
            token={session.token}
            onCamerasChanged={() => { void loadAll(true); }}
          />
          )
        )}

        {tab === 'mosaico' && (
          isRedesign ? (
            <CamerasRedesign
              cameras={cameras}
              streamPosters={streamPosters}
              streamUrls={streamUrls}
              streamWhep={streamWhep}
              refreshing={refreshing}
              onRefresh={loadAll}
              onOpenCamera={openLive}
              onRequestStreams={(cameraIds) => { void Promise.all(cameraIds.map((id) => loadStream(id, 'grid'))); }}
              onRefreshStream={(cameraId) => { void loadStream(cameraId, 'grid', true); }}
              apiUrl={session.apiUrl}
              token={session.token}
              onCamerasChanged={() => { void loadAll(true); }}
            />
          ) : (
          <MosaicScreen
            cameras={cameras}
            streamUrls={streamUrls}
            streamWhep={streamWhep}
            streamPosters={streamPosters}
            refreshing={refreshing}
            canLiveView={capabilities.liveView}
            onRefresh={loadAll}
            onOpenCamera={openLive}
            onRequestStreams={(cameraIds) => { void Promise.all(cameraIds.map((id) => loadStream(id, 'grid'))); }}
            onRefreshStream={(cameraId) => { void loadStream(cameraId, 'grid', true); }}
            onPosterError={(cameraId) => { void refreshPoster(cameraId); }}
          />
          )
        )}

        {tab === 'reproducao' && (
          <PlaybackScreen
            cameras={cameras}
            selectedCamera={selectedCamera}
            recordings={recordings}
            recordingsTotal={recordingsTotal}
            loading={recordingsLoading}
            loadingMore={recordingsLoadingMore}
            error={recordingsError}
            activePlayback={activePlayback}
            recordingDate={recordingDate}
            canPlayback={capabilities.playback}
            canDownload={capabilities.exportEvidence}
            downloadingIds={downloadingIds}
            onSelectCamera={(cameraId) => { setSelectedCameraId(cameraId); closePlayback(); }}
            onOpenPlayback={(recording, initialPositionSeconds) => openPlayback(recording, { retomarEm: initialPositionSeconds })}
            onClosePlayback={closePlayback}
            onRetryPlayback={retryPlayback}
            onNaoDecodificou={tentarFonteCompativel}
            onProgressoPlayback={(segundos: number) => { posicaoDoPlaybackRef.current = segundos; }}
            onDownloadRecording={downloadRecording}
            onPreviousDate={() => shiftRecordingDate(-1)}
            onNextDate={() => shiftRecordingDate(1)}
            onLoadMore={loadMoreRecordings}
            onRetry={() => { if (selectedCamera) void loadRecordings(selectedCamera.id, recordingDateRef.current); }}
            onThumbnailError={refreshExpiredThumbnails}
            abrindoGravacaoId={abrindoGravacaoId}
          />
        )}

        {tab === 'ronda' && (
          <RondaScreen
            rondas={rondas}
            mosaicos={mosaicos}
            cameras={cameras}
            streamUrls={streamUrls}
            streamWhep={streamWhep}
            streamPosters={streamPosters}
            refreshing={refreshing}
            onRefresh={() => { void loadAll(); }}
            onRequestStreams={(ids) => { void Promise.all(ids.map((id) => loadStream(id, modoDaGrade()))); }}
            onOpenCamera={openLive}
          />
        )}

        {tab === 'alarmes' && (
          isRedesign ? (
            <EventsRedesign
              alarms={alarms}
              cameras={cameras}
              streamPosters={streamPosters}
              highlightedAlarmId={highlightedAlarmId}
              refreshing={refreshing}
              onRefresh={() => { void reloadAlarms(); }}
              onOpenCamera={(cameraId) => { const c = cameras.find((x) => x.id === cameraId); if (c) openLive(c); }}
              canManage={canManageAlarms}
              onAck={(alarm) => { void ackAlarm(alarm); }}
              onResolve={(alarm) => { void resolveAlarm(alarm); }}
              onOpenOccurrence={capabilities.playback ? alarm => { void openAlarmRecording(alarm); } : undefined}
              erro={alarmesErro}
            />
          ) : (
          <AlarmsScreen
            alarms={alarms}
            highlightedAlarmId={highlightedAlarmId}
            canManage={canManageAlarms}
            refreshing={alarmesCarregando}
            onRefresh={() => { void reloadAlarms(); }}
            erro={alarmesErro}
            onAck={ackAlarm}
            onResolve={resolveAlarm}
            onOpenOccurrence={capabilities.playback ? alarm => { void openAlarmRecording(alarm); } : undefined}
            onOpenCamera={(cameraId) => {
              const camera = cameras.find((c) => c.id === cameraId);
              if (camera) openLive(camera);
            }}
          />
          )
        )}

        {tab === 'alarmes' && alarmsTotal > 0 && (
          <View style={{ padding: 10, alignItems: 'center' }}>
            <Text style={{ color: theme.text }}>Carregados {alarms.length} de {alarmsTotal} eventos</Text>
            {alarms.length < alarmsTotal && <Pressable disabled={alarmesCarregando} accessibilityRole="button" onPress={() => { void loadMoreAlarms(); }} style={{ padding: 10 }}>
              <Text style={{ color: theme.accent }}>{alarmesCarregando ? 'Carregando…' : 'Carregar mais eventos'}</Text>
            </Pressable>}
          </View>
        )}

        {tab === 'ajustes' && (
          isRedesign ? (
            <SettingsRedesign
              user={session.user}
              apiUrl={session.apiUrl}
              token={session.token}
              connected={!lastSyncError}
              biometricAvailable={biometricAvailable}
              biometricEnabled={biometricEnabled}
              biometricLabel={biometricLabel}
              onBiometricChange={(enabled) => { void changeBiometricPreference(enabled); }}
              onLogout={confirmLogout}
              onCamerasChanged={() => { void loadAll(true); }}
              facilityName={branding.facilityName}
              pushEnabled={pushHabilitado}
              pushSupported={pushSuportado}
              onPushChange={mudarPreferenciaDePush}
            />
          ) : (
          <SettingsScreen
            user={session.user}
            apiUrl={session.apiUrl}
            token={session.token}
            connected={!lastSyncError}
            biometricAvailable={biometricAvailable}
            biometricEnabled={biometricEnabled}
            biometricLabel={biometricLabel}
            onBiometricChange={(enabled) => { void changeBiometricPreference(enabled); }}
            onLogout={confirmLogout}
            onCamerasChanged={() => { void loadAll(true); }}
            pushEnabled={pushHabilitado}
            pushSupported={pushSuportado}
            onPushChange={mudarPreferenciaDePush}
          />
          )
        )}
        </ErrorBoundary>
      </View>

      {isRedesign ? (
        <BottomTabsRedesign
          active={tab}
          onChange={(next) => { if (next !== 'reproducao') closePlayback(); setTab(next); }}
          alarmCount={openAlarmCount}
        />
      ) : (
      <BottomTabs
        active={tab}
        onChange={(next) => {
          if (next !== 'reproducao') closePlayback();
          setTab(next);
        }}
        alarmCount={openAlarmCount}
      />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  restoring: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
});
