/**
 * RONDA — o rodízio de mosaicos do mural, no celular.
 *
 * O administrador monta a ronda no sistema e marca "mostrar no celular". Até
 * 16/09/2026 essa marca não fazia nada: o app não tinha ronda nenhuma. Aqui ela
 * finalmente aparece.
 *
 * A regra do que rodar e por quanto tempo mora em utils/ronda.ts (pura e
 * testada). Esta tela só desenha e conta o tempo.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { LiveVideo } from '../components/VideoPlayers';
import { useTheme } from '../theme/ThemeProvider';
import type { Camera } from '../types';
import {
  camerasDaParada,
  duracaoDaVolta,
  paradasUteis,
  proximaParada,
  rondasDoCelular,
  segundosDaParada,
  type MosaicoDoApp,
  type RondaDoApp,
} from '../utils/ronda';

interface RondaScreenProps {
  rondas: RondaDoApp[];
  mosaicos: MosaicoDoApp[];
  cameras: Camera[];
  streamUrls: Record<string, string | null>;
  streamWhep: Record<string, string | null>;
  streamPosters: Record<string, string | null>;
  refreshing: boolean;
  onRefresh: () => void;
  onRequestStreams: (cameraIds: string[]) => void;
  onOpenCamera: (camera: Camera) => void;
}

function formatarDuracao(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  const min = Math.floor(segundos / 60);
  const resto = segundos % 60;
  return resto ? `${min}min ${resto}s` : `${min}min`;
}

export function RondaScreen({
  rondas, mosaicos, cameras, streamUrls, streamWhep, streamPosters,
  refreshing, onRefresh, onRequestStreams, onOpenCamera,
}: RondaScreenProps) {
  const { theme } = useTheme();
  const [rodandoId, setRodandoId] = useState<string | null>(null);
  const [indice, setIndice] = useState(0);
  const [pausada, setPausada] = useState(false);
  const [restante, setRestante] = useState(0);

  const idsVisiveis = useMemo(() => cameras.map((c) => c.id), [cameras]);
  const disponiveis = useMemo(
    () => rondasDoCelular(rondas, mosaicos, idsVisiveis),
    [rondas, mosaicos, idsVisiveis],
  );
  const emExecucao = useMemo(
    () => disponiveis.find((r) => r.id === rodandoId) ?? null,
    [disponiveis, rodandoId],
  );
  const paradas = useMemo(
    () => paradasUteis(emExecucao, mosaicos, idsVisiveis),
    [emExecucao, mosaicos, idsVisiveis],
  );
  const paradaAtual = paradas[Math.min(indice, Math.max(paradas.length - 1, 0))] ?? null;
  const idsDaParada = useMemo(
    () => camerasDaParada(paradaAtual, mosaicos, idsVisiveis),
    [paradaAtual, mosaicos, idsVisiveis],
  );
  const mosaicoAtual = mosaicos.find((m) => m.id === paradaAtual?.layoutId) ?? null;

  // A ronda que sumiu (desmarcada, apagada, sem imagem) não pode continuar
  // rodando na mão de quem já estava olhando.
  useEffect(() => {
    if (rodandoId && !emExecucao) setRodandoId(null);
  }, [rodandoId, emExecucao]);

  // Streams da parada atual: pedidos ao entrar nela, no perfil leve da grade.
  const pedirRef = useRef(onRequestStreams);
  pedirRef.current = onRequestStreams;
  useEffect(() => {
    if (!idsDaParada.length) return;
    pedirRef.current(idsDaParada);
  }, [idsDaParada.join(',')]);

  // Relógio da parada. Um `setInterval` por segundo só para o contador — a
  // troca de parada acontece quando ele chega a zero.
  useEffect(() => {
    if (!emExecucao || !paradaAtual) return;
    setRestante(segundosDaParada(paradaAtual));
  }, [emExecucao?.id, indice, paradaAtual?.layoutId]);

  useEffect(() => {
    if (!emExecucao || pausada || !paradas.length) return;
    const timer = setInterval(() => {
      // Ao voltar, retoma a mesma parada/contagem; não avança às cegas no fundo.
      if (AppState.currentState !== 'active') return;
      setRestante((atual) => {
        if (atual > 1) return atual - 1;
        setIndice((i) => proximaParada(i, paradas.length));
        return 0;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [emExecucao?.id, pausada, paradas.length]);

  const iniciar = (ronda: RondaDoApp) => {
    setRodandoId(ronda.id);
    setIndice(0);
    setPausada(false);
  };

  const sair = () => {
    setRodandoId(null);
    setPausada(false);
  };

  const avancar = () => {
    if (!paradas.length) return;
    setIndice((i) => proximaParada(i, paradas.length));
  };

  if (emExecucao && paradaAtual) {
    const total = segundosDaParada(paradaAtual);
    const progresso = total > 0 ? Math.max(0, Math.min(1, (total - restante) / total)) : 0;
    return (
      <View style={{ flex: 1 }}>
        <View style={styles.cabecalhoRonda}>
          <Pressable onPress={sair} accessibilityRole="button" accessibilityLabel="Encerrar ronda" style={styles.botaoIcone} hitSlop={10}>
            <Icon name="chevronLeft" size={20} color={theme.text} strokeWidth={2} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={[styles.tituloRonda, { color: theme.text }]} numberOfLines={1}>{emExecucao.name}</Text>
            <Text style={[styles.subRonda, { color: theme.textSub }]} numberOfLines={1}>
              {mosaicoAtual?.name ?? 'Mosaico'} · parada {indice + 1} de {paradas.length} · {restante}s
            </Text>
          </View>
          <Pressable
            onPress={() => setPausada((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={pausada ? 'Retomar ronda' : 'Pausar ronda'}
            accessibilityState={{ selected: pausada }}
            style={styles.botaoIcone}
            hitSlop={10}
          >
            <Icon name={pausada ? 'play' : 'pause'} size={20} color={pausada ? theme.accent : theme.text} strokeWidth={2} />
          </Pressable>
          <Pressable onPress={avancar} accessibilityRole="button" accessibilityLabel="Próxima parada" style={styles.botaoIcone} hitSlop={10}>
            <Icon name="forward" size={20} color={theme.text} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Barra de progresso da parada: mostra que a ronda está VIVA. Ronda
            parada sem ninguém perceber é o defeito que não parece defeito. */}
        <View style={[styles.trilho, { backgroundColor: theme.border }]}>
          <View style={[styles.progresso, { backgroundColor: pausada ? theme.textMuted : theme.accent, width: `${progresso * 100}%` }]} />
        </View>

        <ScrollView contentContainerStyle={styles.gradeRonda}>
          {idsDaParada.map((id) => {
            const camera = cameras.find((c) => c.id === id);
            if (!camera) return null;
            const hls = streamUrls[id] ?? null;
            const whep = streamWhep[id] ?? null;
            return (
              <Pressable
                key={id}
                onPress={() => onOpenCamera(camera)}
                accessibilityRole="button"
                accessibilityLabel={`Abrir ${camera.name}`}
                style={[styles.quadro, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}
              >
                <LiveVideo
                  uri={hls}
                  whepUri={whep}
                  posterUri={streamPosters[id] ?? null}
                  videoStyle={StyleSheet.absoluteFill as never}
                  emptyStyle={styles.quadroVazio}
                  posterStyle={StyleSheet.absoluteFill as never}
                  emptyTitleStyle={[styles.quadroVazioTitulo, { color: theme.textSub }]}
                  emptyTextStyle={[styles.quadroVazioTexto, { color: theme.textMuted }]}
                  muted
                  contentFit="contain"
                />
                <View style={styles.nomeQuadro}>
                  <Text style={styles.nomeQuadroTexto} numberOfLines={1}>{camera.name}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.lista}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    >
      <Text style={[styles.titulo, { color: theme.bgText }]}>Ronda</Text>
      <Text style={[styles.explicacao, { color: theme.textSub }]}>
        O mosaico troca sozinho no tempo que o administrador definiu para cada parada.
      </Text>

      {disponiveis.length === 0 ? (
        <View style={[styles.vazio, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="clock" size={22} color={theme.textMuted} strokeWidth={1.8} />
          <Text style={[styles.vazioTitulo, { color: theme.text }]}>Nenhuma ronda para o celular</Text>
          <Text style={[styles.vazioTexto, { color: theme.textSub }]}>
            No sistema, abra a ronda e marque "mostrar no celular". Ela aparece aqui para quem tem acesso às câmeras dela.
          </Text>
        </View>
      ) : (
        disponiveis.map((ronda) => {
          const uteis = paradasUteis(ronda, mosaicos, idsVisiveis);
          return (
            <Pressable
              key={ronda.id}
              onPress={() => iniciar(ronda)}
              accessibilityRole="button"
              accessibilityLabel={`Iniciar ${ronda.name}`}
              style={[styles.cartao, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <View style={[styles.cartaoIcone, { backgroundColor: theme.accentBg }]}>
                <Icon name="clock" size={18} color={theme.accent} strokeWidth={1.9} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cartaoTitulo, { color: theme.text }]} numberOfLines={1}>{ronda.name}</Text>
                <Text style={[styles.cartaoSub, { color: theme.textSub }]} numberOfLines={1}>
                  {uteis.length} {uteis.length === 1 ? 'parada' : 'paradas'} · volta de {formatarDuracao(duracaoDaVolta(uteis))}
                </Text>
              </View>
              <Icon name="play" size={18} color={theme.accent} strokeWidth={2} />
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  lista: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 24 },
  titulo: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5, marginTop: 10, marginBottom: 6 },
  explicacao: { fontSize: 13.5, lineHeight: 19, marginBottom: 16 },
  cartao: {
    flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth, padding: 14, marginBottom: 10,
  },
  cartaoIcone: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cartaoTitulo: { fontSize: 15.5, fontWeight: '700' },
  cartaoSub: { fontSize: 12.5, marginTop: 2 },
  vazio: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 18, alignItems: 'center', gap: 8 },
  vazioTitulo: { fontSize: 15, fontWeight: '700' },
  vazioTexto: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  cabecalhoRonda: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8 },
  botaoIcone: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  tituloRonda: { fontSize: 16, fontWeight: '700' },
  subRonda: { fontSize: 12, marginTop: 1 },
  trilho: { height: 3, marginHorizontal: 14, borderRadius: 2, overflow: 'hidden' },
  progresso: { height: 3, borderRadius: 2 },
  gradeRonda: { padding: 10, gap: 10 },
  quadro: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  quadroVazio: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  quadroVazioTitulo: { fontSize: 13, fontWeight: '600' },
  quadroVazioTexto: { fontSize: 11.5 },
  nomeQuadro: { position: 'absolute', left: 8, bottom: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.55)' },
  nomeQuadroTexto: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
