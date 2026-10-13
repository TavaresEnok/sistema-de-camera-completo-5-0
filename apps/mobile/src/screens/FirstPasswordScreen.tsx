import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { request } from '../services/api';
import type { Session, User } from '../types';

export function FirstPasswordScreen({ session, onComplete, onExit }: { session: Session; onComplete: (value: Session) => Promise<void>; onExit: () => void }) {
  const { theme } = useTheme();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit() {
    if (busy || saved) return;
    if (password.length < 8 || password === session.user.username || password === current) { setError('Escolha uma senha diferente do CPF, com pelo menos 8 caracteres.'); return; }
    if (confirmation !== password) { setError('As novas senhas precisam ser iguais.'); return; }
    setBusy(true); setError('');
    let changed = false;
    try {
      await request(session.apiUrl, '/users/me/password', session.token, { method: 'PATCH', body: JSON.stringify({ currentPassword: current, newPassword: password }) });
      changed = true; setSaved(true);
      const data = await request<{ accessToken: string; refreshToken: string; refreshExpiresAt: string; user: User }>(session.apiUrl, '/auth/login', undefined, { method: 'POST', body: JSON.stringify({ username: session.user.username, password }) });
      await onComplete({ ...session, token: data.accessToken, refreshToken: data.refreshToken, refreshExpiresAt: data.refreshExpiresAt, user: data.user });
    } catch { setError(changed ? 'Senha salva. Saia e entre novamente usando sua nova senha.' : 'Não foi possível trocar a senha. Confira a senha atual e tente novamente.'); }
    finally { setBusy(false); }
  }
  const field = { minHeight: 48, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, color: theme.text, backgroundColor: theme.surface };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }} keyboardShouldPersistTaps="handled"><View style={{ width: '100%', maxWidth: 460, alignSelf: 'center', gap: 16 }}><Text style={{ fontSize: 24, fontWeight: '700', color: theme.text }}>Escolha sua nova senha</Text><Text style={{ fontSize: 15, lineHeight: 23, color: theme.textSub }}>Seu primeiro acesso usa o CPF como senha. Crie uma senha só sua para continuar e acessar suas câmeras.</Text><Text style={{ color: theme.text }}>Senha atual</Text><TextInput accessibilityLabel="Senha atual" style={field} value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" /><Text style={{ color: theme.text }}>Nova senha</Text><TextInput accessibilityLabel="Nova senha" style={field} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" maxLength={72} /><Text style={{ color: theme.text }}>Repita a nova senha</Text><TextInput accessibilityLabel="Repita a nova senha" style={field} value={confirmation} onChangeText={setConfirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="newPassword" maxLength={72} />{error ? <Text accessibilityRole="alert" style={{ color: theme.danger }}>{error}</Text> : null}<Pressable disabled={busy || saved} onPress={() => void submit()} style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, backgroundColor: theme.accent, opacity: busy || saved ? 0.5 : 1 }}><Text style={{ color: theme.textOnAccent, fontWeight: '700' }}>{busy ? 'Salvando…' : 'Salvar e continuar'}</Text></Pressable><Pressable onPress={onExit} disabled={busy} style={{ minHeight: 48, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: theme.text }}>Sair</Text></Pressable></View></ScrollView></KeyboardAvoidingView>;
}
