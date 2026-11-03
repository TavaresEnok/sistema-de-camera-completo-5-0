import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Bike,
  Brain,
  Bus,
  CarFront,
  Check,
  Loader2,
  Save,
  Search,
  ShieldCheck,
  Spline,
  UserRound,
} from 'lucide-react';
import { DetectionZonesEditor, type DetectionZone } from './DetectionZonesEditor';
import { getApiBaseUrl } from '../lib/api-base';
import { getRequestErrorMessage } from '../lib/request-error';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { toast } from '../hooks/use-toast';
import { AiConfidenceControl } from './AiConfidenceControl';

const API_URL = getApiBaseUrl();

export type CameraDaConfiguracaoDaIa = {
  cameraId: string;
  nome: string;
  roda: boolean;
  explicacao: string;
  objectMode: 'auto' | 'sempre' | 'nunca';
  aiEnabled: boolean;
  aiObjectClasses: string[];
  aiSensitivity: 'sensitive' | 'balanced' | 'precise';
  aiConfidence: number;
  recordingMode: string;
  motionTrigger: string;
  temLinha: boolean;
};

type Draft = Pick<CameraDaConfiguracaoDaIa, 'objectMode' | 'aiEnabled' | 'aiObjectClasses' | 'aiConfidence'>;

const CLASSES: Record<string, { nome: string; Icone: typeof UserRound }> = {
  person: { nome: 'Pessoas', Icone: UserRound },
  car: { nome: 'Carros', Icone: CarFront },
  motorcycle: { nome: 'Motos', Icone: Bike },
  bicycle: { nome: 'Bicicletas', Icone: Bike },
  bus: { nome: 'Ônibus', Icone: Bus },
  truck: { nome: 'Caminhões', Icone: CarFront },
};

function resumoDeZonas(zonas: DetectionZone[]) {
  const areas = zonas.filter((z) => z.kind === 'include').length;
  const ignoradas = zonas.filter((z) => z.kind === 'exclude').length;
  const linhas = zonas.filter((z) => z.kind === 'line').length;
  if (!zonas.length) return 'Cena inteira';
  return [
    areas ? `${areas} área${areas > 1 ? 's' : ''}` : '',
    ignoradas ? `${ignoradas} ignorada${ignoradas > 1 ? 's' : ''}` : '',
    linhas ? `${linhas} linha${linhas > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
}

export function ConfiguracaoFacilDaIa({
  camerasDaIa,
  classesPermitidas,
  onRecarregar,
}: {
  camerasDaIa: CameraDaConfiguracaoDaIa[];
  classesPermitidas: string[];
  onRecarregar: () => Promise<void> | void;
}) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const cameras = useVmsDataStore((s) => s.cameras);
  const carregarCameras = useVmsDataStore((s) => s.load);
  const client = useMemo(() => axios.create({
    baseURL: API_URL,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    timeout: 20_000,
  }), [accessToken]);
  const [busca, setBusca] = useState('');
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [desenhando, setDesenhando] = useState(false);

  const lista = useMemo(() => camerasDaIa.filter((c) => c.nome.toLowerCase().includes(busca.trim().toLowerCase())), [busca, camerasDaIa]);
  const camera = camerasDaIa.find((c) => c.cameraId === selecionada) ?? camerasDaIa[0] ?? null;
  const cameraStore = cameras.find((c) => c.id === camera?.cameraId);
  const zonas = (cameraStore?.detectionZones ?? []) as DetectionZone[];
  // A lista pode ficar vazia durante o primeiro cadastro ou uma recuperação de
  // rede. A tela vazia precisa continuar utilizável, sem tentar acessar campos
  // de uma câmera inexistente.
  const iaObrigatoria = Boolean(camera && (
    camera.recordingMode === 'object'
    || (camera.recordingMode === 'motion' && camera.motionTrigger !== 'CAMERA')
  ));

  useEffect(() => {
    if (!camera) return;
    if (!selecionada) setSelecionada(camera.cameraId);
    setDraft({
      objectMode: camera.objectMode,
      aiEnabled: camera.aiEnabled,
      aiObjectClasses: camera.aiObjectClasses.length ? camera.aiObjectClasses : [...classesPermitidas],
      aiConfidence: Math.max(55, Math.min(90, Math.round(Number(camera.aiConfidence) || 70))),
    });
  }, [camera?.cameraId, camera?.objectMode, camera?.aiEnabled, camera?.aiConfidence, camera?.aiObjectClasses.join('|'), classesPermitidas.join('|')]);

  if (desenhando && camera) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <button type="button" className="btn btn-secondary btn-sm mb-3" onClick={() => setDesenhando(false)}>
          Voltar à configuração
        </button>
        <DetectionZonesEditor
          cameraId={camera.cameraId}
          cameraName={camera.nome}
          initialZones={zonas}
          onSaved={() => {
            void carregarCameras();
            void onRecarregar();
          }}
        />
      </div>
    );
  }

  const alternarClasse = (classe: string) => {
    if (!draft) return;
    const tem = draft.aiObjectClasses.includes(classe);
    if (tem && draft.aiObjectClasses.length === 1) {
      toast({ title: 'Escolha ao menos um tipo', description: 'Para desligar a procura de objetos, use a opção “Desligado”.' });
      return;
    }
    setDraft({
      ...draft,
      aiObjectClasses: tem
        ? draft.aiObjectClasses.filter((c) => c !== classe)
        : [...draft.aiObjectClasses, classe],
    });
  };

  const salvar = async () => {
    if (!camera || !draft) return;
    if (camera.recordingMode === 'object' && draft.objectMode === 'nunca') {
      toast({ title: 'Esta câmera grava por objeto', description: 'A procura de objetos precisa permanecer ativa para a gravação funcionar.', variant: 'destructive' });
      return;
    }
    setSalvando(true);
    try {
      await client.patch(`/cameras/${camera.cameraId}`, draft);
      await Promise.all([onRecarregar(), carregarCameras()]);
      toast({ title: 'Configuração salva', description: `${camera.nome} já recebeu a nova política de IA.` });
    } catch (e) {
      toast({ title: 'Não foi possível salvar', description: getRequestErrorMessage(e, 'Falha ao atualizar a IA da câmera.'), variant: 'destructive' });
    } finally {
      setSalvando(false);
    }
  };

  if (!camera || !draft) {
    return <div className="p-10 text-center text-xs text-[hsl(var(--muted-foreground))]">Nenhuma câmera disponível.</div>;
  }

  const iaLigada = draft.aiEnabled && draft.objectMode !== 'nunca';
  const alternarIa = () => {
    const ligar = !iaLigada;
    setDraft({
      ...draft,
      aiEnabled: ligar,
      // A escolha técnica fica interna: para o operador, ligar significa que a
      // câmera deve analisar; desligar significa que não deve.
      objectMode: ligar ? 'sempre' : 'nunca',
    });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex min-h-[160px] flex-col border-b border-border bg-[hsl(var(--card))] lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="border-b border-border p-3">
          <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5">
            <Search className="h-3.5 w-3.5 text-[hsl(var(--muted-foreground))]" aria-hidden />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar câmera" className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
          </label>
        </div>
        <div className="min-h-0 overflow-y-auto p-2">
          {lista.map((item) => (
            <button
              key={item.cameraId}
              type="button"
              onClick={() => setSelecionada(item.cameraId)}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left ${item.cameraId === camera.cameraId ? 'bg-[hsl(var(--primary)_/_0.12)] text-foreground' : 'hover:bg-[hsl(var(--muted)_/_0.55)]'}`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${item.roda ? 'bg-[hsl(var(--status-online))]' : 'bg-[hsl(var(--muted-foreground))]'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{item.nome}</span>
                <span className="block truncate text-[10px] text-[hsl(var(--muted-foreground))]">{item.roda ? 'Analisando' : 'Em espera'}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-5">
          <header className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--primary)_/_0.12)] text-[hsl(var(--primary))]"><Brain className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{camera.nome}</h2>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                {iaLigada ? 'Detecção de objetos ativa' : 'Detecção de objetos desligada'}
              </p>
            </div>
            <button
              type="button"
              onClick={alternarIa}
              disabled={iaObrigatoria}
              className={`relative h-7 w-12 rounded-full transition-colors ${iaLigada ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted))]'}`}
              aria-pressed={iaLigada}
              aria-label="Ativar ou desativar a IA nesta câmera"
            >
              <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${iaLigada ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
            <span className="text-xs font-medium">
              {iaObrigatoria ? 'Obrigatória para gravar' : iaLigada ? 'Ativa' : 'Desligada'}
            </span>
          </header>

          <section className={`rounded-lg border border-border bg-card ${!iaLigada ? 'pointer-events-none opacity-50' : ''}`}>
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-medium">O que identificar</h3>
              <p className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                Escolha entre os tipos liberados pelo painel central.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              {classesPermitidas.map((classe) => {
                const cfg = CLASSES[classe] ?? { nome: classe, Icone: ShieldCheck };
                const marcado = draft.aiObjectClasses.includes(classe);
                return (
                  <button key={classe} type="button" onClick={() => alternarClasse(classe)} aria-pressed={marcado}
                    className={`flex min-w-[125px] items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${marcado ? 'border-[hsl(var(--primary)_/_0.55)] bg-[hsl(var(--primary)_/_0.10)]' : 'border-border hover:bg-[hsl(var(--muted)_/_0.4)]'}`}>
                    <cfg.Icone className={`h-4 w-4 ${marcado ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground))]'}`} />
                    <span className="text-xs font-medium">{cfg.nome}</span>
                    {marcado && <Check className="ml-auto h-3.5 w-3.5 text-[hsl(var(--primary))]" />}
                  </button>
                );
              })}
              {!classesPermitidas.length && <p className="text-xs text-[hsl(var(--muted-foreground))]">A instalação ainda não possui classes de objeto liberadas.</p>}
            </div>
          </section>

          <div className={`grid gap-4 xl:grid-cols-2 ${!iaLigada ? 'pointer-events-none opacity-50' : ''}`}>
            <section className="rounded-lg border border-border bg-card p-4">
              <AiConfidenceControl value={draft.aiConfidence} label="Confiança mínima para confirmar a detecção"
                sharedWithRecording={camera.recordingMode === 'object'}
                onChange={value => setDraft({ ...draft, aiConfidence: value })} />
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-medium">Onde identificar</h3>
              <p className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">Use a imagem da câmera para marcar áreas e linhas.</p>
              <button type="button" onClick={() => setDesenhando(true)} className="mt-3 flex w-full items-center gap-3 rounded-lg border border-border px-3 py-3 text-left hover:bg-[hsl(var(--muted)_/_0.4)]">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[hsl(var(--primary)_/_0.10)] text-[hsl(var(--primary))]"><Spline className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">Editar áreas e linhas</span>
                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">{resumoDeZonas(zonas)}</span>
                </span>
              </button>
            </section>
          </div>

          <div className="sticky bottom-0 flex items-center justify-end border-t border-border bg-background/95 py-3 backdrop-blur">
            <button type="button" onClick={() => void salvar()} disabled={salvando} className="btn btn-primary min-w-[150px]">
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar configuração
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
