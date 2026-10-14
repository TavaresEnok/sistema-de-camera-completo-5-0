import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { request } from '../services/api';
import { addCommunityMessage, communityPollingAllowed, eligibleCommunityGroups, panicFeedback, type CommunityGroup, type CommunityMessage, type PanicResult } from '../services/group-community';
import { useTheme } from '../theme/ThemeProvider';

type Props = { apiUrl: string; token: string; userId: string; visible: boolean; pendingGroupId: string | null; onPendingHandled: () => void };

/** Grupos do servidor, nunca os mosaicos pessoais salvos no aparelho. */
export function GroupCommunityPanel({ apiUrl, token, userId, visible, pendingGroupId, onPendingHandled }: Props) {
  const { theme } = useTheme();
  const [groups, setGroups] = useState<CommunityGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CommunityMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const actions = useRef(new Set<AbortController>());
  const pendingHandled = useRef(onPendingHandled); pendingHandled.current = onPendingHandled;
  const scope = useRef(0), actionBusy = useRef(false), messageRequest = useRef(0);
  const selected = groups.find(group => group.id === selectedId);
  const polling = communityPollingAllowed(visible, appState);

  useEffect(() => {
    const listener = AppState.addEventListener('change', setAppState);
    return () => listener.remove();
  }, []);

  useEffect(() => {
    scope.current++; setGroups([]); setLoaded(false); setSelectedId(null); setMessages([]); setDraft(''); setBusy(false); actionBusy.current = false;
    return () => { scope.current++; for (const controller of actions.current) controller.abort(); actions.current.clear(); };
  }, [apiUrl, userId]);

  useEffect(() => {
    if (!polling) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await request<{ items: unknown }>(apiUrl, '/group-community', token, { signal: controller.signal });
        if (!stopped) { setGroups(eligibleCommunityGroups(response.items)); setLoaded(true); }
      } catch (e) {
        if (!stopped && [401, 403, 404].includes((e as { status?: number }).status ?? 0)) { setGroups([]); setLoaded(true); }
      } finally { if (!stopped) timer = setTimeout(load, 30_000); }
    };
    void load();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [apiUrl, token, userId, polling]);

  useEffect(() => {
    if (selectedId && loaded && !selected) { setSelectedId(null); setMessages([]); setDraft(''); }
  }, [loaded, selected, selectedId]);

  useEffect(() => {
    if (!pendingGroupId || !polling) return;
    let stopped = false; const controller = new AbortController();
    void request<{ items: unknown }>(apiUrl, '/group-community', token, { signal: controller.signal }).then(response => {
      if (stopped) return;
      const current = eligibleCommunityGroups(response.items); setGroups(current); setLoaded(true);
      if (current.some(group => group.id === pendingGroupId)) setSelectedId(pendingGroupId);
      else Alert.alert('Grupo indisponível', 'Você não tem acesso ao chat deste grupo no momento.');
      pendingHandled.current();
    }).catch(() => { if (!stopped) { Alert.alert('Não foi possível abrir o grupo', 'Verifique a conexão e tente abrir o chat pela tela inicial.'); pendingHandled.current(); } });
    return () => { stopped = true; controller.abort(); };
  }, [apiUrl, token, pendingGroupId, polling]);

  useEffect(() => { setMessages([]); setDraft(''); setError(''); messageRequest.current++; }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !polling) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      const sequence = ++messageRequest.current;
      setLoading(true);
      try {
        const response = await request<{ items: CommunityMessage[] }>(apiUrl, `/groups/${encodeURIComponent(selectedId)}/messages?limite=100`, token, { signal: controller.signal });
        if (!stopped && sequence === messageRequest.current) { setMessages(response.items); setError(''); }
      } catch (e) {
        if (stopped || sequence !== messageRequest.current) return;
        if ([401, 403, 404].includes((e as { status?: number }).status ?? 0)) { setSelectedId(null); setMessages([]); setGroups(current => current.filter(group => group.id !== selectedId)); }
        else setError('Não foi possível atualizar a conversa. Verifique a conexão.');
      } finally { if (!stopped) { setLoading(false); timer = setTimeout(load, 5_000); } }
    };
    void load();
    return () => { stopped = true; controller.abort(); messageRequest.current++; if (timer) clearTimeout(timer); };
  }, [apiUrl, token, selectedId, polling]);

  async function send(group: CommunityGroup, panic: boolean) {
    const text = draft.trim();
    if (actionBusy.current || !polling || (!panic && !text)) return;
    actionBusy.current = true; setBusy(true); setError('');
    const currentScope = scope.current, controller = new AbortController(); actions.current.add(controller);
    try {
      const result = await request<CommunityMessage | PanicResult>(apiUrl, `/groups/${encodeURIComponent(group.id)}/${panic ? 'alert' : 'messages'}`, token,
        { method: 'POST', body: JSON.stringify(panic ? {} : { texto: text }), signal: controller.signal });
      if (currentScope !== scope.current) return;
      messageRequest.current++;
      if (panic) {
        setSelectedId(group.id);
        if (selectedId === group.id) setMessages(current => addCommunityMessage(current, (result as PanicResult).mensagem));
        Alert.alert('Pedido de ajuda', panicFeedback(result as PanicResult));
      } else { setMessages(current => addCommunityMessage(current, result as CommunityMessage)); setDraft(''); }
    } catch (e) {
      if (currentScope !== scope.current) return;
      const denied = [401, 403, 404].includes((e as { status?: number }).status ?? 0);
      if (denied) { setGroups(current => current.filter(item => item.id !== group.id)); setSelectedId(null); }
      const message = denied ? 'Este grupo não está disponível para você no momento.' : 'Não foi possível confirmar o envio. Verifique a conexão antes de tentar novamente.';
      if (panic) Alert.alert('Pedido não confirmado', message); else setError(message);
    } finally { actions.current.delete(controller); if (currentScope === scope.current) { actionBusy.current = false; setBusy(false); } }
  }

  function panic(group: CommunityGroup) {
    Alert.alert('Pedir ajuda ao grupo?', `O grupo ${group.name} e a equipe responsável receberão o aviso. Isso não chama serviços de emergência.`,
      [{ text: 'Cancelar', style: 'cancel' }, { text: 'Enviar alerta', style: 'destructive', onPress: () => void send(group, true) }]);
  }

  const button = { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' as const, alignItems: 'center' as const, borderRadius: 12 };
  return <>
    {visible && groups.length > 0 ? <View style={{ paddingTop: 10, paddingBottom: 8, backgroundColor: theme.surface, borderTopColor: theme.border, borderTopWidth: 1 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 12 }}>
        {groups.map(group => <View key={group.id} style={{ width: 280, gap: 8 }}>
          <Text numberOfLines={1} style={{ color: theme.text, fontWeight: '600' }}>{group.name} · {group.memberCount} usuários</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Abrir chat de ${group.name}`} onPress={() => setSelectedId(group.id)} style={[button, { flex: 1, backgroundColor: theme.accentBg }]}><Text style={{ color: theme.accent, fontWeight: '600' }}>Chat do grupo</Text></TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Pânico no grupo ${group.name}`} disabled={busy} onPress={() => panic(group)} style={[button, { backgroundColor: theme.dangerBg, opacity: busy ? 0.5 : 1 }]}><Text style={{ color: theme.danger, fontWeight: '700' }}>Pânico</Text></TouchableOpacity>
          </View>
        </View>)}
      </ScrollView>
    </View> : null}
    <Modal visible={!!selected} animationType="slide" onRequestClose={() => setSelectedId(null)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={{ padding: 16, flexDirection: 'row', gap: 12, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: theme.border }}>
            <View style={{ flex: 1 }}><Text style={{ color: theme.text, fontSize: 18, fontWeight: '700' }} numberOfLines={1}>{selected?.name}</Text><Text style={{ color: theme.textSub }}>Chat do grupo</Text></View>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Fechar conversa" onPress={() => setSelectedId(null)} style={button}><Text style={{ color: theme.accent }}>Fechar</Text></TouchableOpacity>
          </View>
          {loading && messages.length === 0 ? <ActivityIndicator color={theme.accent} style={{ margin: 16 }} /> : null}
          <FlatList inverted data={messages} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16 }}
            ListEmptyComponent={!loading ? <Text style={{ color: theme.textSub, textAlign: 'center', transform: [{ scaleY: -1 }] }}>Comece a conversa com seu grupo.</Text> : null}
            renderItem={({ item }) => <View style={{ marginBottom: 12, padding: 12, borderRadius: 14, backgroundColor: item.kind === 'ALERT' ? theme.dangerBg : theme.surface, alignSelf: item.user.id === userId ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
              <Text style={{ color: item.kind === 'ALERT' ? theme.danger : theme.accent, fontWeight: '600' }}>{item.kind === 'ALERT' ? 'Pedido de ajuda · ' : ''}{item.user.name}</Text>
              <Text selectable style={{ color: theme.text, marginVertical: 6 }}>{item.body}</Text>
              <Text style={{ color: theme.textMuted, fontSize: 11 }}>{new Date(item.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>
            </View>} />
          {error ? <Text accessibilityRole="alert" style={{ color: theme.danger, paddingHorizontal: 16, paddingBottom: 8 }}>{error}</Text> : null}
          <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: theme.border }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <TextInput accessibilityLabel="Mensagem para o grupo" placeholder="Escreva uma mensagem" placeholderTextColor={theme.textMuted} value={draft} onChangeText={setDraft} multiline maxLength={500} editable={!busy} style={{ flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: theme.text, backgroundColor: theme.surface }} />
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Enviar mensagem" disabled={busy || !draft.trim() || !polling} onPress={() => selected && void send(selected, false)} style={[button, { backgroundColor: theme.accent, opacity: busy || !draft.trim() || !polling ? 0.5 : 1 }]}><Text style={{ color: theme.textOnAccent }}>Enviar</Text></TouchableOpacity>
            </View>
            <TouchableOpacity accessibilityRole="button" disabled={busy || !polling} onPress={() => selected && panic(selected)} style={[button, { backgroundColor: theme.dangerBg }]}><Text style={{ color: theme.danger, fontWeight: '700' }}>Pânico — pedir ajuda ao grupo</Text></TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  </>;
}
