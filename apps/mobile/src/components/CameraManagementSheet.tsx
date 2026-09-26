import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { request } from '../services/api';
import { userFacingError } from '../services/user-facing-error';
import { useTheme } from '../theme/ThemeProvider';
import type { Camera } from '../types';
import { Icon } from './Icon';

type RtmpTarget = { fullUrl?: string | null; serverUrl?: string | null; streamKey?: string | null };

interface Props {
  visible: boolean;
  camera: Camera | null;
  apiUrl: string;
  token: string | null;
  onClose: () => void;
  onChanged: (cameraId: string, action: 'updated' | 'deleted') => void;
}

export function CameraManagementSheet({ visible, camera, apiUrl, token, onClose, onChanged }: Props) {
  const { theme } = useTheme();
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');
  const [httpPort, setHttpPort] = useState('80');
  const [onvifPort, setOnvifPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [path, setPath] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rtmpTarget, setRtmpTarget] = useState<RtmpTarget | null>(null);
  const [rtmpLoading, setRtmpLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedValue = useRef<string | null>(null);

  const busy = saving || deleting;
  const isPush = camera?.sourceMode === 'rtmp_push';

  const clearCopiedAddress = async () => {
    const expected = copiedValue.current;
    copiedValue.current = null;
    if (!expected) return;
    try {
      if (await Clipboard.getStringAsync() === expected) await Clipboard.setStringAsync('');
    } catch {
      // Limpeza best-effort: alguns sistemas bloqueiam leitura em background.
    }
  };

  useEffect(() => {
    if (!visible || !camera) return;
    const current = ++generation.current;
    setName(camera.name ?? '');
    setIp(camera.ip === '0.0.0.0' ? '' : (camera.ip ?? ''));
    setPort(camera.rtspPort ? String(camera.rtspPort) : '');
    setHttpPort(camera.httpPort ? String(camera.httpPort) : '80');
    setOnvifPort(camera.onvifPort ? String(camera.onvifPort) : '');
    setUsername(camera.username ?? '');
    setPassword('');
    setPath(camera.rtspPath ?? '');
    setShowPassword(false);
    setSaving(false); setDeleting(false); setError(null); setCopied(false); setRtmpTarget(null);
    if (camera.sourceMode === 'rtmp_push') {
      setRtmpLoading(true);
      void request<RtmpTarget>(apiUrl, `/cameras/mine/${encodeURIComponent(camera.id)}/rtmp-ingest`, token ?? undefined)
        .then((value) => { if (generation.current === current) setRtmpTarget(value); })
        .catch((err) => { if (generation.current === current) setError(userFacingError(err, 'Não foi possível preparar a transmissão da câmera.')); })
        .finally(() => { if (generation.current === current) setRtmpLoading(false); });
    } else {
      setRtmpLoading(false);
    }
  }, [visible, camera?.id, apiUrl, token]);

  useEffect(() => () => {
    generation.current += 1;
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    void clearCopiedAddress();
  }, []);

  const close = () => {
    if (busy) return;
    generation.current += 1;
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = null;
    void clearCopiedAddress();
    onClose();
  };

  const save = async () => {
    if (!camera || busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setError('Informe o nome da câmera.'); return; }
    if (!isPush && (!ip.trim() || !username.trim())) {
      setError('Informe o endereço e o usuário da câmera.');
      return;
    }
    const parsedPort = Number(port);
    if (!isPush && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
      setError('Informe uma porta RTSP válida entre 1 e 65535.');
      return;
    }
    const parsedHttpPort = Number(httpPort);
    if (!isPush && (!Number.isInteger(parsedHttpPort) || parsedHttpPort < 1 || parsedHttpPort > 65535)) {
      setError('Informe uma porta HTTP válida entre 1 e 65535.');
      return;
    }
    const parsedOnvifPort = onvifPort ? Number(onvifPort) : null;
    if (!isPush && parsedOnvifPort !== null && (!Number.isInteger(parsedOnvifPort) || parsedOnvifPort < 1 || parsedOnvifPort > 65535)) {
      setError('Informe uma porta ONVIF válida ou deixe o campo vazio.');
      return;
    }
    const current = ++generation.current;
    setSaving(true); setError(null);
    try {
      const body = isPush
        ? { name: trimmedName }
        : {
            name: trimmedName,
            ip: ip.trim(),
            rtspPort: parsedPort,
            httpPort: parsedHttpPort,
            onvifPort: parsedOnvifPort,
            username: username.trim(),
            rtspPath: path.trim(),
            ...(password ? { password } : {}),
          };
      await request(apiUrl, `/cameras/mine/${encodeURIComponent(camera.id)}`, token ?? undefined, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      if (generation.current !== current) return;
      onChanged(camera.id, 'updated');
      onClose();
    } catch (err) {
      if (generation.current === current) setError(userFacingError(err, 'Não foi possível salvar a câmera. Tente novamente.'));
    } finally {
      if (generation.current === current) setSaving(false);
    }
  };

  const performDelete = async () => {
    if (!camera || busy) return;
    const current = ++generation.current;
    setDeleting(true); setError(null);
    try {
      await request(apiUrl, `/cameras/mine/${encodeURIComponent(camera.id)}`, token ?? undefined, { method: 'DELETE' });
      if (generation.current !== current) return;
      onChanged(camera.id, 'deleted');
      onClose();
    } catch (err) {
      if (generation.current === current) setError(userFacingError(err, 'Não foi possível remover a câmera. Tente novamente.'));
    } finally {
      if (generation.current === current) setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (!camera || busy) return;
    Alert.alert(
      'Excluir esta câmera?',
      `“${camera.name}” será removida do sistema. O histórico e os eventos associados deixarão de ficar disponíveis. Esta ação não pode ser desfeita.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir câmera', style: 'destructive', onPress: () => { void performDelete(); } },
      ],
    );
  };

  const copyRtmp = async () => {
    const value = rtmpTarget?.fullUrl;
    if (!value) return;
    await Clipboard.setStringAsync(value);
    copiedValue.current = value;
    setCopied(true);
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = setTimeout(() => {
      clipboardTimer.current = null;
      setCopied(false);
      void clearCopiedAddress();
    }, 120_000);
  };

  if (!camera) return null;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <Pressable accessibilityRole="button" accessibilityLabel="Voltar" disabled={busy} onPress={close} style={[styles.iconButton, { backgroundColor: theme.surface, opacity: busy ? 0.5 : 1 }]}>
              <Icon name="chevronLeft" size={20} color={theme.text} />
            </Pressable>
            <View style={{ flex: 1 }}><Text style={[styles.title, { color: theme.text }]}>Editar câmera</Text><Text style={[styles.subtitle, { color: theme.textSub }]}>{isPush ? 'Câmera RTMP' : 'Câmera na rede local'}</Text></View>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Field label="Nome da câmera" theme={theme}>
                <TextInput accessibilityLabel="Nome da câmera" value={name} onChangeText={setName} maxLength={100} placeholder="Ex.: Entrada principal" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} />
              </Field>
              {!isPush ? <>
                <Field label="Endereço IP" theme={theme}><TextInput accessibilityLabel="Endereço IP" value={ip} onChangeText={setIp} maxLength={45} keyboardType="numbers-and-punctuation" autoCapitalize="none" autoCorrect={false} placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
                <Field label="Porta RTSP" theme={theme}><TextInput accessibilityLabel="Porta RTSP" value={port} onChangeText={(value) => setPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" placeholder="554" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
                <Field label="Porta HTTP da câmera" theme={theme}><TextInput accessibilityLabel="Porta HTTP da câmera" value={httpPort} onChangeText={(value) => setHttpPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" placeholder="80" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
                <Field label="Porta ONVIF (opcional)" hint="Se ficar vazia, o sistema tenta usar a porta HTTP." theme={theme}><TextInput accessibilityLabel="Porta ONVIF opcional" value={onvifPort} onChangeText={(value) => setOnvifPort(value.replace(/[^0-9]/g, '').slice(0, 5))} keyboardType="number-pad" placeholder="Usar a porta HTTP" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
                <Field label="Usuário" theme={theme}><TextInput accessibilityLabel="Usuário da câmera" value={username} onChangeText={setUsername} maxLength={128} autoCapitalize="none" autoCorrect={false} placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
                <Field label="Nova senha (opcional)" hint="Deixe em branco para manter a senha atual." theme={theme}><View style={styles.inputRow}><TextInput accessibilityLabel="Nova senha da câmera" value={password} onChangeText={setPassword} maxLength={512} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" placeholder="Manter senha atual" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text, flex: 1 }]} /><Pressable accessibilityRole="button" accessibilityLabel={showPassword ? 'Ocultar senha' : 'Mostrar senha'} onPress={() => setShowPassword((value) => !value)}><Icon name="eye" size={19} color={theme.textMuted} /></Pressable></View></Field>
                <Field label="Caminho RTSP" hint="Use apenas quando o equipamento exigir um caminho específico." theme={theme}><TextInput accessibilityLabel="Caminho RTSP" value={path} onChangeText={setPath} maxLength={512} autoCapitalize="none" autoCorrect={false} placeholder="/cam/realmonitor" placeholderTextColor={theme.textMuted} style={[styles.input, { color: theme.text }]} /></Field>
              </> : null}
            </View>

            {isPush ? <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Endereço de publicação RTMP</Text>
              <Text style={[styles.sectionText, { color: theme.textSub }]}>Use este endereço na configuração de envio da câmera.</Text>
              {rtmpLoading ? <ActivityIndicator color={theme.accent} /> : rtmpTarget?.fullUrl ? <>
                <Text selectable style={[styles.url, { color: theme.text, backgroundColor: theme.surfaceAlt }]}>{rtmpTarget.fullUrl}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Copiar endereço RTMP" onPress={() => { void copyRtmp(); }} style={[styles.secondaryButton, { borderColor: theme.border }]}><Icon name={copied ? 'check' : 'share'} size={17} color={theme.accent} /><Text style={[styles.secondaryText, { color: theme.accent }]}>{copied ? 'Copiado por 2 minutos' : 'Copiar endereço'}</Text></Pressable>
              </> : <Text style={[styles.sectionText, { color: theme.warning }]}>O endereço não está disponível. Tente abrir esta tela novamente.</Text>}
            </View> : null}

            {error ? <View accessibilityRole="alert" style={[styles.error, { backgroundColor: theme.dangerBg }]}><Icon name="alert" size={18} color={theme.danger} /><Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text></View> : null}

            <Pressable accessibilityRole="button" accessibilityLabel="Salvar alterações" disabled={busy} onPress={() => { void save(); }} style={[styles.primaryButton, { backgroundColor: theme.accent, opacity: busy ? 0.6 : 1 }]}>
              {saving ? <ActivityIndicator color={theme.textOnAccent} /> : <Icon name="check" size={19} color={theme.textOnAccent} />}
              <Text style={[styles.primaryText, { color: theme.textOnAccent }]}>Salvar alterações</Text>
            </Pressable>

            <View style={[styles.dangerCard, { backgroundColor: theme.dangerBg, borderColor: theme.danger }]}>
              <View style={{ flex: 1 }}><Text style={[styles.sectionTitle, { color: theme.danger }]}>Excluir câmera</Text><Text style={[styles.sectionText, { color: theme.textSub }]}>Remove o cadastro e encerra a transmissão desta câmera.</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Excluir câmera ${camera.name}`} disabled={busy} onPress={confirmDelete} style={[styles.deleteButton, { borderColor: theme.danger, opacity: busy ? 0.5 : 1 }]}>
                {deleting ? <ActivityIndicator color={theme.danger} /> : <Icon name="trash" size={19} color={theme.danger} />}
                <Text style={[styles.deleteText, { color: theme.danger }]}>Excluir</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Field({ label, hint, theme, children }: { label: string; hint?: string; theme: any; children: ReactNode }) {
  return <View style={styles.field}><Text style={[styles.label, { color: theme.textSub }]}>{label}</Text><View style={[styles.inputShell, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>{children}</View>{hint ? <Text style={[styles.hint, { color: theme.textMuted }]}>{hint}</Text> : null}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { minHeight: 70, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 13 },
  iconButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: 'Sora', fontSize: 20, fontWeight: '800' },
  subtitle: { fontFamily: 'InstrumentSans', fontSize: 12.5, marginTop: 2 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 18, paddingBottom: 44, gap: 15 },
  card: { borderWidth: 1, borderRadius: 18, padding: 15, gap: 14 },
  field: { gap: 6 },
  label: { fontFamily: 'InstrumentSans', fontSize: 12.5, fontWeight: '700' },
  hint: { fontFamily: 'InstrumentSans', fontSize: 11.5, lineHeight: 16 },
  inputShell: { minHeight: 50, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, justifyContent: 'center' },
  input: { fontFamily: 'InstrumentSans', fontSize: 15, paddingVertical: 0 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sectionTitle: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '700' },
  sectionText: { fontFamily: 'InstrumentSans', fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  url: { fontFamily: 'JetBrainsMono', fontSize: 11.5, lineHeight: 17, padding: 12, borderRadius: 12 },
  secondaryButton: { minHeight: 44, borderWidth: 1, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  secondaryText: { fontFamily: 'InstrumentSans', fontSize: 13, fontWeight: '700' },
  error: { borderRadius: 14, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 9 },
  errorText: { flex: 1, fontFamily: 'InstrumentSans', fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
  primaryButton: { minHeight: 54, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  primaryText: { fontFamily: 'InstrumentSans', fontSize: 15, fontWeight: '800' },
  dangerCard: { borderWidth: 1, borderRadius: 18, padding: 15, gap: 13 },
  deleteButton: { minHeight: 48, borderWidth: 1, borderRadius: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  deleteText: { fontFamily: 'InstrumentSans', fontSize: 14, fontWeight: '800' },
});
