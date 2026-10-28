import { useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Copy, Check, Radio, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useAuthStore } from '../store/authStore';
import { toast } from '../hooks/use-toast';
import { getApiBaseUrl } from '../lib/api-base';
import { capturarLocalizacaoDoInstalador } from '../lib/localizacao-do-instalador';
import { CameraDetectionNotices } from './CameraDetectionNotices';
import { useClassesLiberadas } from '../hooks/use-classes-liberadas';
import { CameraPrivacyFields } from './CameraPrivacyFields';
import { cameraPrivacyError, cameraPrivacyPayload, emptyCameraPrivacy } from '../lib/camera-privacy';

// ── CADASTRO DE CÂMERA QUE PUBLICA ─────────────────────────────────────────
//
// Por que não é um passo dentro do assistente normal: aquele fluxo existe para
// TESTAR A CONEXÃO — descobre perfis, sonda o stream, mede codec e resolução.
// No modo push não há nada disso para fazer, porque a câmera ainda não falou
// conosco e talvez só vá falar amanhã, quando o instalador terminar o serviço.
//
// São dois fluxos genuinamente diferentes, e forçá-los na mesma tela obrigaria
// o instalador a inventar IP, porta, usuário e senha só para vencer a validação
// — cadastro sujo por desenho, que ninguém saberia interpretar meses depois.
//
// Aqui só se pede o nome. Local, área e o resto da configuração ficam para a
// edição da câmera, depois que ela existir — no momento do cadastro o que o
// instalador precisa é da chave, e ela sai pronta na mesma tela.

type PendingIngest = {
  path: string;
  remoteAddr: string | null;
  attempts: number;
};

type RtmpTarget = {
  serverUrl: string;
  streamKey: string;
  fullUrl: string;
  canonicalFullUrl?: string;
  compactFullUrl?: string | null;
  fullUrlFitsSingleField?: boolean;
  singleFieldMaxLength?: number;
};

export function AddPushCameraDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [nome, setNome] = useState('');
  const [privacy, setPrivacy] = useState(emptyCameraPrivacy);
  const [notices, setNotices] = useState({ motionNoticeEnabled: false, objectNoticeEnabled: false, noticeSoundEnabled: false, noticeSound: 'attention', noticeDurationSeconds: 10, objectNoticeClasses: [] as string[] });
  const { classes: allowed, motionAllowed, carregando: loadingCapabilities } = useClassesLiberadas();
  const [salvando, setSalvando] = useState(false);
  const [copiado, setCopiado] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<RtmpTarget | null>(null);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [pendentes, setPendentes] = useState<PendingIngest[]>([]);
  const [vinculando, setVinculando] = useState<string | null>(null);
  const [caminhoManual, setCaminhoManual] = useState('');
  const usaEnderecoCompacto = Boolean(alvo?.canonicalFullUrl && alvo.fullUrl !== alvo.canonicalFullUrl);
  const urlCompletaCompativel = alvo?.fullUrlFitsSingleField !== false;

  useEffect(() => {
    if (!open || !alvo || !cameraId || !accessToken) return;
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
  }, [open, alvo, cameraId, accessToken]);

  const fechar = () => {
    if (salvando || vinculando) return;
    setPrivacy(emptyCameraPrivacy());
    setNotices({ motionNoticeEnabled: false, objectNoticeEnabled: false, noticeSoundEnabled: false, noticeSound: 'attention', noticeDurationSeconds: 10, objectNoticeClasses: [] });
    setNome(''); setAlvo(null); setCopiado(null); setCameraId(null); setPendentes([]); setCaminhoManual('');
    onClose();
  };

  const copiar = async (texto: string, marca: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(marca);
      window.setTimeout(() => setCopiado((c) => (c === marca ? null : c)), 1800);
    } catch {
      toast({ title: 'Não foi possível copiar', description: 'Selecione e copie manualmente.', variant: 'destructive' });
    }
  };

  const criar = async () => {
    if (!accessToken || !nome.trim() || salvando) return;
    const privacyError = cameraPrivacyError(privacy);
    if (privacyError) { toast({ title: 'Confira a privacidade', description: privacyError, variant: 'destructive' }); return; }
    setSalvando(true);
    try {
      const localizacaoDoInstalador = await capturarLocalizacaoDoInstalador();
      const { data } = await axios.post(
        `${getApiBaseUrl()}/cameras`,
        {
          name: nome.trim(),
          ...cameraPrivacyPayload(privacy),
          sourceMode: 'rtmp_push',
          // RTMP nasce cadastrada, mas sem consumir armazenamento. A gravação
          // só é armada depois, conscientemente, na página de Gravações.
          recordingEnabled: false,
          recordingMode: 'manual',
          ...notices,
          ...(localizacaoDoInstalador ?? {}),
        },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!data?.rtmpIngest?.streamKey) {
        throw new Error('A câmera foi criada, mas a chave não veio. Abra a câmera e gere pela edição.');
      }
      setAlvo(data.rtmpIngest);
      setCameraId(data.id ?? null);
      // Verifica conexões de equipamentos que usam um caminho próprio.
      // Mostrar aqui evita mandar o instalador procurar noutra tela.
      await axios
        .get(`${getApiBaseUrl()}/cameras/rtmp-ingest/pending`, { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(({ data: lista }) => setPendentes(lista?.items ?? []))
        .catch(() => undefined);
      await onCreated();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.message ?? err.message)
        : err instanceof Error ? err.message : 'Tente novamente.';
      toast({ title: 'Falha ao cadastrar', description: String(msg), variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  };

  const vincular = async (path: string) => {
    if (!accessToken || !cameraId) return;
    setVinculando(path);
    try {
      await axios.post(
        `${getApiBaseUrl()}/cameras/${cameraId}/rtmp-ingest/bind`,
        { path },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      setPendentes([]);
      setCaminhoManual('');
      toast({
        title: 'Equipamento vinculado',
        description: 'O vídeo dele passa a entrar como esta câmera em até um minuto.',
      });
      await onCreated();
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.message ?? err.message) : 'Tente novamente.';
      toast({ title: 'Falha ao vincular', description: String(msg), variant: 'destructive' });
    } finally {
      setVinculando(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) fechar(); }}>
      <DialogContent className="responsive-form flex max-h-[calc(100dvh-24px)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex items-center gap-2 text-base leading-snug">
            <Radio className="h-4 w-4 shrink-0" />
            {alvo ? 'Conectar câmera' : 'Gerar link para câmera'}
          </DialogTitle>
        </DialogHeader>

        {!alvo ? (
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain py-1 pr-1">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Dê um nome à câmera para gerar o link. Depois, cole esse link nas configurações RTMP da câmera ou do DVR.
            </p>

            <div className="space-y-1.5">
              <Label className="text-[11px] font-medium text-muted-foreground">
                Nome da câmera<span className="ml-0.5 text-destructive">*</span>
              </Label>
              <Input
                autoFocus
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && nome.trim()) void criar(); }}
                placeholder="Portaria — Loja Centro"
                className="text-sm"
              />
            </div>

            <fieldset disabled={salvando}><CameraPrivacyFields value={privacy} onChange={setPrivacy} /></fieldset>
            <CameraDetectionNotices motion={notices.motionNoticeEnabled} object={notices.objectNoticeEnabled} sound={notices.noticeSoundEnabled} soundType={notices.noticeSound} duration={notices.noticeDurationSeconds} classes={notices.objectNoticeClasses}
              allowed={allowed} motionAllowed={motionAllowed} loading={loadingCapabilities} onChange={setNotices} />
          </div>
        ) : (
          <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain py-1 pr-1">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Cole o link abaixo em <span className="font-medium text-foreground">Rede → RTMP</span> na câmera ou no DVR.
              Ao receber o vídeo, ele aparecerá na grade.
            </p>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-[11px] font-semibold text-amber-500">Intelbras/Positivo: selecione Personalizado</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Cole o link completo em <strong className="text-foreground">Endereço personalizado</strong>.
                Não use “Não personalizado”.
              </p>
            </div>
            {usaEnderecoCompacto && (
              <p className="text-[11px] text-muted-foreground">Link curto, compatível com o limite de {alvo.singleFieldMaxLength ?? 63} caracteres da câmera.</p>
            )}
            {urlCompletaCompativel ? (
              <Campo
                rotulo="Link para conectar a câmera"
                valor={alvo.fullUrl}
                hint={`até ${alvo.singleFieldMaxLength ?? 63} caracteres`}
                copiado={copiado === 'f'}
                onCopiar={() => copiar(alvo.fullUrl, 'f')}
              />
            ) : (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-[11px] font-semibold text-amber-500">A URL completa não cabe neste tipo de câmera</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  Não recorte a chave. Use os campos separados abaixo ou configure a câmera por IP e porta no modo não personalizado.
                </p>
              </div>
            )}
            <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-medium">Equipamento com campos Servidor + Chave</summary>
              <div className="mt-3 space-y-3">
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Use somente se o equipamento tiver dois campos reais. “Não personalizado” com IP/porta não é equivalente.
                </p>
                <Campo rotulo="Servidor RTMP" valor={alvo.serverUrl} copiado={copiado === 's'} onCopiar={() => copiar(alvo.serverUrl, 's')} />
                <Campo rotulo="Chave do stream" valor={alvo.streamKey} copiado={copiado === 'k'} onCopiar={() => copiar(alvo.streamKey, 'k')} />
              </div>
            </details>
            {pendentes.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-[11px] font-semibold">
                    Equipamentos encontrados
                  </p>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Selecione abaixo o equipamento desta câmera. Se o vídeo não aparecer, confira o link nas configurações RTMP.
                  </p>
                  <div role="region" aria-label="Equipamentos encontrados" tabIndex={0} className="max-h-48 space-y-2 overflow-y-auto overscroll-contain pr-1">
                  {pendentes.map((p) => (
                    <div key={p.path} className="flex items-center gap-2 rounded-md border border-border bg-background/70 p-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[11px]">{p.path}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {p.remoteAddr ?? 'Endereço não informado'}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={vinculando !== null}
                        onClick={() => void vincular(p.path)}
                        className="h-8 shrink-0 gap-1.5 text-[11px]"
                      >
                        {vinculando === p.path && <LoaderCircle className="h-3 w-3 animate-spin" />}
                        Selecionar
                      </Button>
                    </div>
                  ))}
                  </div>
                </div>
              </>
            )}
            <Separator />
            <details className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <summary className="cursor-pointer text-[11px] font-semibold">Configuração avançada: caminho da câmera</summary>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Use apenas se o equipamento enviar vídeo por um caminho diferente do link gerado.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={caminhoManual}
                  onChange={(e) => setCaminhoManual(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && caminhoManual.trim() && vinculando === null) {
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
                  disabled={vinculando !== null || !caminhoManual.trim()}
                  onClick={() => void vincular(caminhoManual.trim())}
                  className="h-9 shrink-0 text-[11px]"
                >
                  {vinculando === caminhoManual.trim() && <LoaderCircle className="mr-1.5 h-3 w-3 animate-spin" />}
                  Vincular caminho
                </Button>
              </div>
            </details>
            <Separator />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Não compartilhe este link. Copie-o completo, sem cortar nenhuma parte.
            </p>
          </div>
        )}

        <DialogFooter className="shrink-0">
          {!alvo ? (
            <>
              <Button variant="ghost" onClick={fechar} disabled={salvando} className="text-sm">Cancelar</Button>
              <Button onClick={() => void criar()} disabled={salvando || !nome.trim()} className="gap-1.5 text-sm">
                {salvando ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Cadastrar e gerar chave
              </Button>
            </>
          ) : (
            <Button onClick={fechar} className="text-sm">Concluir</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Campo({
  rotulo, valor, hint, copiado, onCopiar,
}: { rotulo: string; valor: string; hint?: string; copiado: boolean; onCopiar: () => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-medium text-muted-foreground">
        {rotulo}
        {hint && <span className="ml-1 text-[10px] font-normal opacity-60">({hint})</span>}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input value={valor} readOnly onFocus={(e) => e.currentTarget.select()} className="h-9 flex-1 font-mono text-[11px]" />
        <Button type="button" variant="outline" size="sm" onClick={onCopiar} className="h-9 w-9 shrink-0 p-0" aria-label={`Copiar ${rotulo}`}>
          {copiado ? <Check className="h-3.5 w-3.5 text-[hsl(var(--status-online))]" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
