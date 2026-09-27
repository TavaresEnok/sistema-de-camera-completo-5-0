import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Camera as CameraIcon, Check, Crosshair, ExternalLink, Filter, Layers3, Map, MapPin, Pencil, Search, ShieldCheck, Upload, Video, X } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { LiveStreamPlayer } from '../components/LiveStreamPlayer';
import { GeographicCameraMap } from '../components/GeographicCameraMap';
import { CameraLocationDialog, type CameraMapPosition } from '../components/CameraLocationDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore, type Camera } from '../store/vmsDataStore';
import { getApiBaseUrl } from '../lib/api-base';

type Site = { id: string; name: string; location?: string | null; isActive: boolean };
type Marker = { xPct: number; yPct: number; zoneId?: string };
type Layout = { id: string; siteId: string; floor: string; svgDataUrl?: string | null; markers: Record<string, Marker> };
type PosterTokenItem = { cameraId: string; streamToken: string; posterUrl: string };
const EMPTY_MARKERS: Record<string, Marker> = {};

const STATUS_FILTERS = ['all', 'online', 'recording', 'motion', 'alarm', 'offline', 'no_signal', 'maintenance'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'Todos',
  online: 'Online',
  recording: 'Gravando',
  motion: 'Movimento',
  alarm: 'Alarme',
  offline: 'Offline',
  no_signal: 'Sem sinal',
  maintenance: 'Manutenção',
};

const API_URL = getApiBaseUrl();

function api(token?: string | null) {
  return axios.create({ baseURL: API_URL, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
}

function statusLabel(camera: Camera) {
  if (!camera.enabled) return 'Desativada';
  return camera.isOnline ? 'Online' : 'Offline';
}

export default function MapPage() {
  const token = useAuthStore((state) => state.accessToken);
  const role = useAuthStore((state) => state.user?.role ?? 'viewer');
  const cameras = useVmsDataStore((state) => state.cameras);
  const loadData = useVmsDataStore((state) => state.load);
  const [, setLocation] = useLocation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [siteId, setSiteId] = useState('');
  const [floor, setFloor] = useState('');
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('camera'));
  const [editing, setEditing] = useState(false);
  const [placingId, setPlacingId] = useState('');
  const [draftMarkers, setDraftMarkers] = useState<Record<string, Marker>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'geographic' | 'floorplan'>('geographic');
  const [autoLocating, setAutoLocating] = useState(false);
  const [autoLocationDone, setAutoLocationDone] = useState(false);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('__all__');
  const [zoneFilter, setZoneFilter] = useState('__all__');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sidebarPosterUrls, setSidebarPosterUrls] = useState<Record<string, string>>({});
  const lastSidebarPosterRetryAtRef = useRef(0);
  const [locationCameraId, setLocationCameraId] = useState<string | null>(null);
  const [pickingLocation, setPickingLocation] = useState(false);
  const [pickedPosition, setPickedPosition] = useState<CameraMapPosition | null>(null);

  const accessibleSiteIds = useMemo(() => new Set(cameras.map((c) => c.siteId).filter(Boolean)), [cameras]);
  const visibleSites = useMemo(
    () => sites.filter((site) => role === 'admin' || accessibleSiteIds.has(site.id)),
    [accessibleSiteIds, role, sites],
  );
  const currentLayouts = layouts.filter((layout) => layout.siteId === siteId);
  const activeLayout = currentLayouts.find((layout) => layout.floor === floor) ?? currentLayouts[0] ?? null;
  const currentMarkers = editing ? draftMarkers : (activeLayout?.markers ?? EMPTY_MARKERS);
  const siteCameras = useMemo(
    () => cameras.filter((camera) => camera.siteId === siteId && camera.enabled),
    [cameras, siteId],
  );
  const mappedCameras = useMemo(
    () => siteCameras.filter((camera) => currentMarkers[camera.id]),
    [currentMarkers, siteCameras],
  );
  const unmappedCameras = useMemo(
    () => siteCameras.filter((camera) => !currentMarkers[camera.id]),
    [currentMarkers, siteCameras],
  );
  const selected = cameras.find((camera) => camera.id === selectedId) ?? null;
  const locationCamera = cameras.find((camera) => camera.id === locationCameraId) ?? null;
  const panelCameras = useMemo(
    () => mode === 'geographic'
      ? cameras.filter((camera) => camera.enabled)
      : [...mappedCameras, ...unmappedCameras],
    [cameras, mappedCameras, mode, unmappedCameras],
  );
  const zoneFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(panelCameras.map((camera) => camera.zone)))],
    [panelCameras],
  );
  const groupFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(panelCameras.map((camera) => camera.floor).filter((group) => group && group !== '-')))],
    [panelCameras],
  );
  const filteredPanelCameras = useMemo(() => {
    const query = search.trim().toLowerCase();
    return panelCameras.filter((camera) => {
      const matchesSearch = !query
        || camera.name.toLowerCase().includes(query)
        || camera.code.toLowerCase().includes(query)
        || camera.ipAddress.includes(query)
        || (camera.locationAddress ?? '').toLowerCase().includes(query);
      const matchesZone = zoneFilter === '__all__' || camera.zone === zoneFilter;
      const matchesGroup = groupFilter === '__all__' || camera.floor === groupFilter;
      const matchesStatus = statusFilter === 'all' || camera.status === statusFilter;
      return matchesSearch && matchesGroup && matchesZone && matchesStatus;
    });
  }, [groupFilter, panelCameras, search, statusFilter, zoneFilter]);
  const posterCameraIdsKey = useMemo(
    () => panelCameras
      .filter((camera) => camera.canViewContent !== false)
      .map((camera) => camera.id)
      .sort()
      .join(','),
    [panelCameras],
  );

  const loadSidebarPosters = useCallback(async () => {
    if (!token) return;
    const cameraIds = panelCameras
      .filter((camera) => camera.canViewContent !== false)
      .map((camera) => camera.id);
    if (!cameraIds.length) {
      setSidebarPosterUrls({});
      return;
    }
    try {
      const { data } = await api(token).post<{ items: PosterTokenItem[] }>(
        '/camera-stream/poster-tokens',
        { cameraIds },
      );
      const version = Date.now();
      const next: Record<string, string> = {};
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const separator = item.posterUrl.includes('?') ? '&' : '?';
        next[item.cameraId] = `${item.posterUrl}${separator}token=${encodeURIComponent(item.streamToken)}&v=${version}`;
      }
      setSidebarPosterUrls(next);
    } catch {
      // Preserva o último snapshot válido durante uma oscilação da API/câmera.
    }
  }, [panelCameras, token]);

  useEffect(() => {
    // O painel só existe visualmente no desktop largo; não emite tokens nem
    // baixa snapshots quando o CSS mantém a lateral escondida.
    const desktop = window.matchMedia('(min-width: 1280px)');
    if (!desktop.matches) return;
    void loadSidebarPosters();
    const renew = () => {
      if (document.visibilityState === 'visible') void loadSidebarPosters();
    };
    const timer = window.setInterval(renew, 4 * 60 * 1000);
    window.addEventListener('focus', renew);
    document.addEventListener('visibilitychange', renew);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', renew);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [loadSidebarPosters, posterCameraIdsKey]);

  const retrySidebarPoster = useCallback((cameraId: string) => {
    setSidebarPosterUrls((current) => {
      if (!current[cameraId]) return current;
      const next = { ...current };
      delete next[cameraId];
      return next;
    });
    const now = Date.now();
    if (now - lastSidebarPosterRetryAtRef.current < 5_000) return;
    lastSidebarPosterRetryAtRef.current = now;
    void loadSidebarPosters();
  }, [loadSidebarPosters]);

  useEffect(() => {
    if (!token) return;
    void api(token).get<Site[]>('/sites').then(({ data }) => setSites(data)).catch(() => setError('Não foi possível carregar as unidades.'));
  }, [token]);

  const discoverLocations = async () => {
    if (!token || role !== 'admin' || autoLocating) return;
    setAutoLocating(true);
    try {
      await api(token).post('/cameras/location/auto-discover');
      await loadData();
      setAutoLocationDone(true);
    } catch {
      setError('Não foi possível estimar a localização das câmeras agora. Você ainda pode informar o endereço manualmente.');
    } finally { setAutoLocating(false); }
  };

  useEffect(() => {
    if (role !== 'admin' || !token || !cameras.length || autoLocationDone || autoLocating) return;
    if (cameras.some((camera) => camera.enabled && (camera.latitude == null || camera.longitude == null))) {
      void discoverLocations();
    }
  }, [cameras.length, role, token, autoLocationDone, autoLocating]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visibleSites.length) return;
    if (!visibleSites.some((site) => site.id === siteId)) setSiteId(visibleSites[0].id);
  }, [siteId, visibleSites]);

  useEffect(() => {
    if (!token || !siteId) return;
    setError('');
    void api(token).get<Layout[]>(`/sites/${encodeURIComponent(siteId)}/map-layouts`)
      .then(({ data }) => {
        setLayouts((all) => [...all.filter((layout) => layout.siteId !== siteId), ...data]);
        setFloor((current) => data.some((layout) => layout.floor === current) ? current : (data[0]?.floor ?? 'Principal'));
      })
      .catch(() => setError('Não foi possível carregar a planta desta unidade.'));
  }, [siteId, token]);

  useEffect(() => {
    if (!editing) setDraftMarkers(activeLayout?.markers ?? {});
  }, [activeLayout, editing]);

  const openCamera = (camera: Camera) => {
    setSelectedId(camera.id);
    setLocation(`/map?camera=${encodeURIComponent(camera.id)}`, { replace: true });
  };
  const closeCamera = () => {
    setSelectedId(null);
    setLocation('/map', { replace: true });
  };
  const editCameraLocation = (camera: Camera) => {
    setLocationCameraId(camera.id);
    setPickedPosition(null);
    setPickingLocation(false);
  };

  const placeMarker = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!editing || !placingId || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    setDraftMarkers((markers) => ({
      ...markers,
      [placingId]: {
        xPct: Math.max(1, Math.min(99, ((event.clientX - rect.left) / rect.width) * 100)),
        yPct: Math.max(1, Math.min(99, ((event.clientY - rect.top) / rect.height) * 100)),
      },
    }));
    setPlacingId('');
  };

  const saveLayout = async (svgDataUrl = activeLayout?.svgDataUrl ?? null) => {
    if (!token || !siteId || !floor.trim()) return;
    setSaving(true); setError('');
    try {
      const { data } = await api(token).put<Layout>(`/sites/${encodeURIComponent(siteId)}/map-layouts/${encodeURIComponent(floor.trim())}`, {
        svgDataUrl,
        markers: draftMarkers,
      });
      setLayouts((all) => [...all.filter((layout) => !(layout.siteId === data.siteId && layout.floor === data.floor)), data]);
      setEditing(false);
    } catch {
      setError('Não foi possível salvar o mapa. Verifique a imagem e tente novamente.');
    } finally { setSaving(false); }
  };

  const uploadSvg = (file?: File) => {
    if (!file) return;
    if (file.type !== 'image/svg+xml' && !file.name.toLowerCase().endsWith('.svg')) {
      setError('A planta deve estar em SVG.'); return;
    }
    const reader = new FileReader();
    reader.onload = () => void saveLayout(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
      <section className="flex min-w-0 flex-1 flex-col p-4 lg:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="mr-auto">
            <div className="flex items-center gap-2 text-sm font-semibold"><Map className="h-4 w-4 text-primary" /> Mapa operacional</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">Selecione um ponto para abrir a câmera · Verifique a localização das câmeras.</div>
          </div>
          <div className="flex h-9 items-center rounded-md border border-border bg-card p-1 text-xs">
            <button type="button" onClick={() => setMode('geographic')} className={`h-7 rounded px-3 ${mode === 'geographic' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>Mapa</button>
            <button type="button" onClick={() => setMode('floorplan')} className={`h-7 rounded px-3 ${mode === 'floorplan' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>Planta</button>
          </div>
          {mode === 'geographic' && role === 'admin' && cameras.some((camera) => camera.latitude == null || camera.longitude == null) && <button type="button" disabled={autoLocating} onClick={() => void discoverLocations()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs hover:bg-accent disabled:opacity-50"><MapPin className="h-3.5 w-3.5" />{autoLocating ? 'Localizando…' : 'Tentar localizar'}</button>}
          {mode === 'floorplan' && <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className="h-9 rounded-md border border-border bg-card px-3 text-xs">
            {visibleSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>}
          {mode === 'floorplan' && <select value={floor} onChange={(e) => setFloor(e.target.value)} className="h-9 rounded-md border border-border bg-card px-3 text-xs">
            {(currentLayouts.length ? currentLayouts : [{ floor: 'Principal' }]).map((layout) => <option key={layout.floor} value={layout.floor}>{layout.floor}</option>)}
          </select>}
          {mode === 'floorplan' && role === 'admin' && (
            <button type="button" onClick={() => { setDraftMarkers(activeLayout?.markers ?? {}); setEditing((value) => !value); }} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs hover:bg-accent">
              {editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}{editing ? 'Cancelar edição' : 'Organizar mapa'}
            </button>
          )}
        </div>

        {error && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

        {mode === 'floorplan' && editing && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 p-2.5">
            <span className="px-1 text-xs text-muted-foreground">Escolha a câmera e clique no ponto da planta:</span>
            <select value={placingId} onChange={(e) => setPlacingId(e.target.value)} className="h-8 min-w-48 rounded border border-border bg-card px-2 text-xs">
              <option value="">Selecionar câmera…</option>
              {siteCameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
            </select>
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded border border-border bg-card px-2.5 text-xs hover:bg-accent">
              <Upload className="h-3.5 w-3.5" /> Enviar planta SVG<input type="file" accept="image/svg+xml,.svg" className="hidden" onChange={(e) => uploadSvg(e.target.files?.[0])} />
            </label>
            <button type="button" disabled={saving} onClick={() => void saveLayout()} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"><Check className="h-3.5 w-3.5" />{saving ? 'Salvando…' : 'Salvar posições'}</button>
          </div>
        )}

        {mode === 'geographic' ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              <GeographicCameraMap
                cameras={cameras.filter((camera) => camera.enabled)}
                onOpen={openCamera}
                pickMode={pickingLocation}
                onPickPosition={(position) => {
                  setPickedPosition(position);
                  setPickingLocation(false);
                }}
              />
              {pickingLocation && (
                <div className="absolute left-1/2 top-3 z-[900] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-primary/35 bg-card/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
                  <Crosshair className="h-4 w-4 text-primary" />
                  <span>Clique no local exato da câmera.</span>
                  <button type="button" onClick={() => setPickingLocation(false)} className="rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">Cancelar</button>
                </div>
              )}
            </div>
          </div>
        ) : <div ref={stageRef} onClick={placeMarker} className={`relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card ${editing && placingId ? 'cursor-crosshair' : ''}`}>
          {activeLayout?.svgDataUrl ? (
            <img src={activeLayout.svgDataUrl} alt={`Planta ${floor}`} className="absolute inset-0 h-full w-full object-fill opacity-80" />
          ) : (
            <div className="absolute inset-0 opacity-60" style={{ backgroundImage: 'linear-gradient(hsl(var(--border)/.45) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/.45) 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
          )}
          {!activeLayout?.svgDataUrl && <div className="absolute left-5 top-5 rounded-lg border border-border bg-card/90 px-3 py-2 backdrop-blur"><div className="text-xs font-medium">{visibleSites.find((site) => site.id === siteId)?.name ?? 'Unidade'}</div><div className="text-[10px] text-muted-foreground">Envie uma planta SVG ou use o mapa esquemático.</div></div>}
          {mappedCameras.map((camera) => {
            const marker = currentMarkers[camera.id];
            return <button key={camera.id} type="button" onClick={(e) => { e.stopPropagation(); editing ? setPlacingId(camera.id) : openCamera(camera); }} style={{ left: `${marker.xPct}%`, top: `${marker.yPct}%` }} className="group absolute z-10 -translate-x-1/2 -translate-y-1/2" title={camera.name}>
              <span className={`flex h-9 w-9 items-center justify-center rounded-full border-2 bg-card shadow-lg transition-transform group-hover:scale-110 ${camera.isOnline ? 'border-emerald-500 text-emerald-500' : 'border-muted-foreground text-muted-foreground'}`}><CameraIcon className="h-4 w-4" /></span>
              <span className="absolute left-1/2 top-10 max-w-40 -translate-x-1/2 whitespace-nowrap rounded bg-background/90 px-2 py-1 text-[10px] font-medium shadow-sm backdrop-blur">{camera.name}</span>
            </button>;
          })}
          {!mappedCameras.length && <div className="absolute inset-0 flex items-center justify-center"><div className="max-w-sm rounded-xl border border-border bg-card/95 p-5 text-center shadow-lg"><Layers3 className="mx-auto h-7 w-7 text-muted-foreground" /><div className="mt-3 text-sm font-medium">Nenhuma câmera nesta planta</div><div className="mt-1 text-xs text-muted-foreground">{siteCameras.length ? 'Use “Organizar mapa” para posicionar as câmeras desta unidade.' : 'A planta é opcional. Use o Mapa para visualizar todas as câmeras cadastradas.'}</div></div></div>}
        </div>}
      </section>

      <aside className="hidden w-56 shrink-0 flex-col overflow-hidden border-l border-border bg-card xl:flex">
        <div className="shrink-0 space-y-2.5 border-b border-border px-2 py-2.5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[12px] font-semibold">Câmeras</h2>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {mode === 'geographic' ? 'Abrir no mapa' : 'Câmeras da unidade'}
              </p>
            </div>
            <ShieldCheck className="h-4 w-4 text-[hsl(var(--status-online))]" />
          </div>

          <div className="input-wrap">
            <span className="input-icon"><Search className="h-3 w-3" /></span>
            <input
              className="input"
              style={{ height: 30, fontSize: 11 }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar câmera..."
              aria-label="Buscar câmera no mapa"
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger className="col-span-2 h-8 min-w-0 px-2 text-[10px]">
                <Filter className="mr-1.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Todos os grupos" />
              </SelectTrigger>
              <SelectContent>
                {groupFilters.map((group) => (
                  <SelectItem key={group} value={group} className="text-xs">{group === '__all__' ? 'Todos os grupos' : group}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={zoneFilter} onValueChange={setZoneFilter}>
              <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]">
                <Filter className="mr-1.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zoneFilters.map((zone) => (
                  <SelectItem key={zone} value={zone} className="text-xs">
                    {zone === '__all__' ? 'Todas as zonas' : zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
              <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((status) => (
                  <SelectItem key={status} value={status} className="text-xs">
                    {STATUS_FILTER_LABEL[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 divide-y divide-border/80 overflow-y-auto">
          {filteredPanelCameras.map((camera) => {
            const statusClass = camera.status === 'alarm'
              ? 'status-alarm rec-pulse'
              : camera.status === 'motion'
                ? 'status-motion'
                : camera.isOnline ? 'status-online' : 'status-offline';
            const positionedInView = mode === 'geographic'
              ? camera.latitude != null && camera.longitude != null
              : Boolean(currentMarkers[camera.id]);
            return (
              <div key={camera.id} className={`group flex items-center transition-colors hover:bg-[hsl(var(--accent)_/_0.7)] ${selectedId === camera.id ? 'bg-[hsl(var(--primary)_/_0.06)]' : ''}`}>
                <button
                  type="button"
                  className="grid min-w-0 flex-1 grid-cols-[56px_1fr_auto] items-center gap-2 px-2 py-1.5 text-left"
                  onClick={() => mode === 'floorplan' && editing && !positionedInView
                    ? setPlacingId(camera.id)
                    : openCamera(camera)}
                  title={`Abrir ${camera.name}`}
                >
                <span className="relative block h-9 w-14 overflow-hidden rounded border border-white/10 bg-black">
                  {sidebarPosterUrls[camera.id] ? (
                    <img
                      src={sidebarPosterUrls[camera.id]}
                      alt=""
                      loading="lazy"
                      onError={() => retrySidebarPoster(camera.id)}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <Video className="absolute inset-0 m-auto h-3.5 w-3.5 text-white/25" aria-hidden="true" />
                  )}
                  <span className={`absolute bottom-1 left-1 h-2 w-2 rounded-full ring-2 ring-black/70 ${statusClass}`} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium">{camera.name}</span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {camera.code !== camera.name
                      ? camera.code
                      : camera.locationAddress || (mode === 'geographic' ? 'Definir endereço' : `${camera.zone} · ${camera.ipAddress}`)}
                  </span>
                </span>
                <span className={`max-w-[42px] shrink-0 truncate text-[9px] ${positionedInView ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground)_/_0.55)]'}`}>
                  {mode === 'floorplan' && editing && !positionedInView
                    ? 'Posicionar'
                    : STATUS_FILTER_LABEL[camera.status as StatusFilter] ?? camera.status.replace('_', ' ')}
                </span>
                </button>
                {role === 'admin' && mode === 'geographic' && (
                  <button
                    type="button"
                    onClick={() => editCameraLocation(camera)}
                    className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-primary"
                    aria-label={`Editar localização de ${camera.name}`}
                    title="Editar localização no mapa"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border px-2.5 py-2">
          <span className="text-[10px] text-muted-foreground">{filteredPanelCameras.length} câmeras</span>
          <span className="text-[10px] text-muted-foreground">
            {mode === 'geographic'
              ? `${panelCameras.filter((camera) => camera.latitude != null && camera.longitude != null).length} no mapa`
              : `${mappedCameras.length} na planta`}
          </span>
        </div>
      </aside>

      {selected && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/45 p-4 backdrop-blur-[2px]" onClick={closeCamera}>
          <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-border px-4 py-3"><span className={`h-2.5 w-2.5 rounded-full ${selected.isOnline ? 'bg-emerald-500' : 'bg-muted-foreground'}`} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{selected.name}</div><div className="text-[10px] text-muted-foreground">{selected.zone} · {statusLabel(selected)}</div></div>{role === 'admin' && <button type="button" onClick={() => { closeCamera(); editCameraLocation(selected); }} className="hidden h-8 items-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-accent sm:flex"><MapPin className="h-3 w-3" /> Localização</button>}{role !== 'viewer' && <Link href={`/cameras?cameraId=${encodeURIComponent(selected.id)}`} className="hidden h-8 items-center gap-1.5 rounded border border-border px-2.5 text-xs hover:bg-accent sm:flex">Detalhes <ExternalLink className="h-3 w-3" /></Link>}<button onClick={closeCamera} className="flex h-8 w-8 items-center justify-center rounded hover:bg-accent" aria-label="Fechar câmera"><X className="h-4 w-4" /></button></div>
            <div className="relative aspect-video bg-black">{selected.isOnline ? <LiveStreamPlayer cameraId={selected.id} cameraName={selected.name} className="absolute inset-0 h-full w-full" muted showOverlay aiEnabled={selected.aiEnabled} liveViewMode="selected" /> : <div className="flex h-full items-center justify-center text-sm text-white/55">Câmera offline</div>}</div>
          </div>
        </div>
      )}

      <CameraLocationDialog
        camera={locationCamera}
        open={Boolean(locationCamera) && !pickingLocation}
        pickedPosition={pickedPosition}
        onOpenChange={(open) => {
          if (!open && !pickingLocation) {
            setLocationCameraId(null);
            setPickedPosition(null);
          }
        }}
        onPickMap={() => setPickingLocation(true)}
        onSaved={() => {
          setLocationCameraId(null);
          setPickedPosition(null);
        }}
      />
    </div>
  );
}
