import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { request } from '../services/api';
import { showAppNotice } from '../services/app-notice';
import { userFacingError } from '../services/user-facing-error';
import type { Alarm, Session } from '../types';

const POLL_INTERVAL_MS = 30_000;

function isCustomerCameraEvent(alarm: Alarm): boolean {
  if (!alarm.cameraId) return false;
  const type = String(alarm.type ?? '').toLowerCase();
  return !['offline', 'online', 'system', 'disk', 'storage', 'recording', 'health'].some((term) => type.includes(term));
}

export type UseAlarms = {
  alarms: Alarm[];
  openAlarmCount: number;
  total: number;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  ack: (alarm: Alarm) => Promise<void>;
  resolve: (alarm: Alarm) => Promise<void>;
  /** Falha na última carga — distingue "não há alarmes" de "não consegui perguntar". */
  erro: string | null;
  carregando: boolean;
};

/**
 * Estado e ações dos alarmes no app. Carrega sob demanda (`reload`, usado também no
 * pull-to-refresh) e sonda a cada 30s — substituto temporário do push, que exige um
 * dev build. As ações aguardam confirmação e recarregam para reconciliar.
 */
export function useAlarms(session: Session | null): UseAlarms {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [total, setTotal] = useState(0);
  const [openAlarmCount, setOpenAlarmCount] = useState(0);
  const offset = useRef(0);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const identity = `${session?.apiUrl ?? ''}|${session?.user.id ?? ''}|${session?.token ?? ''}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const transitions = useRef(new Set<string>());
  useEffect(() => {
    generation.current++;
    pending.current?.abort();
    transitions.current.clear();
    offset.current = 0;
    setTotal(0); setOpenAlarmCount(0);
    setAlarms([]); setErro(null); setCarregando(false);
    return () => { generation.current++; pending.current?.abort(); };
  }, [identity]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  const loadPage = useCallback(async (append = false) => {
    if (!session) return;
    if (append && pending.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const sequence = ++generation.current;
    const valid = () => identityRef.current === identity && sequence === generation.current && !controller.signal.aborted;
    setCarregando(true);
    try {
      const pageOffset = append ? offset.current : 0;
      const data = await request<{ items: Alarm[]; total?: number; openTotal?: number }>(session.apiUrl, `/cameras/alarms?limit=100&customerEvents=true&offset=${pageOffset}`, session.token, { signal: controller.signal });
      if (!valid()) return;
      // O aplicativo é do cliente final. Diagnósticos de servidor, disco,
      // gravação e conectividade continuam na operação web, não no celular.
      const items = Array.isArray(data.items) ? data.items.filter(isCustomerCameraEvent) : [];
      offset.current = pageOffset + (data.items?.length ?? 0);
      setAlarms(current => append ? Array.from(new Map([...current, ...items].map(item => [item.id, item])).values()) : items);
      setTotal(data.total ?? items.length);
      setOpenAlarmCount(data.openTotal ?? items.filter(item => item.status === 'OPEN').length);
      setErro(null);
    } catch (erro) {
      if (!valid()) return;
      // ERRO ≠ "TUDO TRANQUILO". Mantém a lista atual (falha transitória não
      // apaga o que já está na tela), mas REGISTRA a falha: sem isto, uma
      // primeira carga que falhasse deixava `alarms: []` e a tela afirmava
      // "Tudo tranquilo — nenhum alarme". Numa central de alarmes, essa é a
      // mentira mais cara que a interface pode contar.
      setErro(userFacingError(erro, 'Não foi possível atualizar os avisos. Verifique a conexão e tente novamente.'));
    } finally {
      if (valid()) { setCarregando(false); pending.current = null; }
    }
  }, [identity]);
  const reload = useCallback(() => loadPage(false), [loadPage]);
  const loadMore = useCallback(() => loadPage(true), [loadPage]);

  const transition = useCallback(
    async (alarm: Alarm, action: 'ack' | 'resolve', optimisticStatus: Alarm['status'], failMessage: string) => {
      if (!session || transitions.current.has(alarm.id)) return;
      transitions.current.add(alarm.id);
      try {
        await request(session.apiUrl, `/cameras/alarms/${alarm.id}/${action}`, session.token, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (identityRef.current !== identity) return;
        setAlarms((current) => current.map((item) => (item.id === alarm.id ? { ...item, status: optimisticStatus } : item)));
        void reload();
      } catch (error) {
        if (identityRef.current !== identity) return;
        void reload();
        showAppNotice('Não foi possível atualizar o aviso', userFacingError(error, failMessage), 'error');
      } finally {
        if (identityRef.current === identity) transitions.current.delete(alarm.id);
      }
    },
    [identity, reload],
  );

  const ack = useCallback(
    (alarm: Alarm) => transition(alarm, 'ack', 'ACKED', 'Não foi possível reconhecer o alarme.'),
    [transition],
  );
  const resolve = useCallback(
    (alarm: Alarm) => transition(alarm, 'resolve', 'RESOLVED', 'Não foi possível resolver o alarme.'),
    [transition],
  );

  useEffect(() => {
    if (!session) {
      setAlarms([]);
      return;
    }
    if (!foreground) return;
    const interval = setInterval(() => { void reload(); }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session?.token, reload, foreground]);

  return { alarms, total, openAlarmCount, reload, loadMore, ack, resolve, erro, carregando };
}
