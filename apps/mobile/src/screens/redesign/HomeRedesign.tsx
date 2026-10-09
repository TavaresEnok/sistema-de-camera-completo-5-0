/**
 * Início (redesign) — réplica em React Native da tela "Início" do mockup
 * (novo-mockup-app-drac). Recebe EXATAMENTE os mesmos dados que a CentralScreen atual,
 * então o App só troca um componente pelo outro quando isRedesign.
 *
 * Fiel ao handoff: saudação, estado das câmeras e acesso rápido ao ao vivo.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon } from '../../components/Icon';
import { AddCameraSheet } from '../../components/AddCameraSheet';
import { isRecordingArmed, isOnlineStatus } from '../../utils/camera-view';
import { loadFeaturedCameraId, saveFeaturedCameraId } from './featuredCamera';
import type { Alarm, Camera } from '../../types';

const TITLE = 'Sora';
const UI = 'InstrumentSans';
const MONO = 'JetBrainsMono';

interface Props {
  cameras: Camera[];
  user: { name?: string | null; email?: string } | null;
  streamPosters: Record<string, string | null>;
  alarms: Alarm[];
  alarmCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenCamera: (camera: Camera) => void;
  onOpenAlarms: () => void;
  onOpenMosaic: () => void;
  onOpenPlayback: () => void;
  onOpenSettings: () => void;
  facilityName?: string;
  /** Poster expirado/quebrado → pede um novo ao App. */
  onPosterError?: (cameraId: string) => void;
  apiUrl: string;
  token: string | null;
  onCamerasChanged?: () => void;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function initials(name?: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'U';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Relógio isolado: só ele re-renderiza a cada segundo (não a tela inteira). */
function ClockBadge({ style, textStyle }: { style: any; textStyle: any }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={style}>
      <Text style={textStyle}>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</Text>
    </View>
  );
}

export function HomeRedesign(props: Props) {
  const { cameras, user, streamPosters, alarmCount, refreshing, onRefresh, onOpenCamera, onOpenAlarms, facilityName, onPosterError } = props;
  const { theme } = useTheme();
  const [addCameraOpen, setAddCameraOpen] = useState(false);

  // Destaque: escolha fixada pelo usuário (long-press num card) > 1ª online.
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  useEffect(() => { void loadFeaturedCameraId().then(setFeaturedId).catch(() => undefined); }, []);

  const online = useMemo(() => cameras.filter((c) => isOnlineStatus(c.status)), [cameras]);
  const offline = cameras.length - online.length;
  // Contagem REAL (gravação armada + online). Antes: `online × 0,4`.
  const recording = useMemo(() => cameras.filter(isRecordingArmed).length, [cameras]);
  const pinned = featuredId ? cameras.find((c) => c.id === featuredId) ?? null : null;
  const hero = pinned ?? online[0] ?? cameras[0] ?? null;
  const heroPoster = hero ? streamPosters[hero.id] : null;
  const clientName = facilityName || user?.name?.trim().split(/\s+/)[0] || 'Você';

  const pinCamera = (cam: Camera) => {
    const isPinned = featuredId === cam.id;
    Alert.alert(
      cam.name,
      isPinned ? 'Esta câmera está fixada no destaque do Início.' : 'Fixar esta câmera no destaque do Início?',
      isPinned
        ? [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Remover do destaque', style: 'destructive', onPress: () => { setFeaturedId(null); void saveFeaturedCameraId(null); } },
          ]
        : [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Fixar no destaque', onPress: () => { setFeaturedId(cam.id); void saveFeaturedCameraId(cam.id); } },
          ],
    );
  };

  const styles = makeStyles(theme);

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={styles.root}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
      >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={{ flex: 1, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button" accessibilityLabel="Abrir configurações" onPress={props.onOpenSettings}>
          <Text style={styles.greet}>{greeting()},</Text>
          <Text style={styles.client} numberOfLines={1}>{clientName}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Adicionar câmera" style={[styles.iconBtn, { backgroundColor: theme.accent }]} onPress={() => setAddCameraOpen(true)} activeOpacity={0.8}>
          <Icon name="plus" size={20} color={theme.textOnAccent} strokeWidth={2.4} />
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Alarmes" style={styles.iconBtn} onPress={onOpenAlarms} activeOpacity={0.8}>
          <Icon name="bell" size={19} color={theme.text} />
          {alarmCount > 0 ? <View style={styles.badgeDot} /> : null}
        </TouchableOpacity>
        <TouchableOpacity style={styles.avatar} hitSlop={8} accessibilityRole="button" accessibilityLabel="Configurações da conta" onPress={props.onOpenSettings}>
          <Text style={styles.avatarText}>{initials(user?.name)}</Text>
        </TouchableOpacity>
      </View>

      {/* Pílulas de status */}
      <View style={styles.pills}>
        <Pill theme={theme} color={theme.success} value={online.length} label="online" />
        <Pill theme={theme} color={theme.danger} value={recording} label="gravando" pulse />
        <Pill theme={theme} color={theme.textMuted} value={offline} label="offline" />
      </View>

      {/* Hero: câmera em destaque (long-press para fixar/soltar) */}
      {hero ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Abrir câmera ${hero.name}. ${isOnlineStatus(hero.status) ? 'Online' : 'Offline'}`}
          accessibilityHint="Toque e segure para fixar ou remover do destaque"
          style={styles.hero}
          activeOpacity={0.9}
          onPress={() => onOpenCamera(hero)}
          onLongPress={() => pinCamera(hero)}
        >
          {heroPoster ? (
            <Image source={{ uri: heroPoster }} style={styles.heroImg} resizeMode="cover" onError={() => onPosterError?.(hero.id)} />
          ) : (
            <View style={[styles.heroImg, styles.heroPlaceholder]}>
              <Icon name="camera" size={30} color={theme.textMuted} />
            </View>
          )}
          <View style={styles.heroShade} />
          <View style={{ position: 'absolute', top: 12, left: 12, flexDirection: 'row', gap: 6 }}>
            <View style={[styles.liveBadge, { position: 'relative', top: 0, left: 0 }]}>
              <View style={styles.liveDot} />
              {/* O hero cai em `cameras[0]` quando não há nenhuma online — o
                  selo "AO VIVO" fixo mentia justamente nesse caso. */}
              <Text style={styles.liveText}>{hero && isOnlineStatus(hero.status) ? 'AO VIVO' : 'OFFLINE'}</Text>
            </View>
            {pinned ? (
              <View style={styles.pinBadge}>
                <Icon name="star" size={9} color="#fff" />
                <Text style={styles.pinText}>FIXADA</Text>
              </View>
            ) : null}
          </View>
          <ClockBadge style={styles.clockBadge} textStyle={styles.clockText} />
          <View style={styles.heroFooter}>
            <View style={{ flex: 1 }}>
              <Text style={styles.heroName} numberOfLines={1}>{hero.name}</Text>
              <Text style={styles.heroArea} numberOfLines={1}>
                {(hero.group?.name ?? 'Câmera')} · {hero.detectedHeight ? `${hero.detectedHeight}p` : '1080p'}
              </Text>
            </View>
            <View style={styles.expandBtn}>
              <Icon name="expand" size={15} color="#fff" />
            </View>
          </View>
        </TouchableOpacity>
      ) : (
        <View style={styles.noCameras}>
          <View style={styles.noCamerasIcon}><Icon name="camera" size={24} color={theme.accent} /></View>
          <Text style={styles.noCamerasTitle}>Adicione sua primeira câmera</Text>
          <Text style={styles.noCamerasText}>O app procura dispositivos na rede e orienta cada etapa da instalação.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Adicionar primeira câmera"
            style={styles.noCamerasButton}
            onPress={() => setAddCameraOpen(true)}
          >
            <Icon name="plus" size={17} color={theme.textOnAccent} />
            <Text style={[styles.noCamerasButtonText, { color: theme.textOnAccent }]}>Adicionar câmera</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Suas câmeras */}
      {cameras.length ? <>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Suas câmeras</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Ver todas as câmeras" onPress={props.onOpenMosaic}><Text style={styles.link}>Ver todas</Text></TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.carousel}>
        {cameras.slice(0, 10).map((cam) => {
          const isOn = isOnlineStatus(cam.status);
          const poster = streamPosters[cam.id];
          const isPinnedCard = featuredId === cam.id;
          return (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Abrir câmera ${cam.name}. ${isOn ? 'Online' : 'Offline'}`}
              accessibilityHint="Toque e segure para fixar ou remover do destaque"
              key={cam.id}
              style={styles.card}
              activeOpacity={0.85}
              onPress={() => onOpenCamera(cam)}
              onLongPress={() => pinCamera(cam)}
            >
              <View style={styles.cardThumb}>
                {isOn && poster ? (
                  <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => onPosterError?.(cam.id)} />
                ) : (
                  <View style={[StyleSheet.absoluteFill, styles.cardThumbEmpty]}>
                    <Icon name="camera" size={16} color={theme.textMuted} />
                  </View>
                )}
                <View style={[styles.statusDot, { backgroundColor: isOn ? theme.success : theme.textMuted }]} />
                {isPinnedCard ? (
                  <View style={styles.cardPin}><Icon name="star" size={11} color="#fff" /></View>
                ) : null}
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardName} numberOfLines={1}>{cam.name}</Text>
                <Text style={styles.cardArea} numberOfLines={1}>{cam.group?.name ?? 'Câmera'}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      </> : null}

      </ScrollView>
      {/* Modal fora do ScrollView: evita que foco, gestos e botão Voltar sejam
          disputados pela página Início durante o cadastro. */}
      <AddCameraSheet
        visible={addCameraOpen}
        apiUrl={props.apiUrl}
        token={props.token}
        onClose={() => setAddCameraOpen(false)}
        onCreated={props.onCamerasChanged}
      />
    </>
  );
}

function Pill({ theme, color, value, label, pulse }: { theme: any; color: string; value: number; label: string; pulse?: boolean }) {
  return (
    <View style={[pillStyle.pill, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={[pillStyle.dot, { backgroundColor: color }]} />
      <Text style={[pillStyle.value, { color: theme.text }]}>{value}</Text>
      <Text style={[pillStyle.label, { color: theme.textSub }]}>{label}</Text>
    </View>
  );
}
const pillStyle = StyleSheet.create({
  pill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 13, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  value: { fontFamily: TITLE, fontSize: 15, fontWeight: '700' },
  label: { fontFamily: UI, fontSize: 10.5, fontWeight: '500' },
});

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 132 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 16 },
    greet: { fontFamily: UI, fontSize: 13, fontWeight: '500', color: t.textSub },
    client: { fontFamily: TITLE, fontSize: 24, fontWeight: '800', color: t.text, letterSpacing: -0.4, marginTop: 1 },
    iconBtn: { width: 42, height: 42, borderRadius: 14, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' },
    badgeDot: { position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: t.danger, borderWidth: 2, borderColor: t.surface },
    avatar: { width: 42, height: 42, borderRadius: 14, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontFamily: TITLE, fontSize: 14, fontWeight: '700', color: '#fff' },

    pills: { flexDirection: 'row', gap: 8, marginBottom: 16 },

    opBanner: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(240,163,60,0.12)', borderWidth: 1, borderColor: 'rgba(240,163,60,0.45)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 14 },
    opBannerText: { flex: 1, fontFamily: UI, fontSize: 12.5, fontWeight: '500', color: t.text, lineHeight: 17 },
    pinBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(5,8,14,0.6)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    pinText: { color: '#fff', fontFamily: UI, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
    cardPin: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(5,8,14,0.55)', alignItems: 'center', justifyContent: 'center' },

    hero: { height: 214, borderRadius: 22, overflow: 'hidden', backgroundColor: '#0B0F16' },
    heroImg: { width: '100%', height: '100%' },
    heroPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.surfaceAlt },
    heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', borderRadius: 22 },
    liveBadge: { position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(214,55,48,0.95)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
    liveText: { color: '#fff', fontFamily: UI, fontSize: 10, fontWeight: '700', letterSpacing: 0.7 },
    clockBadge: { position: 'absolute', top: 12, right: 12, backgroundColor: 'rgba(5,8,14,0.55)', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
    clockText: { color: 'rgba(255,255,255,0.92)', fontFamily: MONO, fontSize: 11, fontWeight: '500' },
    heroFooter: { position: 'absolute', left: 16, right: 16, bottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    heroName: { color: '#fff', fontFamily: TITLE, fontSize: 17, fontWeight: '700' },
    heroArea: { color: 'rgba(255,255,255,0.68)', fontFamily: UI, fontSize: 12, fontWeight: '500', marginTop: 2 },
    expandBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' },
    noCameras: { alignItems: 'center', backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 22, paddingHorizontal: 24, paddingVertical: 28 },
    noCamerasIcon: { width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accentBg, marginBottom: 13 },
    noCamerasTitle: { fontFamily: TITLE, fontSize: 17, fontWeight: '700', color: t.text, textAlign: 'center' },
    noCamerasText: { fontFamily: UI, fontSize: 13, lineHeight: 19, color: t.textSub, textAlign: 'center', marginTop: 6, maxWidth: 390 },
    noCamerasButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: t.accent, borderRadius: 13, paddingHorizontal: 18, height: 46, marginTop: 18 },
    noCamerasButtonText: { fontFamily: UI, fontSize: 14, fontWeight: '700' },

    sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, marginBottom: 12 },
    sectionTitle: { fontFamily: TITLE, fontSize: 16, fontWeight: '700', color: t.text },
    link: { fontFamily: UI, fontSize: 13, fontWeight: '600', color: t.accent },

    carousel: { gap: 11, paddingRight: 8 },
    card: { width: 150, borderRadius: 16, overflow: 'hidden', backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    cardThumb: { height: 92, backgroundColor: '#0D1118' },
    cardThumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.surfaceAlt },
    statusDot: { position: 'absolute', top: 8, left: 8, width: 8, height: 8, borderRadius: 4, borderWidth: 2, borderColor: 'rgba(5,8,14,0.5)' },
    cardBody: { padding: 11 },
    cardName: { fontFamily: UI, fontSize: 12.5, fontWeight: '600', color: t.text },
    cardArea: { fontFamily: UI, fontSize: 11, fontWeight: '500', color: t.textSub, marginTop: 2 },

    activity: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 15, padding: 10 },
    activityThumb: { width: 52, height: 40, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0D1118' },
    activityTitle: { fontFamily: UI, fontSize: 13.5, fontWeight: '600', color: t.text },
    activitySub: { fontFamily: MONO, fontSize: 11, color: t.textSub, marginTop: 2 },
    empty: { fontFamily: UI, fontSize: 13, color: t.textMuted, textAlign: 'center', paddingVertical: 20 },
  });
}
