/**
 * Câmeras (redesign) — réplica da tela "Câmeras" do mockup: busca, chips de grupo,
 * alternância Lista/Mural, favoritos. Ligada aos dados reais (mesmos props da MosaicScreen).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { LiveVideo } from '../../components/VideoPlayers';
import { CameraManagementSheet } from '../../components/CameraManagementSheet';
import { useTheme } from '../../theme/ThemeProvider';
import { useLibrary } from '../../state/LibraryProvider';
import { Icon } from '../../components/Icon';
import { isOnlineStatus } from '../../utils/camera-view';
import type { Camera } from '../../types';


const TITLE = 'Sora';
const UI = 'InstrumentSans';
const INITIAL_VISIBLE_CAMERAS = 60;

interface Props {
  cameras: Camera[];
  streamPosters: Record<string, string | null>;
  streamUrls: Record<string, string | null>;
  streamWhep: Record<string, string | null>;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenCamera: (camera: Camera) => void;
  /** Pede as URLs de stream (modo grade) das câmeras que vão tocar ao vivo. */
  onRequestStreams: (cameraIds: string[]) => void;
  onRefreshStream: (cameraId: string) => void;
  apiUrl: string;
  token: string | null;
  onCamerasChanged: () => void;
}

export function CamerasRedesign({ cameras, streamPosters, streamUrls, streamWhep, refreshing, onRefresh, onOpenCamera, onRequestStreams, onRefreshStream, apiUrl, token, onCamerasChanged }: Props) {
  const { theme } = useTheme();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Todas');
  const [view, setView] = useState<'list' | 'mosaic'>('list');
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_CAMERAS);
  const [managedCamera, setManagedCamera] = useState<Camera | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  // ── UMA FONTE DE FAVORITAS ───────────────────────────────────────────────
  // Esta tela mantinha a própria lista em `@drac:cam-favs:v1`, GLOBAL — sem
  // escopo de usuário nem de servidor. Dois operadores no mesmo aparelho
  // compartilhavam favoritas, e a estrela marcada aqui não existia na Home nem
  // no app clássico, que usam o LibraryProvider (escopado por sessão).
  const { favorites: favs, toggleFavorite: toggleFav } = useLibrary();
  const s = makeStyles(theme, windowWidth);

  const groups = useMemo(() => {
    const names = new Set<string>();
    cameras.forEach((c) => c.group?.name && names.add(c.group.name));
    return ['Todas', ...Array.from(names)];
  }, [cameras]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = cameras.filter((c) => {
      const okGroup = group === 'Todas' || c.group?.name === group;
      const okQuery = !q || c.name.toLowerCase().includes(q);
      return okGroup && okQuery;
    });
    // favoritas primeiro
    list = [...list].sort((a, b) => Number(favs.includes(b.id)) - Number(favs.includes(a.id)));
    return list;
  }, [cameras, query, group, favs]);

  const onlineCount = cameras.filter((c) => isOnlineStatus(c.status)).length;
  const visibleCameras = filtered.slice(0, visibleLimit);

  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_CAMERAS);
  }, [query, group, view]);

  // Mural AO VIVO: as 4 primeiras ONLINE (na ordem filtrada, favoritas primeiro)
  // tocam vídeo de verdade (paths de grade, 720p); as demais ficam com poster —
  // mesmo limite do mosaico antigo, para não saturar rede/decoder do aparelho.
  const liveIds = useMemo(
    () => (view === 'mosaic' ? filtered.filter((c) => isOnlineStatus(c.status)).slice(0, 4).map((c) => c.id) : []),
    [view, filtered],
  );
  useEffect(() => {
    if (liveIds.length) onRequestStreams(liveIds);
  }, [liveIds.join('|')]);

  const managementChanged = (cameraId: string, action: 'updated' | 'deleted') => {
    if (action === 'deleted' && favs.includes(cameraId)) toggleFav(cameraId);
    setManagedCamera(null);
    onCamerasChanged();
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        key={view}
        data={visibleCameras}
        keyExtractor={cam => cam.id}
        numColumns={view === 'mosaic' ? 2 : 1}
        columnWrapperStyle={view === 'mosaic' ? { gap: 11 } : undefined}
        initialNumToRender={10}
        windowSize={7}
        removeClippedSubviews={false}
        contentContainerStyle={s.root}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        ListHeaderComponent={<>
        {/* Header */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Câmeras</Text>
            <Text style={s.subtitle}>{onlineCount} de {cameras.length} online</Text>
          </View>
          <View style={s.toggle}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Visualização em lista" accessibilityState={{ selected: view === 'list' }} style={[s.toggleBtn, view === 'list' && s.toggleOn]} onPress={() => setView('list')}>
              <Icon name="server" size={17} color={view === 'list' ? '#fff' : theme.textSub} />
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Visualização em mosaico" accessibilityState={{ selected: view === 'mosaic' }} style={[s.toggleBtn, view === 'mosaic' && s.toggleOn]} onPress={() => setView('mosaic')}>
              <Icon name="grid" size={17} color={view === 'mosaic' ? '#fff' : theme.textSub} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Busca */}
        <View style={s.search}>
          <Icon name="aperture" size={17} color={theme.textMuted} />
          <TextInput
            style={s.searchInput}
            placeholder="Buscar câmera…"
            placeholderTextColor={theme.textMuted}
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Buscar câmera"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Limpar busca" onPress={() => setQuery('')}><Icon name="close" size={16} color={theme.textMuted} /></TouchableOpacity>
          ) : null}
        </View>

        {/* Chips de grupo */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {groups.map((g) => {
            const on = group === g;
            const count = g === 'Todas' ? cameras.length : cameras.filter((c) => c.group?.name === g).length;
            return (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Filtrar pelo grupo ${g}`} accessibilityState={{ selected: on }} key={g} style={[s.chip, on && s.chipOn]} onPress={() => setGroup(g)} activeOpacity={0.8}>
                <Text style={[s.chipText, { color: on ? '#fff' : theme.textSub }]}>{g}</Text>
                <View style={[s.chipCount, on && { backgroundColor: 'rgba(255,255,255,0.25)' }]}>
                  <Text style={[s.chipCountText, { color: on ? '#fff' : theme.textSub }]}>{count}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        </>}
        renderItem={({ item: cam }) => <View style={{ marginTop: 11 }}>
          {view === 'list' ? (
            <ListRow cam={cam} poster={streamPosters[cam.id]} theme={theme} s={s} fav={favs.includes(cam.id)} onToggleFav={() => toggleFav(cam.id)} onOpen={() => onOpenCamera(cam)} onManage={() => setManagedCamera(cam)} />
          ) : (
              <MosaicTile
                key={cam.id}
                cam={cam}
                poster={streamPosters[cam.id]}
                live={liveIds.includes(cam.id)}
                hlsUrl={streamUrls[cam.id] ?? null}
                whepUrl={streamWhep[cam.id] ?? null}
                onRefreshStream={() => onRefreshStream(cam.id)}
                theme={theme} s={s}
                fav={favs.includes(cam.id)} onToggleFav={() => toggleFav(cam.id)} onOpen={() => onOpenCamera(cam)} onManage={() => setManagedCamera(cam)}
              />
          )}
        </View>}
        ListFooterComponent={<>
        {visibleCameras.length < filtered.length ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Mostrar mais câmeras"
            style={s.loadMore}
            onPress={() => setVisibleLimit((current) => current + INITIAL_VISIBLE_CAMERAS)}
          >
            <Text style={s.loadMoreText}>Mostrar mais {Math.min(INITIAL_VISIBLE_CAMERAS, filtered.length - visibleCameras.length)} câmeras</Text>
          </TouchableOpacity>
        ) : null}
        {filtered.length === 0 ? <Text style={s.empty}>Nenhuma câmera encontrada.</Text> : null}
        </>}
      />
      <CameraManagementSheet
        visible={Boolean(managedCamera)}
        camera={managedCamera}
        apiUrl={apiUrl}
        token={token}
        onClose={() => setManagedCamera(null)}
        onChanged={managementChanged}
      />
    </View>
  );
}

function ListRow({ cam, poster, theme, s, fav, onToggleFav, onOpen, onManage }: any) {
  const isOn = isOnlineStatus(cam.status);
  const res = cam.detectedHeight ? `${cam.detectedHeight}p` : null;
  const fps = cam.detectedFps ? `${Math.round(cam.detectedFps)} fps` : null;
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Abrir câmera ${cam.name}. ${isOn ? 'Online' : 'Offline'}`} style={s.row} activeOpacity={0.85} onPress={onOpen}>
      <View style={s.rowThumb}>
        {isOn && poster ? (
          <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, s.thumbEmpty]}><Icon name="camera" size={16} color={theme.textMuted} /></View>
        )}
        {isOn ? (
          <View style={s.liveBadgeSm}><View style={s.liveDotSm} /><Text style={s.liveTextSm}>AO VIVO</Text></View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {fav ? <Icon name="star" size={13} color={theme.warning} /> : null}
          <Text style={s.rowName} numberOfLines={1}>{cam.name}</Text>
        </View>
        <Text style={s.rowSub} numberOfLines={1}>{cam.group?.name ?? 'Câmera'}</Text>
        <View style={s.metaRow}>
          <View style={[s.metaChip, { backgroundColor: isOn ? 'rgba(51,196,129,0.14)' : t2(theme) }]}>
            <View style={[s.metaDot, { backgroundColor: isOn ? theme.success : theme.textMuted }]} />
            <Text style={[s.metaText, { color: isOn ? theme.success : theme.textMuted }]}>{isOn ? 'Online' : 'Offline'}</Text>
          </View>
          {res ? <View style={[s.metaChip, { backgroundColor: t2(theme) }]}><Text style={[s.metaText, { color: theme.textSub }]}>{res}</Text></View> : null}
          {fps ? <View style={[s.metaChip, { backgroundColor: t2(theme) }]}><Text style={[s.metaText, { color: theme.textSub }]}>{fps}</Text></View> : null}
        </View>
      </View>
      <View style={{ alignItems: 'center', gap: 10 }}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={fav ? `Remover ${cam.name} dos favoritos` : `Favoritar ${cam.name}`} accessibilityState={{ selected: fav }} onPress={(event) => { event.stopPropagation(); onToggleFav(); }} hitSlop={10}>
          <Icon name="star" size={20} color={fav ? theme.warning : theme.textMuted} />
        </TouchableOpacity>
        {cam.canSelfManage ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Editar ou excluir ${cam.name}`} onPress={(event) => { event.stopPropagation(); onManage(); }} hitSlop={10}><Icon name="edit" size={19} color={theme.accent} /></TouchableOpacity> : <Icon name="forward" size={15} color={theme.textMuted} />}
      </View>
    </TouchableOpacity>
  );
}

/** Fundo sutil dos chips de meta (surfaceAlt do tema). */
function t2(theme: any): string {
  return theme.surfaceAlt;
}

function MosaicTile({ cam, poster, live, hlsUrl, whepUrl, onRefreshStream, theme, s, fav, onToggleFav, onOpen, onManage }: any) {
  const isOn = isOnlineStatus(cam.status);
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Abrir câmera ${cam.name}. ${isOn ? 'Online' : 'Offline'}`} style={s.tile} activeOpacity={0.85} onPress={onOpen}>
      {live && (hlsUrl || whepUrl) ? (
        <LiveVideo
          uri={hlsUrl}
          whepUri={whepUrl}
          posterUri={poster}
          // flex:1 (NÃO absoluteFill): o wrapper interno do player força
          // position:relative e os offsets do absoluteFill são ignorados → o
          // container colapsa p/ altura 0 e o vídeo não renderiza ("No surface").
          videoStyle={s.tileVideo}
          muted
          contentFit="cover"
          emptyStyle={[StyleSheet.absoluteFill, s.thumbEmpty]}
          posterStyle={StyleSheet.absoluteFill}
          emptyTitleStyle={s.tileName}
          emptyTextStyle={s.tileArea}
          onNeedRefresh={onRefreshStream}
        />
      ) : isOn && poster ? (
        <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.thumbEmpty]}><Icon name="camera" size={18} color={theme.textMuted} /></View>
      )}
      <View style={s.tileShade} />
      {isOn ? <View style={[s.liveBadgeSm, { top: 8, left: 8 }]}><View style={s.liveDotSm} /><Text style={s.liveTextSm}>AO VIVO</Text></View> : null}
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={fav ? `Remover ${cam.name} dos favoritos` : `Favoritar ${cam.name}`} accessibilityState={{ selected: fav }} style={s.tileStar} onPress={(event) => { event.stopPropagation(); onToggleFav(); }} hitSlop={8}>
        <Icon name="star" size={16} color={fav ? theme.warning : '#fff'} />
      </TouchableOpacity>
      {cam.canSelfManage ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Editar ou excluir ${cam.name}`} style={s.tileEdit} onPress={(event) => { event.stopPropagation(); onManage(); }} hitSlop={8}><Icon name="edit" size={15} color="#fff" /></TouchableOpacity> : null}
      <View style={s.tileFooter}>
        <View style={{ flex: 1 }}>
          <Text style={s.tileName} numberOfLines={1}>{cam.name}</Text>
          <Text style={s.tileArea} numberOfLines={1}>
            {(cam.group?.name ?? 'Câmera')}{cam.detectedHeight ? ` · ${cam.detectedHeight}p` : ''}
          </Text>
        </View>
        <View style={[s.tileStatus, { backgroundColor: isOn ? theme.success : theme.textMuted }]} />
      </View>
    </TouchableOpacity>
  );
}

function makeStyles(t: any, windowWidth: number) {
  const contentWidth = Math.min(windowWidth, 900) - 40;
  const columns = windowWidth >= 700 ? 3 : 2;
  const gap = 11;
  const tileWidth = (contentWidth - (columns - 1) * gap) / columns;
  return StyleSheet.create({
    root: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 132 },
    header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
    title: { fontFamily: TITLE, fontSize: 26, fontWeight: '800', color: t.text, letterSpacing: -0.5 },
    subtitle: { fontFamily: UI, fontSize: 13, color: t.textSub, marginTop: 2 },
    toggle: { flexDirection: 'row', backgroundColor: t.surfaceAlt, borderRadius: 12, padding: 4, gap: 2 },
    toggleBtn: { width: 40, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
    toggleOn: { backgroundColor: t.accent },

    search: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 14, paddingHorizontal: 14, height: 48 },
    searchInput: { flex: 1, fontFamily: UI, fontSize: 15, color: t.text, padding: 0 },

    chips: { gap: 8, marginTop: 14, paddingRight: 8 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 999, paddingHorizontal: 14, height: 38 },
    chipOn: { backgroundColor: t.accent, borderColor: t.accent },
    chipText: { fontFamily: UI, fontSize: 13, fontWeight: '600' },
    chipCount: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
    chipCountText: { fontFamily: UI, fontSize: 11, fontWeight: '700' },

    row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 10 },
    rowThumb: { width: 116, height: 82, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0D1118' },
    thumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: t.surfaceAlt },
    rowName: { fontFamily: UI, fontSize: 15, fontWeight: '600', color: t.text, flexShrink: 1 },
    rowSub: { fontFamily: UI, fontSize: 12, color: t.textSub, marginTop: 2 },
    metaRow: { flexDirection: 'row', gap: 6, marginTop: 7, flexWrap: 'wrap' },
    metaChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3.5 },
    metaDot: { width: 5, height: 5, borderRadius: 3 },
    metaText: { fontFamily: UI, fontSize: 10.5, fontWeight: '600' },
    liveBadgeSm: { position: 'absolute', top: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(214,55,48,0.95)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
    liveDotSm: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#fff' },
    liveTextSm: { color: '#fff', fontFamily: UI, fontSize: 8, fontWeight: '700', letterSpacing: 0.5 },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 11, marginTop: 14 },
    // Altura EXPLÍCITA (≈16:11 da meia-largura): aspectRatio com largura em % não
    // resolve dentro deste ScrollView (tiles ficavam com altura 0 e o mural vazio).
    tile: { width: tileWidth, height: Math.round(tileWidth * (11 / 16)), borderRadius: 16, overflow: 'hidden', backgroundColor: '#0D1118' },
    // Sombra de legibilidade na base (antes era transparente e o nome sumia na imagem).
    tileVideo: { flex: 1, backgroundColor: '#000' },
    tileShade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', backgroundColor: 'rgba(4,7,13,0.02)', borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    tileStar: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(5,8,14,0.4)', alignItems: 'center', justifyContent: 'center' },
    tileEdit: { position: 'absolute', top: 8, right: 42, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(5,8,14,0.55)', alignItems: 'center', justifyContent: 'center' },
    tileFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 10, paddingBottom: 8, paddingTop: 18, backgroundColor: 'rgba(4,7,13,0.55)' },
    tileName: { color: '#fff', fontFamily: UI, fontSize: 12.5, fontWeight: '700' },
    tileArea: { color: 'rgba(255,255,255,0.72)', fontFamily: UI, fontSize: 10.5, marginTop: 1 },
    tileStatus: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },

    empty: { fontFamily: UI, fontSize: 14, color: t.textMuted, textAlign: 'center', paddingVertical: 30 },
    loadMore: { minHeight: 46, marginTop: 16, borderRadius: 14, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' },
    loadMoreText: { fontFamily: UI, fontSize: 13.5, fontWeight: '700', color: t.accent },
  });
}
