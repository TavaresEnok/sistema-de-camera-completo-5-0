/**
 * CentralScreen — home do app: resumo do sistema (card em gradiente da marca),
 * alerta operacional, câmera em DESTAQUE + grade de favoritas e um trilho
 * horizontal com todas as câmeras. Hierarquia forte (padrão dos apps líderes:
 * hero card → destaque → grade → trilho).
 */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraTile } from '../components/CameraTile';
import { AddCameraSheet } from '../components/AddCameraSheet';
import { FavoritesSheet } from '../components/FavoritesSheet';
import { Icon, type IconName } from '../components/Icon';
import { CameraGridSkeleton } from '../components/Skeleton';
import { useLibrary } from '../state/LibraryProvider';
import { useTheme } from '../theme/ThemeProvider';
import type { Alarm, Camera, User } from '../types';
import { isOnlineStatus } from '../utils/camera-view';

const STAR_GOLD = '#fbbf24';
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

interface CentralScreenProps {
  cameras: Camera[];
  user: User | null;
  streamPosters: Record<string, string | null>;
  operationalMessages: string[];
  alarms: Alarm[];
  alarmCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenCamera: (camera: Camera) => void;
  onOpenAlarms: () => void;
  onOpenMosaic: () => void;
  onOpenPlayback: () => void;
  onOpenSettings: () => void;
  onPosterError?: (cameraId: string) => void;
  apiUrl: string;
  token: string | null;
  onCamerasChanged?: () => void;
}

function initialsOf(name?: string): string {
  if (!name) return 'DR';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'DR';
}

function todayLabel(): string {
  const d = new Date();
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

export function CentralScreen({
  cameras, user, streamPosters, operationalMessages, alarms, alarmCount, refreshing, onRefresh,
  onOpenCamera, onOpenAlarms, onOpenMosaic, onOpenPlayback, onOpenSettings, onPosterError,
  apiUrl, token, onCamerasChanged,
}: CentralScreenProps) {
  const { theme, branding } = useTheme();
  const { favorites, isFavorite, toggleFavorite } = useLibrary();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [addCameraOpen, setAddCameraOpen] = useState(false);

  const stats = useMemo(() => {
    const online = cameras.filter((c) => isOnlineStatus(c.status)).length;
    return { online, offline: cameras.length - online, total: cameras.length };
  }, [cameras]);

  const favCameras = useMemo(
    () => favorites.map((id) => cameras.find((c) => c.id === id)).filter(Boolean) as Camera[],
    [favorites, cameras],
  );
  // 1 destaque grande + até 4 na grade.
  const featured = favCameras[0] ?? null;
  const favGrid = favCameras.slice(1, 5);
  const alert = operationalMessages[0] ?? null;
  const latestAlarm = alarms.find((alarm) => alarm.status === 'OPEN') ?? alarms[0] ?? null;

  // Stat com ícone dentro do hero card (texto branco sobre o gradiente da marca).
  const HeroStat = ({ icon, label, value }: { icon: IconName; label: string; value: number }) => (
    <View style={styles.heroStat}>
      <View style={styles.heroStatIcon}>
        <Icon name={icon} size={15} color="#fff" strokeWidth={2} />
      </View>
      <Text style={styles.heroStatValue}>{value}</Text>
      <Text style={styles.heroStatLabel}>{label}</Text>
    </View>
  );

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textSub} />}
    >
      {/* ── Header: saudação × logo/sino/avatar ── */}
      <View style={styles.header}>
        <Pressable style={{ flexShrink: 1, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel="Abrir configurações" onPress={onOpenSettings}>
          <Text style={[styles.greeting, { color: theme.textSub }]}>{todayLabel()}</Text>
          <Text style={[styles.title, { color: theme.bgText }]} numberOfLines={1}>
            Olá, {user?.name?.trim().split(/\s+/)[0] ?? 'Usuário'}
          </Text>
        </Pressable>
        <View style={styles.headerActions}>
          {branding.logoDataUrl ? (
            <Image source={{ uri: branding.logoDataUrl }} style={styles.headerLogo} resizeMode="contain" />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Adicionar câmera"
            style={[styles.iconBtn, { backgroundColor: theme.accent, borderColor: theme.accent }]}
            onPress={() => setAddCameraOpen(true)}
          >
            <Icon name="plus" size={21} color={theme.textOnAccent} strokeWidth={2.4} />
          </Pressable>
          <Pressable
            style={[
              styles.iconBtn,
              alarmCount > 0
                ? { backgroundColor: theme.dangerBg, borderColor: 'rgba(239,68,68,0.45)' }
                : { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            onPress={onOpenAlarms}
          >
            <Icon name="bell" size={21} color={alarmCount > 0 ? theme.danger : theme.text} strokeWidth={2} />
            {alarmCount > 0 ? (
              <View style={[styles.notifBadge, { backgroundColor: theme.danger, borderColor: theme.surface }]}>
                <Text style={styles.notifBadgeText}>{alarmCount > 99 ? '99+' : alarmCount}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable style={[styles.avatar, { backgroundColor: theme.accent }]} hitSlop={8} accessibilityRole="button" accessibilityLabel="Configurações da conta" onPress={onOpenSettings}>
            <Text style={[styles.avatarText, { color: theme.textOnAccent }]}>{initialsOf(user?.name)}</Text>
          </Pressable>
        </View>
      </View>

      {/* ── Hero: resumo do sistema no gradiente da marca ── */}
      <LinearGradient
        colors={[theme.accent, theme.accentDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroKicker}>SISTEMA DE MONITORAMENTO</Text>
            <Text style={styles.heroTitle} numberOfLines={1}>
              {branding.facilityName || 'Minhas câmeras'}
            </Text>
          </View>
          <View style={[styles.heroBadge, stats.offline > 0 ? styles.heroBadgeWarn : null]}>
            <View style={[styles.heroBadgeDot, { backgroundColor: stats.offline > 0 ? '#fbbf24' : '#4ade80' }]} />
            <Text style={styles.heroBadgeText}>{stats.offline > 0 ? 'Atenção' : 'Operacional'}</Text>
          </View>
        </View>
        <View style={styles.heroDivider} />
        <View style={styles.heroStats}>
          <HeroStat icon="camera" label="Online" value={stats.online} />
          <HeroStat icon="videoOff" label="Offline" value={stats.offline} />
          <HeroStat icon="grid" label="Total" value={stats.total} />
        </View>
      </LinearGradient>

      <View style={styles.quickActions}>
        {[
          { label: 'Mosaico', icon: 'grid' as const, onPress: onOpenMosaic },
          { label: 'Gravações', icon: 'play' as const, onPress: onOpenPlayback },
          { label: 'Alarmes', icon: 'bell' as const, onPress: onOpenAlarms, badge: alarmCount },
        ].map((action) => (
          <Pressable
            key={action.label}
            style={[styles.quickAction, { backgroundColor: theme.surface, borderColor: theme.border }]}
            onPress={action.onPress}
            accessibilityRole="button"
            accessibilityLabel={`Abrir ${action.label}`}
          >
            <View style={[styles.quickIcon, { backgroundColor: theme.accentBg }]}>
              <Icon name={action.icon} size={18} color={theme.accent} strokeWidth={2} />
            </View>
            <Text style={[styles.quickLabel, { color: theme.text }]}>{action.label}</Text>
            {action.badge ? (
              <View style={[styles.quickBadge, { backgroundColor: theme.danger }]}>
                <Text style={styles.quickBadgeText}>{action.badge > 99 ? '99+' : action.badge}</Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>

      {/* ── Alerta operacional ── */}
      {alert ? (
        <View style={[styles.alert, { backgroundColor: 'rgba(245,158,11,0.1)', borderColor: 'rgba(245,158,11,0.28)' }]}>
          <View style={[styles.alertIcon, { backgroundColor: 'rgba(245,158,11,0.18)' }]}>
            <Icon name="alert" size={17} color={theme.warning} strokeWidth={2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.alertTitle, { color: theme.text }]}>Atenção operacional</Text>
            <Text style={[styles.alertText, { color: theme.textSub }]}>{alert}</Text>
          </View>
        </View>
      ) : null}

      {/* ── Favoritas: 1 destaque grande + grade ── */}
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <Icon name="star" size={16} color={STAR_GOLD} fill strokeWidth={1.6} />
          <Text style={[styles.sectionTitle, { color: theme.bgText }]}>Favoritas</Text>
        </View>
        <Pressable style={styles.manageLink} onPress={() => setSheetOpen(true)} hitSlop={8}>
          <Icon name="plus" size={14} color={theme.accent} strokeWidth={2.2} />
          <Text style={[styles.sectionLink, { color: theme.accent }]}>Gerenciar</Text>
        </Pressable>
      </View>

      {refreshing && cameras.length === 0 ? (
        <CameraGridSkeleton />
      ) : featured ? (
        <>
          <CameraTile
            camera={featured}
            posterUrl={streamPosters[featured.id]}
            height={198}
            variant="large"
            showPlay
            onPress={() => onOpenCamera(featured)}
            onPosterError={onPosterError}
            favorite={isFavorite(featured.id)}
            onToggleFavorite={() => toggleFavorite(featured.id)}
          />
          {favGrid.length > 0 ? (
            <View style={styles.grid}>
              {favGrid.map((cam) => (
                <View key={cam.id} style={styles.gridItem}>
                  <CameraTile
                    camera={cam}
                    posterUrl={streamPosters[cam.id]}
                    height={124}
                    onPress={() => onOpenCamera(cam)}
                    onPosterError={onPosterError}
                    favorite={isFavorite(cam.id)}
                    onToggleFavorite={() => toggleFavorite(cam.id)}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <View style={[styles.empty, { borderColor: theme.border }]}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.surface }]}>
            <Icon name="star" size={24} color={STAR_GOLD} strokeWidth={1.7} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Nenhuma câmera favorita</Text>
          <Text style={[styles.emptyText, { color: theme.textSub }]}>Toque na estrela de uma câmera para fixá-la aqui.</Text>
          <Pressable style={[styles.emptyBtn, { backgroundColor: theme.accent }]} onPress={() => setSheetOpen(true)}>
            <Text style={[styles.emptyBtnText, { color: theme.textOnAccent }]}>Escolher favoritas</Text>
          </Pressable>
        </View>
      )}

      {latestAlarm ? (
        <Pressable
          style={[styles.recentEvent, { backgroundColor: theme.surface, borderColor: theme.border }]}
          onPress={onOpenAlarms}
          accessibilityRole="button"
          accessibilityLabel="Abrir evento mais recente"
        >
          <View style={[styles.recentEventIcon, { backgroundColor: latestAlarm.status === 'OPEN' ? theme.dangerBg : theme.accentBg }]}>
            <Icon name={latestAlarm.type.includes('MOTION') ? 'eye' : 'alert'} size={18} color={latestAlarm.status === 'OPEN' ? theme.danger : theme.accent} strokeWidth={2} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.recentEventKicker, { color: theme.textSub }]}>EVENTO RECENTE</Text>
            <Text style={[styles.recentEventTitle, { color: theme.text }]} numberOfLines={1}>
              {latestAlarm.title || latestAlarm.cameraName || 'Alerta do sistema'}
            </Text>
            <Text style={[styles.recentEventMeta, { color: theme.textSub }]} numberOfLines={1}>
              {latestAlarm.cameraName || 'Sistema'} · {new Date(latestAlarm.occurredAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <Icon name="chevronRight" size={17} color={theme.textMuted} strokeWidth={2} />
        </Pressable>
      ) : null}

      {/* ── Todas as câmeras: trilho horizontal de acesso rápido ── */}
      {cameras.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Icon name="grid" size={15} color={theme.textSub} strokeWidth={2} />
              <Text style={[styles.sectionTitle, { color: theme.bgText }]}>Todas as câmeras</Text>
            </View>
            <View style={[styles.countChip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.countChipText, { color: theme.textSub }]}>{cameras.length}</Text>
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rail}
            style={styles.railWrap}
          >
            {cameras.map((cam) => (
              <View key={cam.id} style={styles.railItem}>
                <CameraTile
                  camera={cam}
                  posterUrl={streamPosters[cam.id]}
                  height={104}
                  onPress={() => onOpenCamera(cam)}
                  onPosterError={onPosterError}
                  favorite={isFavorite(cam.id)}
                  onToggleFavorite={() => toggleFavorite(cam.id)}
                />
              </View>
            ))}
          </ScrollView>
        </>
      ) : null}

      <FavoritesSheet visible={sheetOpen} cameras={cameras} onClose={() => setSheetOpen(false)} />
      <AddCameraSheet visible={addCameraOpen} apiUrl={apiUrl} token={token} onClose={() => setAddCameraOpen(false)} onCreated={onCamerasChanged} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 28, gap: 15 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 2, gap: 12 },
  greeting: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  title: { fontSize: 25, fontWeight: '800', letterSpacing: -0.5, marginTop: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerLogo: { height: 42, width: 48, borderRadius: 14 },
  iconBtn: { width: 42, height: 42, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  notifBadge: { position: 'absolute', top: -6, right: -6, minWidth: 19, height: 19, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  notifBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '800', fontSize: 15 },

  // Hero (resumo no gradiente da marca)
  hero: { borderRadius: 22, padding: 18, paddingBottom: 16 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroKicker: { color: 'rgba(255,255,255,0.72)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1.2 },
  heroTitle: { color: '#fff', fontSize: 18.5, fontWeight: '800', letterSpacing: -0.3, marginTop: 2 },
  heroBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 999, paddingVertical: 6, paddingHorizontal: 11 },
  heroBadgeWarn: { backgroundColor: 'rgba(0,0,0,0.18)' },
  heroBadgeDot: { width: 7, height: 7, borderRadius: 4 },
  heroBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  heroDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.25)', marginVertical: 14 },
  heroStats: { flexDirection: 'row', alignItems: 'stretch' },
  heroStat: { flex: 1, alignItems: 'center', gap: 3 },
  heroStatIcon: { width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  heroStatValue: { color: '#fff', fontSize: 21, fontWeight: '800', letterSpacing: -0.5 },
  heroStatLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 10.5, fontWeight: '700' },

  quickActions: { flexDirection: 'row', gap: 9 },
  quickAction: { flex: 1, minHeight: 75, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', gap: 6, position: 'relative' },
  quickIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  quickLabel: { fontSize: 10.5, fontWeight: '800' },
  quickBadge: { position: 'absolute', top: 7, right: 7, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  quickBadgeText: { color: '#fff', fontSize: 9, fontWeight: '900' },

  alert: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  alertIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  alertTitle: { fontSize: 13.5, fontWeight: '700' },
  alertText: { fontSize: 12.5, fontWeight: '500', lineHeight: 18, marginTop: 2 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  manageLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sectionLink: { fontSize: 12.5, fontWeight: '700' },
  countChip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 3, paddingHorizontal: 10 },
  countChipText: { fontSize: 11.5, fontWeight: '800' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  gridItem: { width: '47%', flexGrow: 1 },

  recentEvent: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth, padding: 13 },
  recentEventIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  recentEventKicker: { fontSize: 8.5, fontWeight: '900', letterSpacing: 0.9 },
  recentEventTitle: { fontSize: 13.5, fontWeight: '800', marginTop: 1 },
  recentEventMeta: { fontSize: 11, fontWeight: '600', marginTop: 2 },

  // Trilho horizontal "todas as câmeras" — sangra até as bordas da tela.
  railWrap: { marginHorizontal: -20 },
  rail: { paddingHorizontal: 20, gap: 11 },
  railItem: { width: 158 },

  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 20, paddingVertical: 30, paddingHorizontal: 22, alignItems: 'center', gap: 12 },
  emptyIcon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 14.5, fontWeight: '800' },
  emptyText: { fontSize: 12.5, fontWeight: '500', textAlign: 'center', marginTop: -6 },
  emptyBtn: { borderRadius: 12, paddingVertical: 11, paddingHorizontal: 20 },
  emptyBtnText: { fontSize: 13, fontWeight: '800' },
});
