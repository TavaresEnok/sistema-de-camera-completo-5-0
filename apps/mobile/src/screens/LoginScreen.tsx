/** LoginScreen — autenticação real (POST /auth/login via App). Visual do redesign. */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BRANDING, BRAND_LOGO } from '../branding';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../services/branding';
import { ALLOW_CLEARTEXT_TRAFFIC } from '../config';

interface LoginScreenProps {
  apiUrl: string;
  email: string;
  password: string;
  loading: boolean;
  onApiUrlChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onForgotPassword: () => void;
  biometricAvailable?: boolean;
  biometricLabel?: string;
  onBiometric?: () => void;
}

export function LoginScreen({
  apiUrl, email, password, loading,
  onApiUrlChange, onEmailChange, onPasswordChange, onSubmit, onForgotPassword,
  biometricAvailable = false, biometricLabel = 'Biometria', onBiometric,
}: LoginScreenProps) {
  const { theme, branding } = useTheme();
  const [show, setShow] = useState(false);
  // App white-label = servidor embutido no APK (BRANDING.apiUrl). Nesse caso o
  // usuário final NÃO vê nada de servidor/URL (é info interna). Só o app
  // genérico (sem servidor embutido) mostra o campo p/ digitar o endereço.
  const hasBakedServer = !!(BRANDING.apiUrl && BRANDING.apiUrl.trim());
  const [showServer, setShowServer] = useState(!apiUrl);
  // Servidor sem TLS num build que bloqueia tráfego em claro: o Android recusa
  // no nível do SISTEMA e o usuário só veria "erro de rede", sem pista da causa.
  const avisoDeCleartext = /^http:\/\//i.test((apiUrl ?? '').trim())
    && !ALLOW_CLEARTEXT_TRAFFIC;

  // A logo configurada em Aparência pertence exclusivamente ao aplicativo.
  const logoSource = branding.logoDataUrl ? { uri: branding.logoDataUrl } : BRAND_LOGO;
  const logoSize = Math.round(104 * branding.logoScale);

  return (
    <KeyboardAvoidingView
      style={[styles.keyboardRoot, { backgroundColor: theme.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.root}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
      <LinearGradient
        colors={[theme.accentBg, 'transparent']}
        start={{ x: 0.8, y: 0 }}
        end={{ x: 0.3, y: 0.6 }}
        style={styles.glow}
        pointerEvents="none"
      />

      <View style={styles.shell}>
      <View style={styles.hero}>
        <Image source={logoSource} style={[styles.logo, { width: logoSize, height: logoSize }]} resizeMode="contain" />
        <Text style={[styles.brand, { color: theme.bgText }]}>Monitoramento inteligente</Text>
      </View>

      <View style={styles.form}>
        <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="mail" size={19} color={theme.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>USUÁRIO</Text>
            <TextInput
              value={email}
              onChangeText={onEmailChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="default"
              placeholder="Seu usuário"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="Usuário"
              textContentType="username"
              autoComplete="username"
              returnKeyType="next"
              editable={!loading}
              maxLength={254}
              style={[styles.input, { color: theme.text }]}
            />
          </View>
        </View>

        <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="lock" size={19} color={theme.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>SENHA</Text>
            <TextInput
              value={password}
              onChangeText={onPasswordChange}
              secureTextEntry={!show}
              placeholder="••••••••"
              placeholderTextColor={theme.textMuted}
              onSubmitEditing={onSubmit}
              accessibilityLabel="Senha"
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="go"
              editable={!loading}
              maxLength={256}
              style={[styles.input, { color: theme.text }]}
            />
          </View>
          <Pressable
            onPress={() => setShow((s) => !s)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={show ? 'Ocultar senha' : 'Mostrar senha'}
          >
            <Icon name="eye" size={19} color={theme.textMuted} />
          </Pressable>
        </View>

        {!hasBakedServer && showServer ? (
          <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Icon name="server" size={19} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>ENDEREÇO DE ACESSO</Text>
              <TextInput
                value={apiUrl}
                onChangeText={onApiUrlChange}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://acesso.suaempresa.com.br"
                placeholderTextColor={theme.textMuted}
                accessibilityLabel="Endereço de acesso"
                textContentType="URL"
                autoComplete="url"
                editable={!loading}
                maxLength={2048}
                style={[styles.input, { color: theme.text }]}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.linksRow}>
          {!hasBakedServer ? (
            <Pressable onPress={() => setShowServer((s) => !s)} hitSlop={8}>
              <Text style={[styles.smallLink, { color: theme.textSub }]}>{showServer ? 'Ocultar endereço' : 'Endereço de acesso'}</Text>
            </Pressable>
          ) : <View />}
          <Pressable onPress={onForgotPassword} hitSlop={8}>
            <Text style={[styles.forgot, { color: theme.accent }]}>Esqueci minha senha</Text>
          </Pressable>
        </View>

        {/* Servidor sem TLS num build que bloqueia tráfego em claro: o Android
            recusa a conexão no nível do sistema e o usuário só veria um erro
            genérico de rede, sem pista da causa. Avisar ANTES de tentar. */}
        {avisoDeCleartext ? (
          <View style={[styles.aviso, { borderColor: theme.warning, backgroundColor: theme.surface }]}>
            <Icon name="alert" size={15} color={theme.warning} />
            <Text style={[styles.avisoTexto, { color: theme.textSub }]}>
              Este endereço não usa uma conexão segura. Use o endereço informado pela sua equipe.
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Entrar"
          accessibilityState={{ disabled: loading, busy: loading }}
        >
          <LinearGradient colors={[theme.accent, theme.accentDark]} style={[styles.cta, loading && { opacity: 0.7 }]}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Entrar</Text>}
          </LinearGradient>
        </Pressable>

        {biometricAvailable && onBiometric ? (
          <Pressable
            onPress={onBiometric}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={`Entrar com ${biometricLabel.toLowerCase()}`}
            style={[styles.biometricCta, { backgroundColor: theme.surface, borderColor: theme.accent }]}
          >
            <Icon name="lock" size={19} color={theme.accent} />
            <Text style={[styles.biometricText, { color: theme.accent }]}>Entrar com {biometricLabel.toLowerCase()}</Text>
          </Pressable>
        ) : null}

        {!hasBakedServer ? (
          <View style={styles.serverRow}>
            <View style={[styles.dot, { backgroundColor: apiUrl ? theme.success : theme.warning }]} />
            <Text style={[styles.serverText, { color: theme.textSub }]} numberOfLines={1}>
              {apiUrl ? `Acesso · ${apiUrl.replace(/^https?:\/\//, '')}` : 'Informe o endereço de acesso para continuar'}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.site, { color: withAlpha(theme.bgText, 0.58) ?? theme.bgText }]}>s2cam.com.br</Text>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboardRoot: { flex: 1 },
  root: { flexGrow: 1, paddingHorizontal: 30, justifyContent: 'center', paddingVertical: 40 },
  shell: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 360 },
  hero: { alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 40 },
  logo: { width: 104, height: 104, borderRadius: 25 },
  brand: { fontSize: 23, fontWeight: '800', letterSpacing: -0.4, marginTop: 2 },
  site: { textAlign: 'center', fontSize: 12.5, fontWeight: '700', letterSpacing: 0.4, marginTop: 28 },
  form: { gap: 13 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 11 },
  fieldLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  input: { fontSize: 15, fontWeight: '600', padding: 0, marginTop: 1 },
  linksRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallLink: { fontSize: 12.5, fontWeight: '700' },
  aviso: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  avisoTexto: { flex: 1, fontSize: 12, lineHeight: 17 },
  forgot: { textAlign: 'right', fontSize: 12.5, fontWeight: '700' },
  cta: { borderRadius: 15, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  biometricCta: { borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  biometricText: { fontSize: 14, fontWeight: '800' },
  serverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  serverText: { fontSize: 11.5, fontWeight: '600', maxWidth: '90%' },
});
