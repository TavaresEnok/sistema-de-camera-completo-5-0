/**
 * Ajustes (redesign) — réplica da tela "Ajustes" do mockup: card de perfil, card do
 * provedor/plano (selo Ativo), preferências (tema escuro, notificações de movimento),
 * armazenamento, lista de ações, sair. Ligado ao usuário/tema reais.
 */
import Constants from 'expo-constants';
import { useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon, type IconName } from '../../components/Icon';
import { AddCameraSheet } from '../../components/AddCameraSheet';
import { request } from '../../services/api';
import { showAppNotice } from '../../services/app-notice';
import { userFacingError } from '../../services/user-facing-error';

const TITLE = 'Sora';
const UI = 'InstrumentSans';
const MONO = 'JetBrainsMono';
const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'ADMINISTRADOR', ADMIN: 'ADMINISTRADOR', OPERATOR: 'OPERADOR', VIEWER: 'VISUALIZAÇÃO' };

interface Props {
  user: { name?: string | null; email?: string; role?: string } | null;
  apiUrl: string;
  token?: string | null;
  connected: boolean;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  biometricLabel: string;
  onBiometricChange: (enabled: boolean) => void;
  onLogout: () => void;
  onCamerasChanged?: () => void;
  facilityName?: string;
  /** Alertas de movimento neste aparelho (push). */
  pushEnabled?: boolean;
  /** Falso quando o aparelho não suporta push (emulador, permissão negada). */
  pushSupported?: boolean;
  onPushChange?: (enabled: boolean) => void;
}

function initials(name?: string | null): string {
  const p = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return (!p.length ? 'U' : (p[0][0] + (p[1]?.[0] ?? ''))).toUpperCase();
}

export function SettingsRedesign(props: Props) {
  const { user, apiUrl, token, biometricAvailable, biometricEnabled, biometricLabel, onBiometricChange, onLogout, onCamerasChanged } = props;
  const { pushEnabled = true, pushSupported = true, onPushChange } = props;
  const { theme, themeMode, setThemeMode } = useTheme();
  const [addCameraOpen, setAddCameraOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const s = makeStyles(theme);
  const version = Constants.expoConfig?.version ?? '1.0';

  const closePassword = () => {
    if (passwordBusy) return;
    setPasswordOpen(false);
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setPasswordError('');
  };
  const changePassword = async () => {
    if (!token) return;
    if (!currentPassword || !newPassword) { setPasswordError('Preencha a senha atual e a nova senha.'); return; }
    if (newPassword !== confirmPassword) { setPasswordError('A confirmação não corresponde à nova senha.'); return; }
    setPasswordBusy(true); setPasswordError('');
    try {
      await request(apiUrl, '/users/me/password', token, {
        method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPasswordOpen(false);
      showAppNotice('Senha alterada', 'Entre novamente usando sua nova senha.', 'success', 5000);
      setTimeout(onLogout, 900);
    } catch (error) {
      setPasswordError(userFacingError(error, 'Não foi possível alterar a senha. Tente novamente.'));
    } finally { setPasswordBusy(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={s.root} showsVerticalScrollIndicator={false}>
        <Text style={s.title}>Ajustes</Text>

        {/* Perfil */}
        <View style={s.card}>
          <View style={s.avatar}><Text style={s.avatarText}>{initials(user?.name)}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.profileName} numberOfLines={1}>{user?.name || 'Usuário'}</Text>
            <Text style={s.profileEmail} numberOfLines={1}>{user?.email || '—'}</Text>
          </View>
          {user?.role ? <Text style={s.roleBadge}>{ROLE_LABEL[user.role] ?? user.role}</Text> : null}
        </View>

        {/* Configuração */}
        <Text style={s.section}>Configuração</Text>
        <View style={s.group}>
          <Item theme={theme} s={s} icon="lock" label="Alterar minha senha" subtitle="Atualize sua senha de acesso" onPress={() => setPasswordOpen(true)} />
          <View style={s.divider} />
          <View style={s.themeOptions} accessibilityRole="radiogroup">
            {([
              { id: 'system' as const, label: 'Sistema', icon: 'settings' as const },
              { id: 'dark' as const, label: 'Escuro', icon: 'moon' as const },
              { id: 'light' as const, label: 'Claro', icon: 'sun' as const },
            ]).map((option) => {
              const selected = themeMode === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityLabel={`Tema ${option.label.toLowerCase()}`}
                  accessibilityState={{ checked: selected }}
                  style={[s.themeOption, selected && { backgroundColor: theme.accentBg, borderColor: theme.accent }]}
                  onPress={() => setThemeMode(option.id)}
                >
                  <Icon name={option.icon} size={16} color={selected ? theme.accent : theme.textSub} />
                  <Text style={[s.themeOptionText, { color: selected ? theme.accent : theme.textSub }]}>{option.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {biometricAvailable ? (
            <>
              <View style={s.divider} />
              <Prefs theme={theme} s={s} icon="lock" label={`Entrar com ${biometricLabel}`} value={biometricEnabled} onChange={onBiometricChange} />
            </>
          ) : null}
          {/* O push já era registrado ao entrar, mas não havia como DESLIGAR:
              quem não queria ser acordado precisava desinstalar o app. */}
          {onPushChange ? (
            <>
              <View style={s.divider} />
              <Prefs
                theme={theme}
                s={s}
                icon="bell"
                label={pushSupported ? 'Alertas neste aparelho' : 'Alertas indisponíveis aqui'}
                value={pushEnabled && pushSupported}
                onChange={(v) => { if (pushSupported) onPushChange(v); }}
              />
            </>
          ) : null}
        </View>

        {/* Minhas câmeras — cadastro de câmera privada do próprio cliente (LGPD). */}
        <Text style={s.section}>Minhas câmeras</Text>
        <View style={s.group}>
          <Item theme={theme} s={s} icon="plus" label="Adicionar câmera" subtitle="Busca automática, QR Code ou endereço" onPress={() => setAddCameraOpen(true)} />
        </View>

        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Sair da conta" style={s.logout} activeOpacity={0.85} onPress={onLogout}>
          <Icon name="logout" size={18} color={theme.danger} />
          <Text style={s.logoutText}>Sair da conta</Text>
        </TouchableOpacity>

        <View style={s.footer} accessibilityLabel={`S2Cam. Versão ${version}`}>
          <Text style={s.footerText}>S2Cam · v{version}</Text>
        </View>
      </ScrollView>

      <AddCameraSheet
        visible={addCameraOpen}
        apiUrl={apiUrl}
        token={token ?? null}
        onClose={() => setAddCameraOpen(false)}
        onCreated={onCamerasChanged}
      />
      <Modal visible={passwordOpen} transparent animationType="fade" onRequestClose={closePassword}>
        <View style={s.modalRoot}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closePassword} accessibilityLabel="Fechar alteração de senha" />
          <View style={s.passwordCard}>
            <Text style={s.passwordTitle}>Alterar minha senha</Text>
            <Text style={s.passwordSub}>Use sua senha atual para confirmar que é você.</Text>
            <PasswordField s={s} label="Senha atual" value={currentPassword} onChange={setCurrentPassword} />
            <PasswordField s={s} label="Nova senha" value={newPassword} onChange={setNewPassword} />
            <PasswordField s={s} label="Confirmar nova senha" value={confirmPassword} onChange={setConfirmPassword} />
            {passwordError ? <Text style={s.passwordError}>{passwordError}</Text> : null}
            <View style={s.passwordActions}>
              <TouchableOpacity style={s.passwordCancel} disabled={passwordBusy} onPress={closePassword}><Text style={s.passwordCancelText}>Cancelar</Text></TouchableOpacity>
              <TouchableOpacity style={s.passwordSave} disabled={passwordBusy} onPress={() => { void changePassword(); }}>
                {passwordBusy ? <ActivityIndicator color={theme.textOnAccent} /> : <Text style={s.passwordSaveText}>Salvar senha</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PasswordField({ s, label, value, onChange }: { s: any; label: string; value: string; onChange: (value: string) => void }) {
  return <View style={{ gap: 6 }}><Text style={s.passwordLabel}>{label}</Text><TextInput value={value} onChangeText={onChange} secureTextEntry autoCapitalize="none" autoCorrect={false} style={s.passwordInput} /></View>;
}

function Prefs({ theme, s, icon, label, value, onChange }: { theme: any; s: any; icon: IconName; label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.pref}>
      <View style={s.prefIcon}><Icon name={icon} size={17} color={theme.textSub} /></View>
      <Text style={s.prefLabel}>{label}</Text>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.accent, false: theme.surfaceAlt }}
        thumbColor="#fff"
      />
    </View>
  );
}

function Item({ theme, s, icon, label, subtitle, onPress }: { theme: any; s: any; icon: IconName; label: string; subtitle?: string; onPress?: () => void }) {
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} style={s.pref} activeOpacity={0.7} onPress={onPress}>
      <View style={s.prefIcon}><Icon name={icon} size={17} color={theme.textSub} /></View>
      <View style={{ flex: 1 }}><Text style={[s.prefLabel, { flex: 0 }]}>{label}</Text>{subtitle ? <Text style={s.itemSubtitle}>{subtitle}</Text> : null}</View>
      <Icon name="forward" size={16} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 132 },
    title: { fontFamily: TITLE, fontSize: 26, fontWeight: '800', color: t.text, letterSpacing: -0.5, marginBottom: 16 },
    card: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 15 },
    avatar: { width: 50, height: 50, borderRadius: 16, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontFamily: TITLE, fontSize: 17, fontWeight: '700', color: '#fff' },
    profileName: { fontFamily: TITLE, fontSize: 17, fontWeight: '700', color: t.text },
    profileEmail: { fontFamily: UI, fontSize: 13, color: t.textSub, marginTop: 2 },
    roleBadge: { fontFamily: MONO, fontSize: 9.5, fontWeight: '600', color: t.accent, backgroundColor: t.accentBg, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, overflow: 'hidden' },
    providerIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: t.accentBg, alignItems: 'center', justifyContent: 'center' },
    providerName: { fontFamily: UI, fontSize: 15, fontWeight: '700', color: t.text },
    providerSub: { fontFamily: UI, fontSize: 12.5, color: t.textSub, marginTop: 2 },
    activeBadge: { backgroundColor: 'rgba(51,196,129,0.16)', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999 },
    activeText: { fontFamily: UI, fontSize: 12, fontWeight: '700', color: t.success },

    section: { fontFamily: MONO, fontSize: 11, fontWeight: '600', letterSpacing: 1, color: t.textMuted, marginTop: 24, marginBottom: 10, marginLeft: 2 },
    group: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, overflow: 'hidden' },
    themeOptions: { flexDirection: 'row', gap: 8, padding: 10 },
    themeOption: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: t.border, borderRadius: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: t.surfaceAlt },
    themeOptionText: { fontFamily: UI, fontSize: 12, fontWeight: '700' },
    pref: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 15, paddingVertical: 14 },
    prefIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    prefLabel: { flex: 1, fontFamily: UI, fontSize: 14.5, fontWeight: '500', color: t.text },
    itemSubtitle: { fontFamily: UI, fontSize: 11.5, color: t.textSub, marginTop: 2 },
    divider: { height: 1, backgroundColor: t.border, marginLeft: 62 },

    logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 24, height: 54, borderRadius: 16, borderWidth: 1, borderColor: t.dangerBg, backgroundColor: t.dangerBg },
    logoutText: { fontFamily: UI, fontSize: 15, fontWeight: '700', color: t.danger },
    updateCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderRadius: 16, padding: 13, marginTop: 18 },
    updateTitle: { fontFamily: UI, fontSize: 14, fontWeight: '700', color: t.text },
    updateText: { fontFamily: UI, fontSize: 11.5, color: t.textSub, marginTop: 2 },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 22 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    footerText: { fontFamily: MONO, fontSize: 11, color: t.textMuted },
    modalRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', alignItems: 'center', justifyContent: 'center', padding: 20 },
    passwordCard: { width: '100%', maxWidth: 480, borderRadius: 22, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, padding: 20, gap: 14 },
    passwordTitle: { fontFamily: TITLE, fontSize: 20, fontWeight: '800', color: t.text },
    passwordSub: { fontFamily: UI, fontSize: 13, lineHeight: 18, color: t.textSub, marginTop: -7 },
    passwordLabel: { fontFamily: UI, fontSize: 12, fontWeight: '700', color: t.textSub },
    passwordInput: { minHeight: 49, borderRadius: 13, borderWidth: 1, borderColor: t.border, backgroundColor: t.surfaceAlt, color: t.text, paddingHorizontal: 13, fontFamily: UI, fontSize: 15 },
    passwordError: { fontFamily: UI, fontSize: 12.5, lineHeight: 17, color: t.danger },
    passwordActions: { flexDirection: 'row', gap: 9, marginTop: 2 },
    passwordCancel: { flex: 1, minHeight: 48, borderRadius: 13, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' },
    passwordCancelText: { fontFamily: UI, fontSize: 14, fontWeight: '700', color: t.textSub },
    passwordSave: { flex: 1.35, minHeight: 48, borderRadius: 13, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    passwordSaveText: { fontFamily: UI, fontSize: 14, fontWeight: '800', color: t.textOnAccent },
  });
}
