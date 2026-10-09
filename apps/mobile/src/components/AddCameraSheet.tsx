/**
 * Jornada de instalação de câmera privada.
 *
 * Começa pela intenção do usuário. IP e credenciais ficam claros no cadastro
 * manual; portas e caminho podem ser informados antes do teste.
 * A busca acontece no telefone (LAN do cliente) e combina ONVIF
 * WS-Discovery com mDNS. O backend valida credenciais/perfis e efetiva o
 * cadastro privado/LGPD.
 */
import * as Clipboard from 'expo-clipboard';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable,
  PermissionsAndroid, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { request } from '../services/api';
import { userFacingError } from '../services/user-facing-error';
import { captureInstallerLocation } from '../services/installer-location';
import { discoverCameras, scanLocalNetwork, type ScanProgress } from '../services/camera-discovery';
import { discoveredCameraPorts, mergeDiscoveredCameras, parseCameraQr, type DiscoveredCamera } from '../services/camera-discovery-core';
import { useTheme } from '../theme/ThemeProvider';
import type { Theme } from '../theme/theme';
import { cameraConnectionError, cameraConnectionPayload, cameraConnectionTestPayload, cameraSetupFailureMessage } from '../services/camera-setup';
import { Icon, type IconName } from './Icon';

interface AddCameraSheetProps {
  visible: boolean;
  apiUrl: string;
  token: string | null;
  onClose: () => void;
  onCreated?: () => void;
}

type Quota = { used: number; limit: number; canAdd: boolean };
type Screen = 'home' | 'discover' | 'qr' | 'provision' | 'details' | 'review' | 'success';
type SourceMode = 'rtsp_pull' | 'rtmp_push';

interface ConnectionResult {
  failureCode?: string | null;
  status: 'ONLINE' | 'OFFLINE';
  rtspReachableAny: boolean;
  rtspAuthOk: boolean;
  onvifReachable: boolean;
  ptzDigestOk: boolean;
  detectedRtspPort: number | null;
  detectedRtspPath: string | null;
  suggestedRtspPath: string | null;
  detectedOnvifPort: number | null;
  detectedOnvifPath: string | null;
  detectedOnvifProfileToken: string | null;
  detectedStream?: { codec?: string; width?: number; height?: number; fps?: number } | null;
  compatibility?: { level?: string; summary?: string; warnings?: string[] };
}

interface CreatedCamera { id: string; name: string; sourceMode?: SourceMode; rtmpIngest?: RtmpTarget }
interface RtmpTarget { fullUrl?: string | null; serverUrl?: string | null; streamKey?: string | null }
interface PreviewFrame { ok: boolean; imageDataUrl: string | null; reason?: string | null }

// 554 é a porta comum sugerida, não uma porta já detectada.
// A busca automática usa separadamente os candidatos do servidor.
const RTSP_PORT_DEFAULT = '554';

export function AddCameraSheet({ visible, apiUrl, token, onClose, onCreated }: AddCameraSheetProps) {
  const { theme } = useTheme();
  const [cameraPermission, askCameraPermission] = useCameraPermissions();
  const [screen, setScreen] = useState<Screen>('home');
  const [sourceMode, setSourceMode] = useState<SourceMode>('rtsp_pull');
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [rtspPort, setRtspPort] = useState(RTSP_PORT_DEFAULT);
  const [automaticPort, setAutomaticPort] = useState(false);
  const [httpPort, setHttpPort] = useState('80');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [rtspPath, setRtspPath] = useState('');
  const [onvifPort, setOnvifPort] = useState('');
  const [onvifPath, setOnvifPath] = useState<string | null>(null);
  const [onvifToken, setOnvifToken] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [manualConnectionNeeded, setManualConnectionNeeded] = useState(false);
  const [showConnectionOptions, setShowConnectionOptions] = useState(false);
  const [includeLocation, setIncludeLocation] = useState(false);
  const [torch, setTorch] = useState(false);
  const [qrLocked, setQrLocked] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [devices, setDevices] = useState<DiscoveredCamera[]>([]);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [preview, setPreview] = useState<PreviewFrame | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rtmpTarget, setRtmpTarget] = useState<RtmpTarget | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const historyRef = useRef<Screen[]>([]);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipboardValueRef = useRef<string | null>(null);
  // Invalida resultados assíncronos quando o usuário volta/fecha. Descoberta,
  // permissão, teste RTSP e cadastro não podem reabrir uma etapa já abandonada.
  const operationRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const qrLockRef = useRef(false);
  const qrTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quotaGenerationRef = useRef(0);
  const scrollRef = useRef<ScrollView>(null);

  const quotaFull = !!quota && !quota.canAdd;
  const draft = { ip, username, password, rtspPort: automaticPort ? '' : rtspPort, httpPort, onvifPort, rtspPath };
  const connectionError = !automaticPort && !rtspPort.trim() ? 'Informe a porta RTSP do vídeo.' : cameraConnectionError(draft);
  const planReady = !!quota?.canAdd && !quotaLoading && !quotaError;
  const canSave = !submitting && planReady && name.trim().length > 0 && (
    sourceMode === 'rtmp_push' || (!connectionError && !!connection?.rtspAuthOk)
  );

  const invalidateConnection = () => {
    operationRef.current += 1; requestRef.current?.abort();
    setConnection(null); setPreview(null); setChecking(false); setPreviewLoading(false); setError(null);
    setOnvifPath(null); setOnvifToken(null);
  };

  const reset = () => {
    operationRef.current += 1;
    quotaGenerationRef.current += 1;
    requestRef.current?.abort(); submittingRef.current = false;
    qrLockRef.current = false;
    if (qrTimerRef.current) clearTimeout(qrTimerRef.current);
    historyRef.current = [];
    setScreen('home'); setSourceMode('rtsp_pull'); setName(''); setIp('');
    setRtspPort(RTSP_PORT_DEFAULT); setHttpPort('80'); setUsername('admin'); setPassword(''); setRtspPath('');
    setAutomaticPort(false);
    setOnvifPort(''); setOnvifPath(null); setOnvifToken(null);
    setShowPass(false); setManualConnectionNeeded(false); setTorch(false); setQrLocked(false);
    setShowConnectionOptions(false); setIncludeLocation(false);
    setDevices([]); setDiscoveryWarnings([]); setConnection(null); setPreview(null); setPreviewLoading(false); setError(null);
    setRtmpTarget(null); setCopied(null); setDiscovering(false); setScanProgress(null); setChecking(false); setSubmitting(false);
  };

  const navigate = (next: Screen) => {
    setError(null);
    setScreen((current) => {
      if (current !== next) historyRef.current.push(current);
      return next;
    });
  };

  const closeSheet = () => {
    // O POST de criação pode já ter sido aceito pelo servidor. Fechar no meio
    // criaria câmera sem atualizar a lista e induziria cadastro duplicado.
    if (submittingRef.current) return;
    const finish = () => {
      reset();
      if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
      void clearSensitiveClipboard(); onClose();
    };
    if (screen !== 'success' && (name.trim() || ip.trim() || password)) {
      Alert.alert('Sair do cadastro?', 'Os dados preenchidos serão descartados.', [
        { text: 'Continuar cadastro', style: 'cancel' }, { text: 'Sair', style: 'destructive', onPress: finish },
      ]);
    } else finish();
  };

  const clearSensitiveClipboard = async () => {
    const expected = clipboardValueRef.current;
    clipboardValueRef.current = null;
    if (!expected) return;
    try {
      if (await Clipboard.getStringAsync() === expected) await Clipboard.setStringAsync('');
    } catch {
      // O sistema pode negar leitura do clipboard em background; não quebra o fluxo.
    }
  };

  useEffect(() => () => {
    operationRef.current += 1; requestRef.current?.abort();
    if (qrTimerRef.current) clearTimeout(qrTimerRef.current);
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    void clearSensitiveClipboard();
  }, []);

  useEffect(() => {
    if (!visible) return;
    reset();
    setQuota(null); setQuotaError(false); setQuotaLoading(true);
    let cancelled = false;
    void request<Quota>(apiUrl, '/cameras/mine/quota', token ?? undefined)
      .then((value) => { if (!cancelled) setQuota(value); })
      .catch(() => { if (!cancelled) { setQuota(null); setQuotaError(true); } })
      .finally(() => { if (!cancelled) setQuotaLoading(false); });
    return () => { cancelled = true; };
  }, [visible, apiUrl, token]);

  useEffect(() => { scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [screen]);
  useEffect(() => { if (error) scrollRef.current?.scrollTo({ y: 0, animated: true }); }, [error]);

  const retryQuota = async () => {
    const generation = quotaGenerationRef.current;
    setQuotaLoading(true); setQuotaError(false);
    try {
      const value = await request<Quota>(apiUrl, '/cameras/mine/quota', token ?? undefined);
      if (generation === quotaGenerationRef.current) setQuota(value);
    } catch { if (generation === quotaGenerationRef.current) setQuotaError(true); }
    finally { if (generation === quotaGenerationRef.current) setQuotaLoading(false); }
  };

  const ensureLocalNetworkPermission = async () => {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 37) return true;
    try {
      const permission = 'android.permission.ACCESS_LOCAL_NETWORK' as Parameters<typeof PermissionsAndroid.request>[0];
      return await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const startDiscovery = async () => {
    const operation = ++operationRef.current;
    navigate('discover'); setDiscovering(true); setScanProgress(null); setDevices([]); setDiscoveryWarnings([]); setError(null);
    try {
      if (!await ensureLocalNetworkPermission()) {
        if (operation !== operationRef.current) return;
        setError('Permita o acesso à rede local para o app encontrar as câmeras próximas.');
        return;
      }
      const result = await discoverCameras();
      if (operation !== operationRef.current) return;
      setDevices(result.devices); setDiscoveryWarnings(result.warnings);
    } catch (err) {
      if (operation !== operationRef.current) return;
      setError(userFacingError(err, 'Não foi possível procurar câmeras agora. Tente novamente.'));
    } finally {
      if (operation === operationRef.current) setDiscovering(false);
    }
  };

  const startFullScan = async () => {
    const operation = ++operationRef.current;
    setDiscovering(true); setScanProgress({ checked: 0, total: 253, found: devices.length });
    setDiscoveryWarnings([]); setError(null);
    try {
      if (!await ensureLocalNetworkPermission()) {
        if (operation !== operationRef.current) return;
        setError('Permita o acesso à rede local para executar a busca completa.');
        return;
      }
      const result = await scanLocalNetwork((progress) => {
        if (operation === operationRef.current) setScanProgress(progress);
      });
      if (operation !== operationRef.current) return;
      setDevices((current) => mergeDiscoveredCameras([...current, ...result.devices]));
      setDiscoveryWarnings(result.warnings);
    } catch (err) {
      if (operation !== operationRef.current) return;
      setError(userFacingError(err, 'Não foi possível concluir a busca por câmeras. Tente novamente.'));
    } finally {
      if (operation === operationRef.current) { setDiscovering(false); setScanProgress(null); }
    }
  };

  const chooseDevice = (device: DiscoveredCamera) => {
    operationRef.current += 1;
    invalidateConnection();
    setSourceMode('rtsp_pull'); setIp(device.ip);
    setName(/^(Câmera|Possível câmera) /.test(device.name) ? '' : device.name);
    const ports = discoveredCameraPorts(device);
    setRtspPort(ports.rtspPort); setHttpPort(ports.httpPort); setOnvifPort(ports.onvifPort); setRtspPath('');
    setAutomaticPort(ports.automatic);
    setUsername('admin'); setPassword('');
    setManualConnectionNeeded(false); setShowConnectionOptions(false); setError(null); navigate('details');
  };

  const openQr = async () => {
    const operation = ++operationRef.current;
    setError(null); qrLockRef.current = false; setQrLocked(false); setTorch(false);
    if (!cameraPermission?.granted) {
      const permission = await askCameraPermission();
      if (operation !== operationRef.current) return;
      if (!permission.granted) {
        setError('Permita o uso da câmera para ler o QR Code. Você ainda pode buscar na rede ou adicionar manualmente.');
        return;
      }
    }
    navigate('qr');
  };

  const applyCameraAddress = (data: string) => {
    const parsed = parseCameraQr(data);
    if (parsed.kind !== 'camera' || !parsed.ip) {
      setError(parsed.kind === 'wifi' ? 'Este código é da rede Wi-Fi. Use o endereço da câmera ou procure na rede.' : 'Não encontramos um endereço de câmera nesse conteúdo. Use um IP ou endereço RTSP completo.');
      return false;
    }
    invalidateConnection();
    setSourceMode('rtsp_pull'); setIp(parsed.ip); setRtspPort(parsed.port ? String(parsed.port) : RTSP_PORT_DEFAULT);
    setAutomaticPort(false);
    setUsername(parsed.username ?? 'admin');
    setPassword(parsed.password ?? '');
    setRtspPath(parsed.rtspPath ?? '');
    if (parsed.name) setName(parsed.name);
    setManualConnectionNeeded(false); setConnection(null); setError(null); navigate('details');
    return true;
  };

  const onQrScanned = ({ data }: { data: string }) => {
    if (qrLockRef.current) return;
    qrLockRef.current = true; setQrLocked(true);
    if (!applyCameraAddress(data)) {
      qrTimerRef.current = setTimeout(() => { qrLockRef.current = false; setQrLocked(false); }, 1_200);
    }
  };

  const pasteCameraAddress = async () => {
    const operation = operationRef.current;
    try {
      const value = await Clipboard.getStringAsync();
      if (operation === operationRef.current) applyCameraAddress(value);
    } catch { if (operation === operationRef.current) setError('Não foi possível ler o conteúdo copiado. Digite o endereço abaixo.'); }
  };

  const testConnection = async () => {
    if (checking || !planReady) return;
    if (connectionError) { setError(connectionError); return; }
    const operation = ++operationRef.current;
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setChecking(true); setConnection(null); setError(null);
    try {
      const result = await request<ConnectionResult>(apiUrl, '/cameras/mine/test-connection', token ?? undefined, {
        method: 'POST',
        signal: controller.signal, timeoutMs: 90_000,
        body: JSON.stringify(cameraConnectionTestPayload(draft, automaticPort)),
      });
      if (operation !== operationRef.current) return;
      setConnection(result);
      if (result.detectedRtspPort) { setRtspPort(String(result.detectedRtspPort)); setAutomaticPort(false); }
      if (result.detectedRtspPath) setRtspPath(result.detectedRtspPath);
      if (result.detectedOnvifPort) setOnvifPort(String(result.detectedOnvifPort));
      setOnvifPath(result.detectedOnvifPath); setOnvifToken(result.detectedOnvifProfileToken);
      if (result.rtspAuthOk) {
        setManualConnectionNeeded(false);
        if (!result.detectedRtspPath && result.suggestedRtspPath) setRtspPath(result.suggestedRtspPath);
        if (!name.trim()) setName(`Câmera ${ip.trim().split('.').at(-1) ?? ''}`.trim());
        navigate('review');
        setPreviewLoading(true);
        void request<PreviewFrame>(apiUrl, '/cameras/mine/preview-frame', token ?? undefined, {
          method: 'POST',
          signal: controller.signal, timeoutMs: 30_000,
          body: JSON.stringify({
            ip: ip.trim(), rtspPort: result.detectedRtspPort ?? (Number(rtspPort) || 554),
            username: username.trim(), password,
            rtspPath: result.detectedRtspPath ?? result.suggestedRtspPath ?? (rtspPath.trim() || undefined),
          }),
        }).then((value) => { if (operation === operationRef.current) setPreview(value); })
          .catch(() => { if (operation === operationRef.current) setPreview({ ok: false, imageDataUrl: null, reason: 'A imagem de confirmação não ficou disponível.' }); })
          .finally(() => { if (operation === operationRef.current) setPreviewLoading(false); });
      }
      else if (cameraSetupFailureMessage(result.failureCode)) {
        setManualConnectionNeeded(true);
        setError(cameraSetupFailureMessage(result.failureCode));
      } else if (result.rtspReachableAny) {
        setManualConnectionNeeded(true);
        setError('O servidor encontrou a câmera, mas não abriu o vídeo. Confira usuário, senha e a porta do vídeo.');
      } else {
        setManualConnectionNeeded(true);
        setError('O servidor não conseguiu alcançar o vídeo. Se a câmera está em outra rede, peça ao instalador para liberar a conexão ou use a opção de envio RTMP.');
      }
    } catch (err) {
      if (operation !== operationRef.current) return;
      setError(userFacingError(err, 'Não foi possível testar esta câmera. Confira os dados e tente novamente.'));
    } finally {
      if (operation === operationRef.current) setChecking(false);
    }
  };

  const submit = async () => {
    if (!canSave || submittingRef.current) return;
    submittingRef.current = true;
    const operation = ++operationRef.current;
    setSubmitting(true); setError(null);
    try {
      const installerLocation = includeLocation ? await captureInstallerLocation() : null;
      if (operation !== operationRef.current) return;
      const payload = sourceMode === 'rtmp_push'
        ? { name: name.trim(), sourceMode, ...(installerLocation ?? {}) }
        : {
            name: name.trim(), sourceMode, ...cameraConnectionPayload(draft),
            ...(installerLocation ?? {}),
            ...(rtspPath.trim() ? { rtspPath: rtspPath.trim() } : {}),
            ...(Number(onvifPort) ? { onvifPort: Number(onvifPort) } : {}), ...(onvifPath ? { onvifPath } : {}),
            ...(onvifToken ? { onvifProfileToken: onvifToken } : {}),
          };
      const created = await request<CreatedCamera>(apiUrl, '/cameras/mine', token ?? undefined, {
        method: 'POST', body: JSON.stringify(payload),
      });
      if (operation !== operationRef.current) return;
      onCreated?.();
      setPassword(''); setShowPass(false); setPreview(null);
      if (sourceMode === 'rtmp_push') {
        setRtmpTarget(created.rtmpIngest ?? null);
        if (!created.rtmpIngest?.fullUrl) {
          const target = await request<RtmpTarget>(apiUrl, `/cameras/mine/${created.id}/rtmp-ingest`, token ?? undefined).catch(() => null);
          if (operation !== operationRef.current) return;
          setRtmpTarget(target);
          if (!target?.fullUrl) setError('A câmera foi criada. Você pode recuperar o endereço em Gerenciar câmera, na sua lista.');
        }
      }
      setScreen('success');
    } catch (err) {
      if (operation !== operationRef.current) return;
      setError(userFacingError(err, 'Não foi possível adicionar a câmera. Tente novamente.'));
    } finally {
      submittingRef.current = false;
      if (operation === operationRef.current) setSubmitting(false);
    }
  };

  const title = useMemo(() => ({
    home: 'Adicionar câmera', discover: 'Câmeras por perto', qr: 'Ler QR Code',
    provision: 'Conectar ao Wi-Fi', details: 'Dados da câmera',
    review: 'Conferir câmera', success: 'Câmera adicionada',
  })[screen], [screen]);

  const goBack = () => {
    if (submittingRef.current) return;
    operationRef.current += 1;
    requestRef.current?.abort();
    setDiscovering(false); setScanProgress(null); setChecking(false); setSubmitting(false); setPreviewLoading(false);
    setError(null);
    const previous = historyRef.current.pop() ?? 'home';
    if (previous === 'qr') { qrLockRef.current = false; setQrLocked(false); }
    setScreen(previous);
  };

  const handleSystemBack = () => {
    if (submitting) return;
    if (screen === 'home' || screen === 'success') closeSheet();
    else goBack();
  };

  const copyRtmpAddress = async (field: 'fullUrl' | 'serverUrl' | 'streamKey' = 'fullUrl') => {
    const value = rtmpTarget?.[field] ?? '';
    if (!value) return;
    const operation = operationRef.current;
    try { await Clipboard.setStringAsync(value); }
    catch { if (operation === operationRef.current) setError('Não foi possível copiar. Tente novamente.'); return; }
    if (operation !== operationRef.current) {
      if (await Clipboard.getStringAsync().catch(() => '') === value) await Clipboard.setStringAsync('').catch(() => undefined);
      return;
    }
    clipboardValueRef.current = value;
    setCopied(field);
    if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
    clipboardTimerRef.current = setTimeout(() => {
      clipboardTimerRef.current = null;
      setCopied(null);
      void clearSensitiveClipboard();
    }, 120_000);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={handleSystemBack}>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={[styles.safe, { backgroundColor: theme.bg }]}>
        <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            {screen !== 'home' && screen !== 'success' ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Voltar de ${title}`} accessibilityState={{ disabled: submitting }} disabled={submitting} style={[styles.headerBtn, { backgroundColor: theme.surface, opacity: submitting ? 0.45 : 1 }]} onPress={goBack}>
                <Icon name="chevronLeft" size={20} color={theme.text} />
              </Pressable>
            ) : <View style={styles.headerBtn} />}
            <Text style={[styles.headerTitle, { color: theme.text }]} accessibilityRole="header">{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Fechar cadastro de câmera" accessibilityState={{ disabled: submitting }} disabled={submitting} style={[styles.headerBtn, { backgroundColor: theme.surface, opacity: submitting ? 0.45 : 1 }]} onPress={closeSheet}>
              <Icon name="close" size={18} color={theme.textSub} />
            </Pressable>
          </View>
          {screen !== 'home' && screen !== 'success' && screen !== 'provision' ? <SetupProgress theme={theme} screen={screen} /> : null}

          {screen === 'qr' && cameraPermission?.granted ? (
            <View style={styles.qrRoot}>
              <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={qrLocked ? undefined : onQrScanned} />
              <View style={styles.qrShadeTop}><Text style={styles.qrHint}>Leia um QR de integração com endereço IP ou RTSP</Text></View>
              <View style={styles.qrFrame}><View style={styles.qrInner} /></View>
              <View style={styles.qrActions}>
                <Pressable accessibilityRole="button" accessibilityLabel={torch ? 'Desligar lanterna' : 'Ligar lanterna'} style={styles.qrAction} onPress={() => setTorch((value) => !value)}><Icon name="sun" size={22} color="#fff" /><Text style={styles.qrActionText}>{torch ? 'Desligar luz' : 'Ligar luz'}</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Digitar dados da câmera" style={styles.qrAction} onPress={() => navigate('details')}><Icon name="edit" size={22} color="#fff" /><Text style={styles.qrActionText}>Digitar dados</Text></Pressable>
              </View>
              {error ? <View style={styles.qrError}><Text style={styles.qrErrorText}>{error}</Text></View> : null}
            </View>
          ) : (
            <ScrollView ref={scrollRef} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
              {error ? <ErrorBanner theme={theme} text={error} /> : null}
              {quotaError && screen !== 'success' ? <View style={{ gap: 8 }}><ErrorBanner theme={theme} text="Não conseguimos verificar seu limite de câmeras. Tente novamente para continuar." /><SecondaryButton theme={theme} icon="clock" label={quotaLoading ? 'Verificando…' : 'Verificar meu plano'} disabled={quotaLoading} onPress={() => void retryQuota()} /></View> : null}
              {quotaFull && screen !== 'home' && screen !== 'success' ? <QuotaBanner theme={theme} loading={false} quota={quota} /> : null}
              {screen === 'home' ? <HomeStep theme={theme} quota={quota} quotaLoading={quotaLoading}
                onDiscover={() => void startDiscovery()} onQr={() => void openQr()} onProvision={() => navigate('provision')}
                onRemote={() => { setSourceMode('rtmp_push'); setName(''); navigate('details'); }}
                onManual={() => { setSourceMode('rtsp_pull'); setManualConnectionNeeded(false); navigate('details'); }} /> : null}

              {screen === 'discover' ? (
                <>
                  <View style={[styles.discoveryHero, { backgroundColor: theme.accentBg, borderColor: theme.accent }]}>
                    {discovering ? <ActivityIndicator size="large" color={theme.accent} /> : <Icon name={devices.length ? 'check' : 'wifi'} size={30} color={devices.length ? theme.success : theme.accent} />}
                    <Text style={[styles.discoveryTitle, { color: theme.text }]}>{discovering ? (scanProgress ? 'Fazendo busca completa…' : 'Procurando na rede…') : devices.length ? `${devices.length} dispositivo(s) encontrado(s)` : 'Nenhuma câmera apareceu'}</Text>
                    <Text style={[styles.discoverySub, { color: theme.textSub }]}>{discovering ? (scanProgress ? `${scanProgress.checked} de ${scanProgress.total} endereços verificados · ${scanProgress.found} candidato(s)` : 'Mantenha o celular no mesmo Wi-Fi da câmera.') : devices.length ? 'Toque na câmera correta para validar o vídeo.' : 'Confira se ela está ligada e conectada ao mesmo roteador.'}</Text>
                  </View>
                  {devices.map((device) => <DeviceCard key={device.id} theme={theme} device={device} onPress={() => chooseDevice(device)} />)}
                  {discoveryWarnings.length ? <InfoBanner theme={theme} text="Alguns métodos de busca não responderam. Você ainda pode tentar novamente ou cadastrar pelo endereço." /> : null}
                  {!discovering ? <View style={{ gap: 10 }}><SecondaryButton theme={theme} icon="search" label="Buscar novamente" onPress={() => void startDiscovery()} /><SecondaryButton theme={theme} icon="wifi" label="Busca completa nesta rede" onPress={() => void startFullScan()} /><Text style={[styles.scanPrivacy, { color: theme.textMuted }]}>Verifica somente endereços privados do Wi-Fi atual. Nenhuma senha é enviada.</Text><SecondaryButton theme={theme} icon="edit" label="Informar endereço" onPress={() => navigate('details')} /></View> : null}
                </>
              ) : null}

              {screen === 'provision' ? (
                <>
                  <Text style={[styles.heroTitle, { color: theme.text }]}>Primeiro, conecte ao Wi-Fi</Text>
                  <Text style={[styles.heroSub, { color: theme.textSub }]}>Use o aplicativo do fabricante para conectar a câmera à sua rede. Depois, volte aqui para adicioná-la.</Text>
                  <Step theme={theme} number="1" title="Ligue a câmera" text="Confira se ela recebe energia. Se já estiver funcionando, mantenha a configuração atual." />
                  <Step theme={theme} number="2" title="Conecte à sua rede" text="Siga o guia do fabricante. Alguns modelos precisam liberar a opção RTSP ou ONVIF para compartilhar o vídeo." />
                  <Step theme={theme} number="3" title="Volte para o S2Cam" text="Conecte o celular ao mesmo Wi-Fi e procure a câmera abaixo." />
                  <InfoBanner theme={theme} text="Este guia ajuda na preparação. A conexão inicial ao Wi-Fi é feita pelo aplicativo do fabricante." />
                  <PrimaryButton theme={theme} icon="search" label="A câmera já está conectada" onPress={() => void startDiscovery()} />
                  <SecondaryButton theme={theme} icon="qrCode" label="Ler QR da câmera" onPress={() => void openQr()} />
                </>
              ) : null}

              {screen === 'details' ? (
                <DetailsStep theme={theme} sourceMode={sourceMode} ip={ip} name={name} username={username} password={password}
                  rtspPort={rtspPort} httpPort={httpPort} onvifPort={onvifPort} rtspPath={rtspPath} showPass={showPass} manualConnectionNeeded={manualConnectionNeeded}
                  checking={checking} submitting={submitting} canSave={canSave}
                  planReady={planReady} showConnectionOptions={showConnectionOptions}
                  automaticPort={automaticPort} onPortMode={automatic => { invalidateConnection(); setAutomaticPort(automatic); if (!automatic && !rtspPort.trim()) setRtspPort(RTSP_PORT_DEFAULT); }}
                  onToggleOptions={() => setShowConnectionOptions(value => !value)} onPaste={() => void pasteCameraAddress()}
                  onName={setName} onUsername={value => { invalidateConnection(); setUsername(value); }} onPassword={value => { invalidateConnection(); setPassword(value); }}
                  onIp={(value) => { invalidateConnection(); setIp(value); }}
                  onPort={value => { invalidateConnection(); setRtspPort(value); }} onHttpPort={value => { invalidateConnection(); setHttpPort(value); }} onOnvifPort={value => { invalidateConnection(); setOnvifPort(value); }} onPath={value => { invalidateConnection(); setRtspPath(value); }}
                  onTogglePass={() => setShowPass((value) => !value)}
                  onTest={() => void testConnection()} onSubmit={() => navigate('review')}
                  />
              ) : null}

              {screen === 'review' && (connection || sourceMode === 'rtmp_push') ? (
                <>
                  <View style={[styles.successHero, { backgroundColor: theme.accentBg, borderColor: theme.border }]}><View style={[styles.successIcon, { backgroundColor: theme.success }]}><Icon name="check" size={25} color="#fff" /></View><Text style={[styles.discoveryTitle, { color: theme.text }]}>{sourceMode === 'rtmp_push' ? 'Pronta para cadastrar' : 'Vídeo encontrado'}</Text><Text style={[styles.discoverySub, { color: theme.textSub }]}>{sourceMode === 'rtmp_push' ? 'Depois de adicionar, copie o endereço de envio para a câmera.' : 'Confira a imagem e escolha um nome fácil de reconhecer.'}</Text></View>
                  <Field label="Nome da câmera" theme={theme}><TextInput accessibilityLabel="Nome da câmera na confirmação" editable={!submitting} value={name} onChangeText={setName} maxLength={100} placeholder="Ex.: Entrada principal" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
                  <View style={[styles.summary, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                    <SummaryRow theme={theme} label="Conexão" value={sourceMode === 'rtmp_push' ? 'Envio pela câmera (RTMP)' : 'Acesso pelo endereço (RTSP)'} />
                    {connection ? <><SummaryRow theme={theme} label="Endereço" value={`${ip}${connection.detectedRtspPort ? ` · porta ${connection.detectedRtspPort}` : ''}`} /><SummaryRow theme={theme} label="Imagem" value={connection.detectedStream?.width && connection.detectedStream?.height ? `${connection.detectedStream.width} × ${connection.detectedStream.height}` : 'Vídeo confirmado'} /></> : null}
                    <SummaryRow theme={theme} label="Privacidade" value="Sua câmera privada" last />
                  </View>
                  {previewLoading ? <View style={[styles.preview, styles.previewLoading, { backgroundColor: theme.surface, borderColor: theme.border }]}><ActivityIndicator color={theme.accent} /><Text style={[styles.previewHint, { color: theme.textSub }]}>Carregando uma imagem para conferência…</Text></View> : preview?.ok && preview.imageDataUrl ? <View style={[styles.preview, { borderColor: theme.border, backgroundColor: theme.videoBg }]}><Image source={{ uri: preview.imageDataUrl }} style={styles.previewImage} resizeMode="contain" /><View style={styles.previewCaption}><Icon name="eye" size={15} color="#fff" /><Text style={styles.previewCaptionText}>Confirme se esta é a câmera correta</Text></View></View> : preview ? <InfoBanner theme={theme} text="O vídeo foi validado, mas a imagem de conferência não ficou disponível." /> : null}
                  <InfoBanner theme={theme} text="Esta câmera ficará vinculada à sua conta. Grupos e administradores não recebem acesso automático às imagens." />
                  <Pressable accessibilityRole="checkbox" accessibilityLabel="Usar localização do celular no cadastro" accessibilityState={{ checked: includeLocation, disabled: submitting }} disabled={submitting} onPress={() => setIncludeLocation(value => !value)} style={[styles.choiceRow, { borderColor: theme.border, backgroundColor: theme.surface }]}><Icon name={includeLocation ? 'check' : 'plus'} size={20} color={theme.accent} /><View style={{ flex: 1 }}><Text style={[styles.methodTitle, { color: theme.text }]}>Usar localização do celular</Text><Text style={[styles.methodSub, { color: theme.textSub }]}>Opcional. Ative somente se você estiver no local da câmera.</Text></View></Pressable>
                </>
              ) : null}

              {screen === 'success' ? (
                <View style={styles.doneRoot}><View style={[styles.doneIcon, { backgroundColor: theme.success }]}><Icon name="check" size={36} color="#fff" strokeWidth={2.6} /></View><Text style={[styles.doneTitle, { color: theme.text }]}>Tudo pronto!</Text><Text style={[styles.doneSub, { color: theme.textSub }]}>{sourceMode === 'rtmp_push' ? 'Agora configure este endereço na opção RTMP da câmera.' : 'A câmera já foi adicionada à sua lista e está sendo preparada.'}</Text>
                  {sourceMode === 'rtmp_push' && rtmpTarget?.fullUrl ? <View style={[styles.urlCard, { backgroundColor: theme.surface, borderColor: theme.border }]}><Text style={[styles.methodTitle, { color: theme.text }]}>Configure o envio na câmera</Text><Text style={[styles.heroSub, { color: theme.textSub }]}>Se ela pedir um único endereço, copie o completo. Se pedir servidor e chave, copie cada campo abaixo.</Text>{(['fullUrl', 'serverUrl', 'streamKey'] as const).filter(field => rtmpTarget[field]).map(field => <View key={field} style={{ gap: 8 }}><Text style={[styles.urlLabel, { color: theme.textSub }]}>{field === 'fullUrl' ? 'Endereço completo' : field === 'serverUrl' ? 'Servidor' : 'Chave de transmissão'}</Text><Text selectable style={[styles.urlText, { color: theme.text }]}>{rtmpTarget[field]}</Text><SecondaryButton theme={theme} icon={copied === field ? 'check' : 'share'} label={copied === field ? 'Copiado' : `Copiar ${field === 'fullUrl' ? 'endereço completo' : field === 'serverUrl' ? 'servidor' : 'chave'}`} onPress={() => void copyRtmpAddress(field)} /></View>)}</View> : null}
                  <PrimaryButton theme={theme} icon="camera" label="Concluir" onPress={closeSheet} />
                </View>
              ) : null}

            </ScrollView>
          )}
          {screen === 'details' || screen === 'review' ? <View style={[styles.footer, { backgroundColor: theme.bg, borderTopColor: theme.border }]}>
            {screen === 'review' ? <PrimaryButton theme={theme} loading={submitting} disabled={!canSave} icon="check" label="Adicionar esta câmera" onPress={() => void submit()} />
              : sourceMode === 'rtmp_push' ? <PrimaryButton theme={theme} disabled={!canSave} icon="chevronRight" label="Conferir e continuar" onPress={() => navigate('review')} />
              : <PrimaryButton theme={theme} loading={checking} disabled={checking || !planReady || !ip.trim() || !username.trim() || !password} icon="play" label={manualConnectionNeeded ? 'Testar novamente' : 'Testar vídeo e continuar'} onPress={() => void testConnection()} />}
            {checking ? <SecondaryButton theme={theme} icon="close" label="Cancelar teste" onPress={() => { invalidateConnection(); }} /> : null}
            <Text style={[styles.footerHint, { color: theme.textSub }]}>{checking ? 'Aguarde enquanto o servidor verifica a conexão.' : screen === 'review' ? 'A câmera será privada e vinculada à sua conta.' : 'Você confere os dados antes de adicionar.'}</Text>
          </View> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function SetupProgress({ theme, screen }: { theme: Theme; screen: Screen }) {
  const active = screen === 'review' ? 2 : screen === 'details' ? 1 : 0;
  return <View style={styles.progress} accessibilityLabel={`Etapa ${active + 1} de 3: ${['Conectar', 'Dados', 'Conferir'][active]}`}>
    {['Conectar', 'Dados', 'Conferir'].map((label, index) => <View key={label} style={styles.progressItem}><View style={[styles.progressLine, { backgroundColor: index <= active ? theme.accent : theme.border }]} /><Text style={[styles.progressLabel, { color: index === active ? theme.text : theme.textSub }]}>{index < active ? '✓ ' : `${index + 1}. `}{label}</Text></View>)}
  </View>;
}

function HomeStep({ theme, quota, quotaLoading, onDiscover, onQr, onProvision, onRemote, onManual }: { theme: Theme; quota: Quota | null; quotaLoading: boolean; onDiscover: () => void; onQr: () => void; onProvision: () => void; onRemote: () => void; onManual: () => void }) {
  return <>
    <View style={styles.homeHero}><View style={[styles.homeIcon, { backgroundColor: theme.accentBg }]}><Icon name="camera" size={30} color={theme.accent} /></View><Text style={[styles.heroTitle, { color: theme.text }]}>Vamos conectar sua câmera</Text><Text style={[styles.heroSub, { color: theme.textSub }]}>Escolha como deseja adicionar. Você poderá conferir tudo antes de concluir.</Text></View>
    <QuotaBanner theme={theme} loading={quotaLoading} quota={quota} />
    <Pressable accessibilityRole="button" accessibilityLabel="Adicionar câmera por RTSP" style={styles.autoMethodWrap} onPress={onManual}>
      <LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.autoMethod}>
        <View style={styles.autoMethodIcon}><Icon name="camera" size={27} color={theme.textOnAccent} /></View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.autoMethodTitle, { color: theme.textOnAccent }]}>Tenho o endereço da câmera</Text>
          <Text style={[styles.autoMethodSub, { color: theme.textOnAccent }]}>Informe o IP e os dados de acesso</Text>
        </View>
        <Icon name="chevronRight" size={20} color={theme.textOnAccent} />
      </LinearGradient>
    </Pressable>
    <Text style={[styles.sectionLabel, { color: theme.textSub }]}>Ou escolha outra forma</Text>
    <View style={[styles.methodList, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <MethodRow theme={theme} icon="search" title="Procurar no meu Wi-Fi" subtitle="Encontre câmeras na mesma rede do celular" onPress={onDiscover} />
      <MethodRow theme={theme} icon="qrCode" title="Ler QR Code" subtitle="QR com endereço IP ou RTSP" onPress={onQr} />
      <MethodRow theme={theme} icon="radio" title="Receber o envio da câmera" subtitle="Crie um endereço para envio RTMP" onPress={onRemote} />
      <MethodRow theme={theme} icon="wifi" title="Preciso conectar ao Wi-Fi" subtitle="Veja como preparar a câmera" onPress={onProvision} last />
    </View>
    <InfoBanner theme={theme} text="As câmeras adicionadas por aqui são privadas e ficam vinculadas à sua conta." />
  </>;
}

function DetailsStep(props: { theme: Theme; sourceMode: SourceMode; ip: string; name: string; username: string; password: string; rtspPort: string; automaticPort: boolean; onPortMode: (automatic: boolean) => void; httpPort: string; onvifPort: string; rtspPath: string; showPass: boolean; manualConnectionNeeded: boolean; checking: boolean; submitting: boolean; canSave: boolean; planReady: boolean; showConnectionOptions: boolean; onToggleOptions: () => void; onPaste: () => void; onName: (v: string) => void; onUsername: (v: string) => void; onPassword: (v: string) => void; onIp: (v: string) => void; onPort: (v: string) => void; onHttpPort: (v: string) => void; onOnvifPort: (v: string) => void; onPath: (v: string) => void; onTogglePass: () => void; onTest: () => void; onSubmit: () => void }) {
  const { theme, sourceMode, ip, name, username, password, rtspPort, httpPort, onvifPort, rtspPath, showPass, manualConnectionNeeded, checking, submitting, canSave } = props;
  if (sourceMode === 'rtmp_push') {
    return <>
      <Text style={[styles.heroTitle, { color: theme.text }]}>Receba o vídeo da câmera</Text>
      <Text style={[styles.heroSub, { color: theme.textSub }]}>A câmera envia o vídeo ao S2Cam. Depois de cadastrar, você copia o endereço para a configuração RTMP dela.</Text>
      <Field label="Nome da câmera" theme={theme}><TextInput accessibilityLabel="Nome da câmera" value={name} onChangeText={props.onName} maxLength={100} returnKeyType="done" placeholder="Ex.: Entrada principal" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
      <InfoBanner theme={theme} text="Confira se sua câmera oferece envio RTMP. Se ela não tiver essa opção, use o cadastro pelo endereço IP." />
    </>;
  }
  return <>
    <Text style={[styles.heroTitle, { color: theme.text }]}>{ip ? 'Conectar à câmera' : 'Adicionar pelo endereço'}</Text>
    <Text style={[styles.heroSub, { color: theme.textSub }]}>Informe os dados da câmera. Se recebeu portas diferentes do instalador, use os valores que ele passou.</Text>
    <SecondaryButton theme={theme} icon="share" label="Colar endereço do vídeo" onPress={props.onPaste} />
    <View style={[styles.formCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Field label="Nome da câmera" theme={theme}><TextInput accessibilityLabel="Nome da câmera" value={name} onChangeText={props.onName} maxLength={100} placeholder="Ex.: Portão de casa" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
      <Field label="Endereço da câmera (IP)" theme={theme}><TextInput accessibilityLabel="Endereço IP da câmera" value={ip} onChangeText={props.onIp} maxLength={45} keyboardType="url" autoCapitalize="none" autoCorrect={false} placeholder="Ex.: 192.168.0.100" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
      <Field label="Usuário" theme={theme}><TextInput accessibilityLabel="Usuário da câmera" value={username} onChangeText={props.onUsername} maxLength={128} autoCapitalize="none" autoCorrect={false} placeholder="Geralmente admin" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
      <Field label="Senha da câmera" theme={theme}><View style={styles.inputRow}><TextInput accessibilityLabel="Senha da câmera" value={password} onChangeText={props.onPassword} maxLength={512} autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" secureTextEntry={!showPass} placeholder="Senha ou chave de acesso" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text, flex: 1 }]} /><Pressable accessibilityRole="button" accessibilityLabel={showPass ? 'Ocultar senha' : 'Mostrar senha'} onPress={props.onTogglePass} hitSlop={10}><Icon name="eye" size={19} color={theme.textMuted} /></Pressable></View></Field>
      <View style={{ gap: 8 }}>
        <Text style={[styles.label, { color: theme.textSub }]}>Porta do vídeo</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {([{ label: 'Informar porta', automatic: false }, { label: 'Buscar automaticamente', automatic: true }] as const).map(option => {
            const selected = option.automatic === props.automaticPort;
            return <Pressable key={option.label} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: selected }} onPress={() => props.onPortMode(option.automatic)} style={[styles.portChoice, { borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.accentBg : theme.surface }]}><Text style={[styles.portChoiceText, { color: selected ? theme.accent : theme.textSub }]}>{option.label}</Text></Pressable>;
          })}
        </View>
      </View>
      {!props.automaticPort ? <Field label="Porta RTSP (vídeo)" theme={theme}><TextInput accessibilityLabel="Porta RTSP do vídeo" value={rtspPort} onChangeText={(value) => props.onPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" maxLength={5} placeholder="Geralmente 554" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field> : <Text style={[styles.heroSub, { color: theme.textSub }]}>Vamos procurar a porta. Se não encontrar, escolha Informar porta.</Text>}
      <Field label="Porta HTTP (acesso)" theme={theme}><TextInput accessibilityLabel="Porta HTTP de acesso" value={httpPort} onChangeText={(value) => props.onHttpPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" maxLength={5} placeholder="Geralmente 80" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
    </View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: props.showConnectionOptions }} onPress={props.onToggleOptions} style={[styles.choiceRow, { backgroundColor: theme.surface, borderColor: theme.border }]}><Icon name="settings" size={20} color={theme.accent} /><Text style={[styles.methodTitle, { color: theme.text, flex: 1 }]}>Outros dados (opcional)</Text><Icon name="chevronDown" size={18} color={theme.textSub} /></Pressable>
    {props.showConnectionOptions ? <View style={[styles.manualConnection, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Field label="Caminho do vídeo (se houver)" theme={theme}><TextInput accessibilityLabel="Caminho RTSP do vídeo" value={rtspPath} onChangeText={props.onPath} maxLength={512} autoCapitalize="none" autoCorrect={false} placeholder="Ex.: /cam/realmonitor" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
      <Field label="Porta ONVIF (opcional)" theme={theme}><TextInput accessibilityLabel="Porta ONVIF opcional" value={onvifPort} onChangeText={(value) => props.onOnvifPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" placeholder="Usar a porta de acesso" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} /></Field>
    </View> : null}
  </>;
}

function DeviceCard({ theme, device, onPress }: { theme: any; device: DiscoveredCamera; onPress: () => void }) {
  const scannedOnly = device.sources.length === 1 && device.sources[0] === 'scan';
  const sourceLabel = device.sources.includes('onvif') ? 'ONVIF detectado' : scannedOnly ? 'Endereço candidato · vídeo ainda será validado' : 'Serviço de rede detectado';
  return <Pressable accessibilityRole="button" accessibilityLabel={`Configurar ${device.name}, endereço ${device.ip}`} style={[styles.device, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={onPress}><View style={[styles.deviceIcon, { backgroundColor: theme.accentBg }]}><Icon name="camera" size={22} color={theme.accent} /></View><View style={{ flex: 1 }}><Text style={[styles.deviceName, { color: theme.text }]} numberOfLines={1}>{device.name}</Text><Text style={[styles.deviceMeta, { color: theme.textSub }]}>{device.ip}{device.manufacturerHint ? ` · ${device.manufacturerHint}` : ''}{device.openPorts?.length ? ` · ${device.openPorts.join('/')}` : ''}</Text><Text style={[styles.deviceSource, { color: scannedOnly ? theme.textSub : theme.success }]}>{sourceLabel}</Text></View><Icon name="chevronRight" size={18} color={theme.textMuted} /></Pressable>;
}

function MethodRow({ theme, icon, title, subtitle, last, onPress }: { theme: any; icon: IconName; title: string; subtitle: string; last?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" style={[styles.methodRow, !last && { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth }]} onPress={onPress}><View style={[styles.methodIcon, { backgroundColor: theme.accentBg }]}><Icon name={icon} size={21} color={theme.accent} /></View><View style={{ flex: 1 }}><Text style={[styles.methodTitle, { color: theme.text }]}>{title}</Text><Text style={[styles.methodSub, { color: theme.textSub }]}>{subtitle}</Text></View><Icon name="chevronRight" size={18} color={theme.textMuted} /></Pressable>;
}

function QuotaBanner({ theme, loading, quota }: { theme: any; loading: boolean; quota: Quota | null }) {
  if (loading) return <View style={[styles.quota, { backgroundColor: theme.surface, borderColor: theme.border }]}><ActivityIndicator size="small" color={theme.textSub} /><Text style={[styles.quotaText, { color: theme.textSub }]}>Verificando seu plano…</Text></View>;
  if (!quota) return null;
  const full = !quota.canAdd;
  const label = full
    ? (quota.limit > 0 ? `Limite de câmeras atingido: ${quota.used} de ${quota.limit}.` : 'Limite de câmeras atingido.')
    : `${quota.used} de ${quota.limit} câmeras cadastradas.`;
  return <View style={[styles.quota, { backgroundColor: full ? theme.dangerBg : theme.surface, borderColor: full ? theme.danger : theme.border }]}><Icon name={full ? 'alert' : 'camera'} size={16} color={full ? theme.danger : theme.accent} /><Text style={[styles.quotaText, { color: full ? theme.danger : theme.textSub }]}>{label}</Text></View>;
}

function Field({ label, theme, children }: { label: string; theme: any; children: React.ReactNode }) { return <View style={styles.field}><Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text><View style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border }]}>{children}</View></View>; }
function Step({ theme, number, title, text }: { theme: any; number: string; title: string; text: string }) { return <View style={styles.step}><View style={[styles.stepNumber, { backgroundColor: theme.accent }]}><Text style={styles.stepNumberText}>{number}</Text></View><View style={{ flex: 1 }}><Text style={[styles.stepTitle, { color: theme.text }]}>{title}</Text><Text style={[styles.stepText, { color: theme.textSub }]}>{text}</Text></View></View>; }
function SummaryRow({ theme, label, value, last }: { theme: any; label: string; value: string; last?: boolean }) { return <View style={[styles.summaryRow, !last && { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth }]}><Text style={[styles.summaryLabel, { color: theme.textSub }]}>{label}</Text><Text style={[styles.summaryValue, { color: theme.text }]} numberOfLines={2}>{value}</Text></View>; }
function PrimaryButton({ theme, icon, label, loading, disabled, onPress }: { theme: any; icon: IconName; label: string; loading?: boolean; disabled?: boolean; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled, busy: !!loading }} disabled={disabled || loading} onPress={onPress} style={{ opacity: disabled ? 0.45 : 1 }}><LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.primary}>{loading ? <ActivityIndicator color={theme.textOnAccent} /> : <><Icon name={icon} size={18} color={theme.textOnAccent} /><Text style={[styles.primaryText, { color: theme.textOnAccent }]}>{label}</Text></>}</LinearGradient></Pressable>; }
function SecondaryButton({ theme, icon, label, disabled, onPress }: { theme: Theme; icon: IconName; label: string; disabled?: boolean; onPress: () => void }) { return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={[styles.secondary, { backgroundColor: theme.surface, borderColor: theme.border, opacity: disabled ? 0.45 : 1 }]}><Icon name={icon} size={17} color={theme.textSub} /><Text style={[styles.secondaryText, { color: theme.text }]}>{label}</Text></Pressable>; }
function InfoBanner({ theme, text }: { theme: any; text: string }) { return <View style={[styles.banner, { backgroundColor: theme.accentBg }]}><Icon name="info" size={17} color={theme.accent} /><Text style={[styles.bannerText, { color: theme.textSub }]}>{text}</Text></View>; }
function ErrorBanner({ theme, text }: { theme: Theme; text: string }) { return <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.banner, { backgroundColor: theme.dangerBg }]}><Icon name="alert" size={17} color={theme.danger} /><Text style={[styles.bannerText, { color: theme.danger }]}>{text}</Text></View>; }

const styles = StyleSheet.create({
  portChoice: { flex: 1, minWidth: 120, minHeight: 44, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 10 }, portChoiceText: { fontFamily: 'InstrumentSans', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  homeHero: { gap: 8, marginBottom: 4 }, homeIcon: { width: 60, height: 60, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  progress: { flexDirection: 'row', gap: 12, width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4 }, progressItem: { flex: 1, gap: 6 }, progressLine: { height: 3, borderRadius: 3 }, progressLabel: { fontFamily: 'InstrumentSans', fontSize: 12, fontWeight: '600' },
  footer: { width: '100%', maxWidth: 680, alignSelf: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8, gap: 8 }, footerHint: { textAlign: 'center', fontFamily: 'InstrumentSans', fontSize: 12, lineHeight: 17 }, choiceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 16, padding: 14, minHeight: 56 },
  safe: { flex: 1 }, header: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8, gap: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, headerBtn: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, headerTitle: { fontFamily: 'Sora', fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 44, gap: 14 }, heroTitle: { fontFamily: 'Sora', fontSize: 25, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 }, heroSub: { fontFamily: 'InstrumentSans', fontSize: 14, lineHeight: 20, marginBottom: 4 },
  quota: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, marginVertical: 2 }, quotaText: { fontFamily: 'InstrumentSans', fontSize: 12.5, fontWeight: '600', flex: 1 },
  autoMethodWrap: { borderRadius: 20, overflow: 'hidden' }, autoMethod: { minHeight: 96, borderRadius: 20, padding: 17, flexDirection: 'row', alignItems: 'center', gap: 14 }, autoMethodIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }, autoMethodTitle: { fontFamily: 'Sora', fontSize: 17, fontWeight: '700' }, autoMethodSub: { fontFamily: 'InstrumentSans', fontSize: 12.5, lineHeight: 17, marginTop: 4, opacity: 0.88 },
  sectionLabel: { fontFamily: 'InstrumentSans', fontSize: 13, fontWeight: '600', marginTop: 6, marginLeft: 3 }, methodList: { borderWidth: 1, borderRadius: 19, overflow: 'hidden' }, methodRow: { minHeight: 84, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }, methodIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, methodTitle: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700' }, methodSub: { fontFamily: 'InstrumentSans', fontSize: 13, lineHeight: 18, marginTop: 3 }, manualLink: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingHorizontal: 13 }, manualText: { fontFamily: 'InstrumentSans', fontSize: 13.5, fontWeight: '700' }, manualSub: { fontFamily: 'InstrumentSans', fontSize: 11.5, marginTop: 2 },
  discoveryHero: { borderWidth: 1, borderRadius: 22, padding: 22, alignItems: 'center', gap: 8, marginBottom: 4 }, successHero: { borderWidth: 1, borderRadius: 22, padding: 22, alignItems: 'center', gap: 8 }, discoveryTitle: { fontFamily: 'Sora', fontSize: 18, fontWeight: '700', textAlign: 'center' }, discoverySub: { fontFamily: 'InstrumentSans', fontSize: 13.5, lineHeight: 19, textAlign: 'center' },
  device: { borderWidth: 1, borderRadius: 17, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12 }, deviceIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, deviceName: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700' }, deviceMeta: { fontFamily: 'JetBrainsMono', fontSize: 11.5, marginTop: 2 }, deviceSource: { fontFamily: 'InstrumentSans', fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  scanPrivacy: { fontFamily: 'InstrumentSans', fontSize: 11.5, lineHeight: 16, textAlign: 'center', paddingHorizontal: 16 },
  formCard: { borderWidth: 1, borderRadius: 19, padding: 14, gap: 14 }, field: { gap: 7 }, label: { fontFamily: 'InstrumentSans', fontSize: 12.5, fontWeight: '600' }, input: { minHeight: 52, borderRadius: 13, borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' }, inputRow: { flexDirection: 'row', alignItems: 'center' }, inputText: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '600', padding: 0 }, autoConfig: { minHeight: 72, borderRadius: 16, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12 }, autoConfigIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, autoConfigTitle: { fontFamily: 'InstrumentSans', fontSize: 13.5, fontWeight: '700' }, autoConfigSub: { fontFamily: 'InstrumentSans', fontSize: 12, lineHeight: 16, marginTop: 2 }, manualConnection: { borderWidth: 1, borderRadius: 18, padding: 14, gap: 14 }, manualConnectionHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, manualConnectionTitle: { fontFamily: 'InstrumentSans', fontSize: 14, fontWeight: '700' }, manualConnectionSub: { fontFamily: 'InstrumentSans', fontSize: 12, lineHeight: 17, marginTop: 3 },
  step: { flexDirection: 'row', gap: 13, paddingVertical: 7 }, stepNumber: { width: 31, height: 31, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, stepNumberText: { color: '#fff', fontFamily: 'Sora', fontSize: 13, fontWeight: '800' }, stepTitle: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700' }, stepText: { fontFamily: 'InstrumentSans', fontSize: 13, lineHeight: 18, marginTop: 3 },
  primary: { minHeight: 54, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 3 }, primaryText: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700' }, secondary: { minHeight: 52, borderRadius: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 }, secondaryText: { fontFamily: 'InstrumentSans', fontSize: 14, fontWeight: '700' }, banner: { borderRadius: 14, padding: 13, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, bannerText: { flex: 1, fontFamily: 'InstrumentSans', fontSize: 12.5, lineHeight: 18, fontWeight: '600' },
  successIcon: { width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, summary: { borderRadius: 17, borderWidth: 1, overflow: 'hidden' }, summaryRow: { minHeight: 51, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }, summaryLabel: { fontFamily: 'InstrumentSans', fontSize: 12.5, flex: 0.42 }, summaryValue: { fontFamily: 'InstrumentSans', fontSize: 13.5, fontWeight: '700', flex: 0.58, textAlign: 'right' },
  preview: { width: '100%', minHeight: 190, borderRadius: 18, borderWidth: 1, overflow: 'hidden', position: 'relative' }, previewLoading: { alignItems: 'center', justifyContent: 'center', gap: 10 }, previewHint: { fontFamily: 'InstrumentSans', fontSize: 12.5, fontWeight: '600' }, previewImage: { width: '100%', height: 210 }, previewCaption: { position: 'absolute', left: 10, right: 10, bottom: 10, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.68)', paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, previewCaptionText: { color: '#fff', fontFamily: 'InstrumentSans', fontSize: 12, fontWeight: '700' },
  doneRoot: { flex: 1, alignItems: 'center', paddingTop: 44, gap: 12 }, doneIcon: { width: 78, height: 78, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }, doneTitle: { fontFamily: 'Sora', fontSize: 27, fontWeight: '800' }, doneSub: { fontFamily: 'InstrumentSans', fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 320, marginBottom: 8 }, urlCard: { width: '100%', borderWidth: 1, borderRadius: 17, padding: 14, gap: 9, marginBottom: 4 }, urlLabel: { fontFamily: 'JetBrainsMono', fontSize: 10, fontWeight: '600', letterSpacing: 0.6 }, urlText: { fontFamily: 'JetBrainsMono', fontSize: 12, lineHeight: 18 }, copyBtn: { minHeight: 43, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, copyText: { fontFamily: 'InstrumentSans', fontSize: 13, fontWeight: '700' },
  qrRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }, qrShadeTop: { position: 'absolute', left: 0, right: 0, top: 0, height: 118, paddingTop: 30, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)' }, qrHint: { color: '#fff', fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700', textAlign: 'center', paddingHorizontal: 28 }, qrFrame: { width: 260, height: 260, borderWidth: 3, borderColor: '#fff', borderRadius: 28, padding: 16, backgroundColor: 'rgba(255,255,255,0.04)' }, qrInner: { flex: 1, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)', borderRadius: 16 }, qrActions: { position: 'absolute', bottom: 36, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 42 }, qrAction: { alignItems: 'center', gap: 7 }, qrActionText: { color: '#fff', fontFamily: 'InstrumentSans', fontSize: 12.5, fontWeight: '600' }, qrError: { position: 'absolute', left: 18, right: 18, bottom: 108, backgroundColor: 'rgba(127,29,29,0.92)', borderRadius: 13, padding: 12 }, qrErrorText: { color: '#fff', fontFamily: 'InstrumentSans', fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
});
