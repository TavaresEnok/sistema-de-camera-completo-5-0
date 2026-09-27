import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { Save, Trash2, ExternalLink, LoaderCircle, Copy, RefreshCw, Check, Radio, ArrowRightLeft, Eye, EyeOff, LocateFixed, MapPin } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Camera, useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { getApiBaseUrl } from '../lib/api-base';
import { descreverCredencial, deveEnviarSenha } from '../lib/senha-da-camera';
import { normalizeVideoCodec, normalizePreferredLiveProtocol } from '../lib/camera-format';
import { SeletorDeClassesDeGravacao } from './SeletorDeClassesDeGravacao';
import { useClassesLiberadas } from '../hooks/use-classes-liberadas';
import { CameraConnectionCheck } from './CameraConnectionCheck';
import { equipmentFields, equipmentError, equipmentPayload, readEquipment, type EquipmentForm } from '../lib/camera-edit';
import { getRequestErrorMessage } from '../lib/request-error';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './ui/alert-dialog';
import {
  rotuloDoGatilhoDeObjeto,
  descricaoDoGatilhoDeObjeto,
  podeUsarGatilhoDeObjeto,
} from '../lib/gatilho-de-objeto';

interface CameraEditSheetProps {
  camera: Camera | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}

type Form = EquipmentForm & {
  recordingEnabled: boolean;
  name: string;
  ip: string;
  rtspPort: string;
  username: string;
  password: string;
  locationAddress: string;
  latitude: string;
  longitude: string;
  onvifPort: string;
  httpPort: string;
  rtspPath: string;
  preferredRtspTransport: 'tcp' | 'udp';
  preferredLiveProtocol: string;
  streamVideoCodec: string;
  recordingVideoCodec: string;
  recordingMode: 'continuous' | 'motion' | 'object' | 'schedule' | 'manual';
  recordingObjectClasses: string[];
  retentionDays: string;
  /** Segue a política do grupo? Sem isto, o número de dias é decorativo. */
  retentionFollowsGroup: boolean;
  /** Dias do grupo, para mostrar o que está de fato valendo. */
  grupoRetentionDays: number | null;
  audioEnabled: boolean;
  aiEnabled: boolean;
  alarmsEnabled: boolean;
  enabled: boolean;
};

const RECORDING_MODES = [
  { value: 'continuous', label: 'Contínua', desc: '24 h ininterrupto' },
  { value: 'motion', label: 'Por movimento', desc: 'Ativa ao detectar movimento' },
  // Movimento é um sinal burro: sombra, folha e chuva geram arquivo. Objeto só
  // grava com pessoa/veículo confirmado pela IA — é o que se quer quando o
  // disco enche de nada. Custa YOLO ligado nesta câmera.
  // Rótulo e descrição do modo objeto NÃO ficam aqui: eles dependem do que a
  // Central liberou para esta instalação, e escrever "Pessoa ou veículo" fixo
  // fazia a tela prometer veículo numa instalação só de pessoa (14/08/2026).
  { value: 'object', label: '', desc: '' },
  { value: 'manual', label: 'Manual', desc: 'Operador inicia / para' },
] as const;

const CODECS = ['original', 'h264', 'h265', 'mjpeg'] as const;
const LIVE_PROTOCOLS = ['webrtc', 'hls', 'llhls', 'mjpeg'] as const;

// ── COMO O VÍDEO CHEGA ATÉ NÓS ─────────────────────────────────────────────
//
// Duas formas, e a escolha muda o que o instalador precisa fazer em campo:
//
//  · NÓS CONECTAMOS (RTSP): o servidor disca para a câmera. Exige que ela seja
//    alcançável — IP público, redirecionamento de porta ou VPN. É o modo de
//    sempre, e continua sendo o padrão de toda câmera já cadastrada.
//
//  · A CÂMERA PUBLICA (RTMP): a câmera abre a conexão de saída e empurra o
//    vídeo para nós. Funciona atrás de CGNAT, 4G e qualquer rede onde ninguém
//    vai abrir porta — porque a conexão nasce de dentro.
type IngestTarget = {
  sourceMode: string;
  serverUrl: string | null;
  streamKey: string | null;
  fullUrl: string | null;
  canonicalFullUrl?: string | null;
  compactFullUrl?: string | null;
  fullUrlFitsSingleField?: boolean;
  singleFieldMaxLength?: number;
  /** Caminho próprio do equipamento, quando ele não deixa escolher. */
  ingestPath?: string | null;
};

type PendingIngest = {
  path: string;
  remoteAddr: string | null;
  lastSeenAt: number;
  attempts: number;
};

export function CameraEditSheet({ camera, open, onClose, onDeleted }: CameraEditSheetProps) {
  const [, setLocation] = useLocation();
  const accessToken = useAuthStore((s) => s.accessToken);
  const canEdit = useAuthStore((s) => s.user?.role === 'admin');
  const [sourceMode, setSourceMode] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const initialForm = useRef<Form | null>(null);
  const loadData = useVmsDataStore((s) => s.load);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const { classes: classesLiberadas } = useClassesLiberadas();
  const [ingest, setIngest] = useState<IngestTarget | null>(null);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [confirmarVoltarRtsp, setConfirmarVoltarRtsp] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [pendentes, setPendentes] = useState<PendingIngest[]>([]);
  const [caminhoManual, setCaminhoManual] = useState('');
  const [senhaVisivel, setSenhaVisivel] = useState(false);
  const [buscandoSenha, setBuscandoSenha] = useState(false);
  const [avisoDaSenha, setAvisoDaSenha] = useState<string | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  // A senha COMO VEIO do servidor, para saber se o dono só espiou ou mexeu.
  const [senhaRevelada, setSenhaRevelada] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * O olho da senha. Ocultar é local; revelar BUSCA no servidor, porque a senha
   * nunca vem no payload da câmera — só nesta rota, que é auditada.
   */
  const alternarSenha = async () => {
    if (senhaVisivel) { setSenhaVisivel(false); return; }
    // Já digitou algo? Então é a senha nova dele, e é essa que ele quer ver.
    if (senhaRevelada !== null || form?.password) { setSenhaVisivel(true); return; }
    if (!camera?.id || !accessToken) return;
    setBuscandoSenha(true);
    try {
      const { data } = await axios.get(`${getApiBaseUrl()}/cameras/${camera.id}/credential`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const lida = descreverCredencial(data);
      setAvisoDaSenha(lida.aviso);
      setSenhaRevelada(lida.valor);
      setForm((f) => (f ? { ...f, password: lida.valor } : f));
      setSenhaVisivel(lida.revelavel);
    } catch {
      setAvisoDaSenha(descreverCredencial(null).aviso);
    } finally {
      setBuscandoSenha(false);
    }
  };

  const cameraId = camera?.id ?? null;
  useEffect(() => {
    const selectedCamera = camera;
    if (!open || !canEdit || !cameraId || !accessToken || !selectedCamera) return;
    let cancelled = false;
    setForm(null);
    setDirty(false);
    setPendingClose(null);
    setSourceMode('');
    setIngest(null);
    setConfirmDelete(false);
    setSenhaVisivel(false);
    setSenhaRevelada(null);
    setAvisoDaSenha(null);
    setCaminhoManual('');
    setLoading(true);
    // Modo de origem vem de endpoint próprio (a chave é credencial e só
    // administrador lê). Falha aqui não pode impedir editar a câmera.
    void axios
      .get(`${getApiBaseUrl()}/cameras/${cameraId}/rtmp-ingest`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then(({ data }) => { if (!cancelled) setIngest(data ?? null); })
      .catch(() => undefined);
    void axios
      .get(`${getApiBaseUrl()}/cameras/${cameraId}`, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(({ data }) => {
        if (cancelled) return;
        setSourceMode(data.sourceMode ?? 'rtsp_pull');
        const loaded: Form = {
          ...readEquipment(data),
          recordingEnabled: data.recordingEnabled !== false,
          name: data.name ?? selectedCamera.name,
          ip: data.ip ?? selectedCamera.ipAddress,
          rtspPort: String(data.rtspPort ?? selectedCamera.rtspPort ?? 554),
          username: data.username ?? '',
          password: '',
          locationAddress: data.locationAddress ?? '',
          latitude: data.latitude == null ? '' : String(data.latitude),
          longitude: data.longitude == null ? '' : String(data.longitude),
          onvifPort: data.onvifPort != null ? String(data.onvifPort) : '',
          httpPort: data.httpPort != null ? String(data.httpPort) : '',
          rtspPath: data.rtspPath ?? '',
          preferredRtspTransport: (data.preferredRtspTransport ?? 'tcp') as 'tcp' | 'udp',
          preferredLiveProtocol: normalizePreferredLiveProtocol(data.preferredLiveProtocol),
          streamVideoCodec: normalizeVideoCodec(data.streamVideoCodec),
          recordingVideoCodec: normalizeVideoCodec(data.recordingVideoCodec),
          recordingMode: (data.recordingMode ?? (data.recordingEnabled ? 'continuous' : 'manual')) as Form['recordingMode'],
          recordingObjectClasses: Array.isArray(data.recordingObjectClasses) ? data.recordingObjectClasses : [],
          retentionDays: String(data.retentionDays ?? 7),
          retentionFollowsGroup: data.retentionFollowsGroup !== false,
          grupoRetentionDays: (data as { group?: { retentionDays?: number | null } }).group?.retentionDays ?? null,
          audioEnabled: Boolean(data.audioEnabled),
          aiEnabled: data.aiEnabled !== false,
          alarmsEnabled: data.alarmsEnabled !== false,
          enabled: data.enabled !== false,
        };
        initialForm.current = loaded;
        setForm(loaded);
      })
      .catch((err) => {
        if (cancelled) return;
        toast({
          title: 'Falha ao carregar câmera',
          description: getRequestErrorMessage(err, 'Não foi possível carregar a configuração.'),
          variant: 'destructive',
        });
        onCloseRef.current();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, accessToken, open, canEdit]);

  // A câmera costuma tentar uma vez por minuto. Atualizar apenas ao abrir a
  // gaveta fazia a linha aparecer só depois de fechar e abrir de novo, parecendo
  // que a detecção não existia. Enquanto a edição está aberta, acompanha as
  // tentativas sem exigir ação do instalador.
  useEffect(() => {
    if (!open || !canEdit || !cameraId || !accessToken) return;
    let cancelled = false;
    const carregarPendentes = () => {
      void axios
        .get(`${getApiBaseUrl()}/cameras/rtmp-ingest/pending`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .then(({ data }) => { if (!cancelled) setPendentes(data?.items ?? []); })
        .catch(() => undefined);
    };
    carregarPendentes();
    const timer = window.setInterval(carregarPendentes, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, cameraId, accessToken, canEdit]);

  useEffect(() => {
    if (!open || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open, dirty]);

  if (!camera || !canEdit) return null;
  const upd = <K extends keyof Form>(k: K, v: Form[K]) => { setDirty(true); setForm((f) => (f ? { ...f, [k]: v } : f)); };
  const finishClose = (destination = '') => {
    onClose();
    if (destination) setLocation(destination);
  };
  const close = (destination = '') => {
    if (saving || ingestBusy) return;
    if (dirty) { setPendingClose(destination); return; }
    finishClose(destination);
  };

  const modoPush = (ingest?.sourceMode ?? sourceMode) === 'rtmp_push';
  const usaEnderecoCompacto = Boolean(ingest?.canonicalFullUrl && ingest.fullUrl !== ingest.canonicalFullUrl);
  const urlCompletaCompativel = ingest?.fullUrlFitsSingleField !== false;
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

  const copiar = async (texto: string, marca: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(marca);
      window.setTimeout(() => setCopiado((c) => (c === marca ? null : c)), 1800);
    } catch {
      toast({ title: 'Não foi possível copiar', description: 'Selecione e copie manualmente.', variant: 'destructive' });
    }
  };

  /** Liga o modo publicação e gera a chave. Rotacionar usa o mesmo caminho. */
  const ativarPush = async (rotacionando = false) => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      const { data } = await axios.post(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, {}, auth);
      setIngest(data);
      toast({
        title: rotacionando ? 'Chave trocada' : 'Modo publicação ativado',
        description: rotacionando
          ? 'A chave anterior parou de valer. Atualize a câmera com a nova.'
          : 'Copie o endereço e a chave para a câmera.',
      });
    } catch (err) {
      toast({
        title: 'Falha ao gerar a chave',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIngestBusy(false);
    }
  };

  /** Assume que o equipamento que publica naquele caminho É esta câmera. */
  const vincular = async (path: string) => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      await axios.post(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest/bind`, { path }, auth);
      const [{ data: alvo }, { data: lista }] = await Promise.all([
        axios.get(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, auth),
        axios.get(`${getApiBaseUrl()}/cameras/rtmp-ingest/pending`, auth),
      ]);
      setIngest(alvo ?? null);
      setPendentes(lista?.items ?? []);
      setCaminhoManual('');
      toast({ title: 'Equipamento vinculado', description: 'O vídeo dele passa a entrar como esta câmera.' });
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.message ?? err.message) : 'Tente novamente.';
      toast({ title: 'Falha ao vincular', description: String(msg), variant: 'destructive' });
    } finally {
      setIngestBusy(false);
    }
  };

  /** Volta ao modo tradicional e APAGA a chave (senão ela seguiria valendo). */
  const desativarPush = async () => {
    if (!accessToken) return;
    setIngestBusy(true);
    try {
      await axios.delete(`${getApiBaseUrl()}/cameras/${camera.id}/rtmp-ingest`, auth);
      setIngest({ sourceMode: 'rtsp_pull', serverUrl: null, streamKey: null, fullUrl: null });
      toast({ title: 'Voltou para conexão pelo servidor', description: 'A chave de publicação foi apagada.' });
    } catch (err) {
      toast({
        title: 'Falha ao desativar',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIngestBusy(false);
    }
  };

  const handleSave = async () => {
    if (!accessToken || !form || saving || ingestBusy) return;
    const invalidEquipment = equipmentError(form);
    const invalidPort = !modoPush && [form.rtspPort, ...(form.onvifPort.trim() ? [form.onvifPort] : [])]
      .some(value => !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535);
    if (!form.name.trim() || (!modoPush && !form.ip.trim()) || invalidPort || invalidEquipment
      || !Number.isInteger(Number(form.retentionDays)) || Number(form.retentionDays) < 1) {
      toast({ title: 'Confira os dados', description: invalidEquipment ?? 'Preencha nome, endereço, portas e prazo de armazenamento com valores válidos.', variant: 'destructive' });
      return;
    }
    if (!modoPush) {
      const httpPort = Number(form.httpPort);
      if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
        toast({
          title: 'Porta de acesso web obrigatória',
          description: 'Informe a porta usada para abrir a câmera no navegador, como 80, 8080 ou 8081.',
          variant: 'destructive',
        });
        return;
      }
    }
    if (form.recordingMode === 'schedule') {
      toast({
        title: 'Agenda ainda não está disponível',
        description: 'Escolha gravação contínua, por movimento ou manual antes de salvar.',
        variant: 'destructive',
      });
      return;
    }
    const latitude = form.latitude.trim() === '' ? null : Number(form.latitude);
    const longitude = form.longitude.trim() === '' ? null : Number(form.longitude);
    if ((latitude === null) !== (longitude === null)
      || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
      || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
      toast({ title: 'Localização incompleta', description: 'Informe latitude e longitude válidas juntas.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
          name: form.name.trim(),
          locationAddress: form.locationAddress.trim() || null,
          latitude,
          longitude,
          ...(!modoPush ? {
          ip: form.ip.trim(),
          rtspPort: Number(form.rtspPort),
          username: form.username.trim(),
          ...(deveEnviarSenha(form.password, senhaRevelada) ? { password: form.password } : {}),
          // ONVIF vazio significa usar primeiro a porta web e depois descobrir.
          onvifPort: form.onvifPort.trim() ? Number(form.onvifPort) : null,
          httpPort: Number(form.httpPort),
          rtspPath: form.rtspPath.trim(),
          } : {}),
          ...equipmentPayload(form, modoPush),
          recordingEnabled: form.recordingEnabled,
          preferredRtspTransport: form.preferredRtspTransport,
          preferredLiveProtocol: form.preferredLiveProtocol === 'mjpeg' ? 'webrtc' : form.preferredLiveProtocol,
          streamVideoCodec: 'h264',
          recordingVideoCodec: normalizeVideoCodec(form.recordingVideoCodec),
          recordingMode: form.recordingMode,
          recordingObjectClasses: form.recordingObjectClasses,
          retentionDays: Number(form.retentionDays),
          // SEM ISTO o número de dias não tinha efeito nenhum: a câmera
          // continuava seguindo o grupo e o campo mentia o prazo.
          retentionFollowsGroup: form.retentionFollowsGroup,
          audioEnabled: form.audioEnabled,
          aiEnabled: form.aiEnabled,
          alarmsEnabled: form.alarmsEnabled,
          enabled: form.enabled,
      };
      // A polling refresh or another editor must not have unrelated fields overwritten.
      const changes = Object.fromEntries(Object.entries(payload).filter(([key]) =>
        JSON.stringify(form[key as keyof Form]) !== JSON.stringify(initialForm.current?.[key as keyof Form])));
      if (!Object.keys(changes).length) { onClose(); return; }
      await axios.patch(
        `${getApiBaseUrl()}/cameras/${camera.id}`,
        changes,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      await loadData();
      toast({ title: 'Câmera atualizada', description: form.name });
      onClose();
    } catch (err) {
      const message = getRequestErrorMessage(err, 'Não foi possível salvar a câmera. Tente novamente.');
      toast({ title: 'Erro ao salvar', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const geocodeLocation = async () => {
    if (!accessToken || !form?.locationAddress.trim()) return;
    setGeocoding(true);
    try {
      const { data } = await axios.get(`${getApiBaseUrl()}/cameras/location/geocode`, {
        params: { address: form.locationAddress.trim() },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setForm((current) => current ? {
        ...current,
        locationAddress: data.displayName || current.locationAddress,
        latitude: String(data.latitude),
        longitude: String(data.longitude),
      } : current);
      setDirty(true);
      toast({ title: 'Endereço localizado', description: 'Confira o ponto no mapa e salve a câmera.' });
    } catch (error) {
      const description = axios.isAxiosError(error)
        ? error.response?.data?.message ?? error.message
        : 'Não foi possível localizar este endereço.';
      toast({ title: 'Endereço não encontrado', description, variant: 'destructive' });
    } finally {
      setGeocoding(false);
    }
  };

  const handleDelete = async () => {
    if (!accessToken) return;
    try {
      await axios.delete(`${getApiBaseUrl()}/cameras/${camera.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      await loadData();
      toast({ title: 'Câmera removida', description: camera.name });
      onDeleted?.(camera.id);
      onClose();
    } catch (err) {
      toast({ title: 'Erro ao remover', description: err instanceof Error ? err.message : 'Falha.', variant: 'destructive' });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full sm:max-w-[560px] flex flex-col p-0 gap-0" onInteractOutside={(event) => { if (dirty || saving || ingestBusy) event.preventDefault(); }}>
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 space-y-0 text-left">
          <div className="flex items-center gap-3">
            <span className={cn('w-2 h-2 rounded-full shrink-0', camera.isOnline ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--status-offline))]')} />
            <div className="min-w-0">
              <SheetTitle className="text-[14px] font-semibold truncate">{camera.name}</SheetTitle>
              <SheetDescription className="sr-only">Editar identificação, transmissão e gravação da câmera {camera.name}.</SheetDescription>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{camera.zone} · {camera.isOnline ? 'Online' : 'Sem conexão'}</p>
            </div>
          </div>
        </SheetHeader>

        {loading || !form ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <LoaderCircle className="w-5 h-5 animate-spin" />
          </div>
        ) : (
          <>
            <fieldset disabled={saving || ingestBusy} className="flex-1 overflow-y-auto min-h-0">
              <Tabs defaultValue="geral" className="flex flex-col">
                <TabsList className="mx-4 mt-4 grid h-10 shrink-0 grid-cols-4 gap-1 rounded-lg border border-border bg-muted/45 p-1">
                  <TabsTrigger value="geral" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Geral</TabsTrigger>
                  <TabsTrigger value="conexao" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Conexão</TabsTrigger>
                  <TabsTrigger value="stream" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Vídeo</TabsTrigger>
                  <TabsTrigger value="gravacao" className="rounded-md text-xs text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">Gravação</TabsTrigger>
                </TabsList>

                {/* GERAL */}
                <TabsContent value="geral" className="px-5 py-4 space-y-4 mt-0">
                  {/* Liga/desliga da câmera — em destaque no topo. Desativada:
                      para de exibir e gravar, sem apagar o cadastro. */}
                  <div className={cn(
                    'flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 transition-colors',
                    form.enabled
                      ? 'border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)]'
                      : 'border-amber-500/40 bg-amber-500/10',
                  )}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', form.enabled ? 'bg-[hsl(var(--status-online))]' : 'bg-amber-500')} />
                        <p className="text-[13px] font-semibold">{form.enabled ? 'Câmera ativa' : 'Câmera desativada'}</p>
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                        {form.enabled
                          ? 'Habilitada para funcionar. A disponibilidade do vídeo depende da conexão. Desligue para pausar sem apagar o cadastro.'
                          : 'Não está transmitindo nem gravando. As gravações antigas e o cadastro continuam salvos.'}
                      </p>
                    </div>
                    <Switch checked={form.enabled} onCheckedChange={(v) => upd('enabled', v)} />
                  </div>
                  <FormField label="Nome da câmera" required>
                    <Input value={form.name} onChange={(e) => upd('name', e.target.value)} className="text-sm" />
                  </FormField>
                  <div className="space-y-3 rounded-lg border border-border bg-background/55 p-3">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-primary" />
                      <div><p className="text-[12px] font-semibold">Localização no mapa</p><p className="text-xs text-muted-foreground">Verifique o endereço da câmera.</p></div>
                    </div>
                    <FormField label="Endereço físico" hint="rua, número, cidade e estado">
                      <div className="flex gap-2">
                        <Input value={form.locationAddress} onChange={(e) => upd('locationAddress', e.target.value)} placeholder="Ex.: Av. Paulista, 1000, São Paulo - SP" className="min-w-0 text-sm" />
                        <Button type="button" variant="outline" disabled={geocoding || form.locationAddress.trim().length < 5} onClick={() => void geocodeLocation()} className="shrink-0 gap-1.5 px-3 text-xs">
                          {geocoding ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <LocateFixed className="h-3.5 w-3.5" />}
                          Localizar
                        </Button>
                      </div>
                    </FormField>
                    <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer py-2">Informar coordenadas</summary>
                    <div className="grid grid-cols-2 gap-2">
                      <FormField label="Latitude" hint="opcional">
                        <Input value={form.latitude} onChange={(e) => upd('latitude', e.target.value)} placeholder="-8.05428" inputMode="decimal" className="font-mono text-xs" />
                      </FormField>
                      <FormField label="Longitude" hint="opcional">
                        <Input value={form.longitude} onChange={(e) => upd('longitude', e.target.value)} placeholder="-34.88130" inputMode="decimal" className="font-mono text-xs" />
                      </FormField>
                    </div>
                    </details>
                  </div>
                </TabsContent>
                <TabsContent value="conexao" className="px-5 py-4 space-y-4 mt-0">
                  <p className="text-xs text-muted-foreground">Configure como a câmera envia o vídeo ao sistema.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      // CONFIRMAR ANTES DE APAGAR A CHAVE. Estes dois cartões
                      // parecem um seletor inofensivo, mas clicar aqui disparava
                      // `DELETE .../rtmp-ingest` na hora: uma câmera 4G já
                      // instalada em campo para de publicar imediatamente e a
                      // chave NÃO volta — é preciso gerar outra e reconfigurar o
                      // equipamento no local.
                      onClick={() => { if (modoPush && !ingestBusy) setConfirmarVoltarRtsp(true); }}
                      disabled={ingestBusy}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                        !modoPush ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
                        <span className="text-[12px] font-semibold">Buscar na câmera (RTSP)</span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        O servidor busca o vídeo na câmera. Ela precisa estar acessível: porta liberada ou VPN.
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (!modoPush && !ingestBusy) void ativarPush(); }}
                      disabled={ingestBusy}
                      className={cn(
                        'rounded-lg border p-3 text-left transition-colors disabled:opacity-60',
                        modoPush ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <Radio className="h-3.5 w-3.5 shrink-0" />
                        <span className="text-[12px] font-semibold">Câmera envia (RTMP)</span>
                      </div>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        A câmera manda o vídeo para o servidor. Funciona atrás de CGNAT e 4G, sem liberar porta.
                      </p>
                    </button>
                  </div>

                  {modoPush ? (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3.5">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Cole este endereço na câmera ou no DVR, normalmente em
                        {' '}<span className="font-medium text-foreground">Rede → RTMP</span> (ou
                        {' '}<em>Push Stream</em>). Depois disso ela aparece na grade sozinha.
                      </p>

                      {ingest?.ingestPath ? (
                        <div className="rounded-md border border-[hsl(var(--status-online)_/_0.35)] bg-[hsl(var(--status-online)_/_0.08)] p-3">
                          <p className="text-[11px] font-semibold">Equipamento vinculado</p>
                          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{ingest.ingestPath}</p>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
                            O modo IP/porta do equipamento chegou ao servidor com este identificador.
                            Se não houver vídeo, use abaixo o modo <strong className="text-foreground">Personalizado</strong>
                            {' '}com a URL completa — alguns firmwares conectam pelo serial, mas não enviam mídia nesse modo.
                          </p>
                        </div>
                      ) : null}
                      {ingest?.fullUrl && (
                        <div className="space-y-3">
                          <details className="rounded-md border border-border p-3">
                            <summary className="cursor-pointer text-xs font-medium">Ajuda para Intelbras e Positivo</summary>
                            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                              Selecione <strong className="text-foreground">Tipo de endereço → Personalizado</strong> e cole
                              {' '}a URL completa abaixo. Não use “Não personalizado” com apenas IP/porta: esse modo gera
                              {' '}o caminho por serial e pode encerrar sem transmitir quadros para servidores genéricos.
                            </p>
                          </details>
                          {usaEnderecoCompacto && (
                            <p className="text-xs text-muted-foreground">Endereço compacto selecionado, pronto para copiar.</p>
                          )}
                          {urlCompletaCompativel ? (
                            <CampoCopiavel
                              rotulo="Endereço RTMP"
                              valor={ingest?.fullUrl ?? ''}
                              copiado={copiado === 'completa'}
                              onCopiar={() => copiar(ingest?.fullUrl ?? '', 'completa')}
                            />
                          ) : (
                            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                              <p className="text-[11px] font-semibold text-amber-500">URL maior que o campo da câmera</p>
                              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                                Não recorte a chave. Se o equipamento oferecer dois campos, use Servidor + Chave.
                                Em campo único, use endereço Personalizado somente se ele aceitar a URL inteira;
                                o modo “Não personalizado” por IP e porta não substitui a URL completa.
                              </p>
                            </div>
                          )}
                          <details className="rounded-md border border-border bg-background/40 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] font-medium">Equipamento com campos Servidor + Chave</summary>
                            <div className="mt-3 space-y-3">
                              <p className="text-[10px] leading-relaxed text-muted-foreground">
                                Use somente quando existirem dois campos reais. Na Intelbras, “Não personalizado”
                                com IP/porta não equivale a Servidor + Chave.
                              </p>
                              <CampoCopiavel
                                rotulo="Servidor RTMP"
                                valor={ingest?.serverUrl ?? ''}
                                copiado={copiado === 'servidor'}
                                onCopiar={() => copiar(ingest?.serverUrl ?? '', 'servidor')}
                              />
                              <CampoCopiavel
                                rotulo="Chave do stream"
                                valor={ingest?.streamKey ?? ''}
                                copiado={copiado === 'chave'}
                                onCopiar={() => copiar(ingest?.streamKey ?? '', 'chave')}
                              />
                            </div>
                          </details>
                        </div>
                      )}

                      {pendentes.length > 0 && (
                        <details className="rounded-md border border-border p-3">
                          <summary className="cursor-pointer text-xs font-medium">Vincular equipamento pendente</summary>
                          <div className="space-y-2">
                            <p className="text-[11px] font-semibold">Equipamentos tentando publicar</p>
                            <p className="text-[10px] leading-relaxed text-muted-foreground">
                              Chegaram no servidor mas ainda não pertencem a nenhuma câmera. Se um deles
                              for esta, vincule — o vídeo passa a entrar por aqui. A lista atualiza automaticamente.
                            </p>
                            {pendentes.map((p) => (
                              <div key={p.path} className="flex items-center gap-2 rounded-md border border-border bg-background/60 p-2">
                                <div className="min-w-0 flex-1">
                                  <p className="truncate font-mono text-[11px]">{p.path}</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {p.remoteAddr ?? 'origem desconhecida'} · {p.attempts} tentativa{p.attempts > 1 ? 's' : ''}
                                  </p>
                                </div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={ingestBusy}
                                  onClick={() => void vincular(p.path)}
                                  className="h-8 shrink-0 text-[11px]"
                                >
                                  É esta câmera
                                </Button>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}

                      {!ingest?.ingestPath && (
                        <details className="rounded-md border border-border p-3">
                          <summary className="cursor-pointer text-xs font-medium">Informar caminho manualmente</summary>
                          <div className="space-y-2 rounded-md border border-border bg-background/40 p-3">
                            <p className="text-[11px] font-semibold">Câmera usa um caminho próprio?</p>
                            <p className="text-[10px] leading-relaxed text-muted-foreground">
                              Alguns modelos ignoram a chave e publicam com o número de série. Se a tentativa
                              não aparecer automaticamente, informe aqui o caminho exibido no log da câmera.
                            </p>
                            <div className="flex items-center gap-2">
                              <Input
                                value={caminhoManual}
                                onChange={(e) => setCaminhoManual(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && caminhoManual.trim() && !ingestBusy) {
                                    void vincular(caminhoManual.trim());
                                  }
                                }}
                                placeholder="live/liveStream_NUMERO_DE_SERIE_0_0"
                                aria-label="Caminho próprio da câmera"
                                className="h-9 min-w-0 flex-1 font-mono text-[11px]"
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={ingestBusy || !caminhoManual.trim()}
                                onClick={() => void vincular(caminhoManual.trim())}
                                className="h-9 shrink-0 text-[11px]"
                              >
                                Vincular caminho
                              </Button>
                            </div>
                          </div>
                        </details>
                      )}

                      <Separator />
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[10px] leading-relaxed text-muted-foreground">
                          A chave é uma senha de publicação. Troque se vazar ou ao trocar o equipamento —
                          a anterior para de valer na hora.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={ingestBusy}
                          onClick={() => void ativarPush(true)}
                          className="h-8 shrink-0 gap-1.5 text-[11px]"
                        >
                          <RefreshCw className={cn('h-3 w-3', ingestBusy && 'animate-spin')} />
                          Trocar chave
                        </Button>
                      </div>
                      <p className="text-[10px] leading-relaxed text-amber-500/90">
                        O RTMP transporta H.264. Equipamento que só sai em H.265 não serve para este modo.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <FormField label="Endereço IP" required>
                          <Input value={form.ip} onChange={(e) => upd('ip', e.target.value)} className="text-sm font-mono" />
                        </FormField>
                        <FormField label="Porta RTSP">
                          <Input value={form.rtspPort} onChange={(e) => upd('rtspPort', e.target.value)} className="text-sm font-mono" />
                        </FormField>
                        <FormField label="Usuário">
                          <Input placeholder="admin" value={form.username} onChange={(e) => upd('username', e.target.value)} className="text-sm" />
                        </FormField>
                        <FormField label="Senha" hint={avisoDaSenha ?? undefined}>
                          <div className="relative">
                            <Input
                              type={senhaVisivel ? 'text' : 'password'}
                              placeholder="Manter atual"
                              value={form.password}
                              onChange={(e) => { upd('password', e.target.value); setAvisoDaSenha(null); }}
                              className="text-sm pr-9"
                            />
                            {camera?.id && (
                              <button
                                type="button"
                                onClick={alternarSenha}
                                disabled={buscandoSenha}
                                title={senhaVisivel ? 'Ocultar senha' : 'Ver a senha desta câmera'}
                                aria-label={senhaVisivel ? 'Ocultar senha' : 'Ver a senha desta câmera'}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                              >
                                {buscandoSenha
                                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                                  : senhaVisivel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                        </FormField>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Fora de qualquer gaveta: é aqui que se conserta câmera
                            atrás de roteador, e foi o que o dono não achou. */}
                        <FormField label="Porta ONVIF" hint="opcional; vazio usa a porta web">
                          <Input value={form.onvifPort} onChange={(e) => upd('onvifPort', e.target.value)} placeholder="Vazio: usar a porta web" className="text-sm font-mono" />
                        </FormField>
                        <FormField label="Porta de acesso web (HTTP)" hint="obrigatória">
                          <Input value={form.httpPort} onChange={(e) => upd('httpPort', e.target.value)} placeholder="Ex.: 80, 8080 ou 8081" className="text-sm font-mono" inputMode="numeric" />
                        </FormField>
                      </div>
                      <FormField label="Caminho RTSP" hint="vazio = detectar">
                        <Input value={form.rtspPath} onChange={(e) => upd('rtspPath', e.target.value)} placeholder="/live/ch1main" className="text-sm font-mono" />
                      </FormField>
                    </>
                  )}
                </TabsContent>

                {/* STREAM */}
                <TabsContent value="stream" className="px-5 py-4 space-y-4 mt-0">
                  <CameraConnectionCheck cameraId={camera.id} push={modoPush}
                    onDiscover={values => { setForm(current => current ? { ...current, ...values } : current); setDirty(true); }}
                    discoveryDraft={{
                      ip: form.ip.trim(), rtspPort: Number(form.rtspPort), httpPort: Number(form.httpPort) || undefined,
                      username: form.username.trim(), password: form.password || undefined,
                      onvifPort: Number(form.onvifPort) || undefined, onvifPath: form.onvifPath || undefined,
                      onvifProfileToken: form.onvifProfileToken || undefined, rtspPath: form.rtspPath || undefined,
                      channel: Number(form.channel), subtype: Number(form.subtype),
                    }} draft={{
                    ip: form.ip.trim() || undefined, rtspPort: Number(form.rtspPort) || undefined,
                    username: form.username.trim() || undefined,
                    ...(deveEnviarSenha(form.password, senhaRevelada) ? { password: form.password } : {}),
                    rtspPath: form.rtspPath.trim(), channel: Number(form.channel), subtype: Number(form.liveSubtype || form.subtype),
                  }} />
                  {!modoPush && <FormField label="Qualidade recebida ao vivo" hint="depende dos perfis disponíveis na câmera">
                    <Select value={!form.liveSubtype ? 'auto' : ['0', '1'].includes(form.liveSubtype) ? form.liveSubtype : 'custom'} onValueChange={v => { if (v !== 'custom') upd('liveSubtype', v === 'auto' ? '' : v); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Automática</SelectItem>
                        <SelectItem value="0">Principal — mais detalhes</SelectItem>
                        <SelectItem value="1">Secundária — economiza conexão</SelectItem>
                        {form.liveSubtype && !['0', '1'].includes(form.liveSubtype) && <SelectItem value="custom" disabled>Perfil personalizado {form.liveSubtype}</SelectItem>}
                      </SelectContent>
                    </Select>
                  </FormField>}
                  <details className="space-y-3"><summary className="cursor-pointer text-xs">Compatibilidade de vídeo (instalador)</summary>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField label="Codec da live">
                      <Input value="H.264" readOnly className="text-sm font-mono text-muted-foreground" />
                    </FormField>
                    <FormField label="Protocolo ao vivo">
                      <Select value={form.preferredLiveProtocol} onValueChange={(v) => upd('preferredLiveProtocol', v)}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {LIVE_PROTOCOLS.filter((p) => p !== 'mjpeg').map((p) => <SelectItem key={p} value={p} className="text-sm uppercase">{p}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField label="Transporte RTSP">
                      <Select value={form.preferredRtspTransport} onValueChange={(v) => upd('preferredRtspTransport', v as 'tcp' | 'udp')}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tcp" className="text-sm">TCP</SelectItem>
                          <SelectItem value="udp" className="text-sm">UDP</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                  </details>
                  <div className="rounded-lg border border-border bg-background/70 px-3 py-2 text-[11px] text-muted-foreground">
                    O mosaico usa uma imagem mais leve. Ao abrir uma câmera sozinha, você vê a qualidade original do perfil escolhido.
                  </div>
                  <Separator />
                  <ToggleRow label="Áudio" desc="Captura de áudio da câmera" value={form.audioEnabled} onChange={(v) => upd('audioEnabled', v)} />
                </TabsContent>

                {/* GRAVAÇÃO */}
                <TabsContent value="gravacao" className="px-5 py-4 space-y-4 mt-0">
                  <ToggleRow label="Permitir gravação" desc="Autoriza o armazenamento de vídeo conforme o modo escolhido abaixo." value={form.recordingEnabled} onChange={v => upd('recordingEnabled', v)} />
                  <ToggleRow label="Alertas desta câmera" desc="Permite os alertas configurados para esta câmera." value={form.alarmsEnabled} onChange={v => upd('alarmsEnabled', v)} />
                  {!form.recordingEnabled && <p role="status" className="text-xs text-muted-foreground">A gravação está desativada. Escolher um modo não a ativa; ligue “Permitir gravação” para gravar.</p>}
                  <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Modo de gravação</p>
                  {form.recordingMode === 'schedule' && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                      Esta câmera usa uma configuração antiga de agenda, mas o executor de horários ainda não existe. Escolha um modo disponível antes de salvar.
                    </div>
                  )}
                  <div className="space-y-2">
                    {RECORDING_MODES.map((m) => {
                      const ehObjeto = m.value === 'object';
                      const gate = podeUsarGatilhoDeObjeto(classesLiberadas);
                      const bloqueado = ehObjeto && !gate.pode;
                      const rotulo = ehObjeto ? rotuloDoGatilhoDeObjeto(classesLiberadas) : m.label;
                      const descricao = ehObjeto
                        ? (bloqueado ? gate.motivo! : descricaoDoGatilhoDeObjeto(classesLiberadas))
                        : m.desc;
                      return (
                      <button key={m.value} onClick={() => !bloqueado && upd('recordingMode', m.value)}
                        disabled={bloqueado}
                        title={bloqueado ? gate.motivo ?? undefined : undefined}
                        className={cn('w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors',
                          bloqueado && 'opacity-50 cursor-not-allowed',
                          form.recordingMode === m.value ? 'border-[hsl(var(--primary)_/_0.5)] bg-[hsl(var(--primary)_/_0.06)]' : 'border-border hover:bg-[hsl(var(--accent))]')}>
                        <div className={cn('w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0',
                          form.recordingMode === m.value ? 'border-[hsl(var(--primary))]' : 'border-muted-foreground/40')}>
                          {form.recordingMode === m.value && <div className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--primary))]" />}
                        </div>
                        <div>
                          <div className="text-[12.5px] font-medium">{rotulo}</div>
                          <div className="text-[10px] text-muted-foreground">{descricao}</div>
                        </div>
                      </button>
                      );
                    })}
                  </div>
                  {form.recordingMode === 'object' && (
                    <SeletorDeClassesDeGravacao
                      classes={form.recordingObjectClasses}
                      onChange={(classes) => upd('recordingObjectClasses', classes)}
                      classesLiberadas={classesLiberadas}
                    />
                  )}
                  <Separator />
                    {/* ── O NÚMERO SÓ VALE SE A CÂMERA NÃO SEGUIR O GRUPO ──────────
                        Relatado em 25/08/2026: "coloquei 3 dias e apliquei em
                        todas; depois fui na câmera e consigo colocar 7
                        tranquilamente". Conseguia digitar — e não tinha efeito
                        nenhum. Esta tela salvava o número e NÃO enviava o
                        interruptor, então a câmera seguia o grupo e o sistema
                        seguia apagando aos 3 dias.

                        Num sistema de segurança isso é alguém acreditar que tem
                        7 dias de prova e ter 3. A tela da câmera (CameraDetailPage)
                        já tinha o interruptor; esta ficou para trás. */}
                    <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Seguir a retenção do grupo</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {form.retentionFollowsGroup
                            ? (form.grupoRetentionDays
                                ? `Guardando ${form.grupoRetentionDays} dias, definidos no grupo.`
                                : 'Sem grupo: vale o prazo padrão do sistema.')
                            : 'Desligado: esta câmera usa o prazo próprio abaixo.'}
                        </p>
                      </div>
                      <Switch
                        checked={form.retentionFollowsGroup}
                        onCheckedChange={(v) => upd('retentionFollowsGroup', v)}
                        aria-label="Seguir a retenção do grupo"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="Retenção (dias)">
                        <Input
                          type="number"
                          min={1}
                          value={form.retentionDays}
                          disabled={form.retentionFollowsGroup}
                          onChange={(e) => upd('retentionDays', e.target.value)}
                          className="text-sm font-mono disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </FormField>
                    <FormField label="Codec de gravação">
                      <Select value={form.recordingVideoCodec} onValueChange={(v) => upd('recordingVideoCodec', v)}>
                        <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CODECS.map((c) => <SelectItem key={c} value={c} className="text-sm uppercase">{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                </TabsContent>

              </Tabs>

              {/* Avançado + Danger zone */}
              <div className="px-5 pb-5 space-y-4">
                <Separator />
                <details className="space-y-3">
                  <summary className="cursor-pointer text-sm font-medium">Ajustes do equipamento (instalador)</summary>
                  <p className="text-xs text-muted-foreground">Altere somente com orientação do responsável pela instalação. Campos opcionais em branco mantêm a escolha automática.</p>
                  <div className="grid grid-cols-2 gap-3">
                    {equipmentFields.filter(([key]) => !modoPush || /^(streamBitrate|recording(?:Width|Height|Fps|Bitrate))/.test(key)).map(([key, label, min]) =>
                      <FormField key={key} label={label}><Input aria-label={label} type="number" min={min} value={form[key]} onChange={e => upd(key, e.target.value)} placeholder="Automático" /></FormField>)}
                    {!modoPush && <>
                      <FormField label="Caminho ONVIF"><Input aria-label="Caminho ONVIF" value={form.onvifPath} onChange={e => upd('onvifPath', e.target.value)} /></FormField>
                      <FormField label="Identificador do perfil ONVIF"><Input aria-label="Identificador do perfil ONVIF" value={form.onvifProfileToken} onChange={e => upd('onvifProfileToken', e.target.value)} /></FormField>
                    </>}
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  {[['playback', 'Ver gravações'], ['perimetro', 'Editar perímetro'], ['ptz', 'Controle da câmera'], ['alarms', 'Ver ocorrências']].map(([page, label]) =>
                    <Button key={page} size="sm" variant="outline" onClick={() => close(`/${page}?cameraId=${encodeURIComponent(camera.id)}`)}><ExternalLink className="mr-1 h-3 w-3" />{label}</Button>)}
                </div>

                <details>
                <summary className="cursor-pointer text-xs text-muted-foreground py-2">Remover câmera</summary>
                {!confirmDelete ? (
                  <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="w-3.5 h-3.5 mr-2" /> Remover câmera
                  </Button>
                ) : (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-3">
                    <p className="text-[12px] font-medium text-destructive">Remover {camera.name}?</p>
                    <p className="text-[11px] text-muted-foreground">As gravações existentes seguem a política de retenção.</p>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancelar</Button>
                      <Button variant="destructive" size="sm" onClick={() => void handleDelete()}>
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Confirmar
                      </Button>
                    </div>
                  </div>
                )}
                </details>
              </div>
            </fieldset>

            <SheetFooter className="px-5 py-3 border-t border-border shrink-0 flex-row gap-2">
              <Button variant="ghost" size="sm" onClick={() => close()} disabled={saving || ingestBusy}>Cancelar</Button>
              <Button size="sm" onClick={() => void handleSave()} disabled={!dirty || saving || ingestBusy} className="ml-auto min-w-[140px]">
                {saving ? <LoaderCircle className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-2" />}
                Salvar alterações
              </Button>
            </SheetFooter>
          </>
        )}
        <AlertDialog open={pendingClose !== null} onOpenChange={value => { if (!value) setPendingClose(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>Descartar as alterações?</AlertDialogTitle><AlertDialogDescription>As alterações que ainda não foram salvas serão perdidas. Ações de publicação já confirmadas não serão desfeitas.</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>Continuar editando</AlertDialogCancel><AlertDialogAction onClick={() => { const destination = pendingClose ?? ''; setPendingClose(null); finishClose(destination); }}>Descartar e sair</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {/* Confirmação da troca de modo: apagar a chave de publicação para uma
            câmera em campo é irreversível pelo lado do equipamento. */}
        {confirmarVoltarRtsp && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div role="alertdialog" aria-modal="true" className="w-full rounded-xl border border-[hsl(var(--destructive)_/_0.4)] bg-card p-4 shadow-xl">
              <h3 className="text-sm font-semibold text-[hsl(var(--destructive))]">
                Voltar a buscar o vídeo na câmera?
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">
                A <b>chave de publicação será apagada</b>. Se esta câmera já está instalada em campo
                enviando vídeo (4G/CGNAT), ela <b>para de transmitir imediatamente</b> — e a chave não
                volta: seria preciso gerar outra e reconfigurar o equipamento no local.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" onClick={() => setConfirmarVoltarRtsp(false)}>Cancelar</Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={ingestBusy}
                  onClick={() => { setConfirmarVoltarRtsp(false); void desativarPush(); }}
                >
                  Apagar a chave e voltar
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function FormField({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      {children}
    </div>
  );
}

function ToggleRow({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <div>
        <div className="text-[12.5px] font-medium">{label}</div>
        <div className="text-[10px] text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Campo somente-leitura com botão de copiar.
 *
 * O instalador está com a câmera aberta noutra aba e precisa transportar estes
 * valores sem errar um caractere — uma chave de 32 hexadecimais digitada à mão
 * é erro garantido. Fonte monoespaçada e botão de copiar, nada além disso.
 */
function CampoCopiavel({
  rotulo,
  valor,
  hint,
  copiado,
  onCopiar,
}: {
  rotulo: string;
  valor: string;
  hint?: string;
  copiado: boolean;
  onCopiar: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {rotulo}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          value={valor}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="h-9 flex-1 text-[11px] font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCopiar}
          disabled={!valor}
          className="h-9 w-9 shrink-0 p-0"
          aria-label={`Copiar ${rotulo}`}
        >
          {copiado ? <Check className="h-3.5 w-3.5 text-[hsl(var(--status-online))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
