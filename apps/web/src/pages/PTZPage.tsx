import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  Crosshair,
  LoaderCircle,
  Radar,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  ExternalLink,
} from 'lucide-react';
import { SeletorDeCamera } from '../components/SeletorDeCamera';
import { toast } from '../hooks/use-toast';
import { LiveStreamPlayer } from '../components/LiveStreamPlayer';
import { getApiBaseUrl } from '../lib/api-base';
import { sendPtzCommand, type PTZDirection } from '../lib/ptz';
import { useAuthStore } from '../store/authStore';
import { PosicoesDaCamera } from '../components/PosicoesDaCamera';
import { useVmsDataStore } from '../store/vmsDataStore';

type CommandState = 'idle' | 'sending' | 'ok' | 'error';
const API_URL = getApiBaseUrl();
const DIRECTION_LABEL: Record<PTZDirection, string> = {
  Up: 'cima',
  Down: 'baixo',
  Left: 'esquerda',
  Right: 'direita',
  ZoomIn: 'aproximar',
  ZoomOut: 'afastar',
};
type PtzDiagnostics = {
  cameraId: string;
  ip: string;
  configured: {
    onvifPort: number | null;
    onvifPath: string | null;
    onvifProfileToken: string | null;
    channel: number | null;
  };
  detected: {
    ok: boolean;
    onvifPort: number | null;
    onvifPath: string | null;
    onvifProfileToken: string | null;
  };
  ptzLikelyWorking: boolean;
};

type PtzTestResult = {
  sucesso: boolean;
  titulo: string;
  detalhe: string;
};

function ControlButton({
  label,
  icon,
  active,
  disabled,
  onActivate,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onActivate}
      className={[
        'flex h-12 w-12 items-center justify-center rounded-xl border transition-all select-none',
        active
          ? 'border-[hsl(var(--primary)_/_0.55)] bg-[hsl(var(--primary)_/_0.14)] text-[hsl(var(--primary))] shadow-[0_0_0_1px_hsl(var(--primary)_/_0.18)]'
          : 'border-border bg-card/70 text-[hsl(var(--muted-foreground))] hover:border-[hsl(var(--primary)_/_0.35)] hover:bg-[hsl(var(--primary)_/_0.06)] hover:text-foreground',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      ].join(' ')}
    >
      {icon}
    </button>
  );
}

export default function PTZPage() {
  const [location, setLocation] = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const userRole = useAuthStore((state) => state.user?.role ?? 'viewer');
  const cameras = useVmsDataStore((state) => state.cameras);
  const ptzCameras = useMemo(
    () => cameras
      .filter((camera) => camera.enabled)
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name, 'pt-BR')),
    [cameras],
  );
  const [selectedCamId, setSelectedCamId] = useState('');
  const [angleDegrees, setAngleDegrees] = useState(5);
  const [activeDirection, setActiveDirection] = useState<PTZDirection | null>(null);
  const [commandState, setCommandState] = useState<CommandState>('idle');
  const [lastCommand, setLastCommand] = useState<string>('Nenhum comando enviado');
  const [lastError, setLastError] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PtzDiagnostics | null>(null);
  const [cameraParaTestar, setCameraParaTestar] = useState('');
  const [testando, setTestando] = useState(false);
  const [resultadoDoTeste, setResultadoDoTeste] = useState<PtzTestResult | null>(null);
  const activeMovementRef = useRef<{ cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> } | null>(null);

  const candidatas = useMemo(
    () => cameras
      .filter((camera) => camera.enabled)
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name, 'pt-BR')),
    [cameras],
  );

  const situacaoDeDeteccao = useCallback((_camera: typeof cameras[number]) => ({
    podeTestar: true,
    motivo: 'A verificação consulta o canal de controle da câmera. Vídeo e PTZ usam conexões diferentes.',
  }), []);

  const requestedCameraId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('cameraId');
  }, [location]);

  useEffect(() => {
    if (!ptzCameras.length) {
      setSelectedCamId('');
      return;
    }

    if (requestedCameraId && ptzCameras.some((camera) => camera.id === requestedCameraId)) {
      setSelectedCamId((current) => (current === requestedCameraId ? current : requestedCameraId));
      return;
    }

    if (!selectedCamId || !ptzCameras.some((camera) => camera.id === selectedCamId)) {
      setSelectedCamId(ptzCameras[0].id);
    }
  }, [ptzCameras, requestedCameraId, selectedCamId]);

  const selectedCam = ptzCameras.find((camera) => camera.id === selectedCamId) ?? null;
  // RTMP é enviado pela câmera ao servidor, enquanto PTZ volta pelo canal
  // HTTP/ONVIF. O estado de um não prova o estado do outro.
  const controlsDisabled = !selectedCam;
  const requestedCameraUnavailable = Boolean(
    requestedCameraId && !ptzCameras.some((camera) => camera.id === requestedCameraId),
  );
  const startMove = useCallback(
    async (direction: PTZDirection) => {
      if (!selectedCam || controlsDisabled || activeMovementRef.current) return;
      const movement = { cameraId: selectedCam.id, cameraName: selectedCam.name, direction } as { cameraId: string; cameraName: string; direction: PTZDirection; startPromise?: ReturnType<typeof sendPtzCommand> };
      activeMovementRef.current = movement;
      setActiveDirection(direction);
      setCommandState('sending');
      setLastError(null);
      setLastCommand(`Enviando comando para ${DIRECTION_LABEL[direction]} em ${selectedCam.name}`);

      try {
        movement.startPromise = sendPtzCommand(selectedCam.id, { action: 'step', direction, angleDegrees });
        await movement.startPromise;
        if (activeMovementRef.current === movement) {
          activeMovementRef.current = null;
          setActiveDirection(null);
          setCommandState('ok');
          setLastCommand(`Ajuste para ${DIRECTION_LABEL[direction]} aplicado em ${selectedCam.name}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Falha ao iniciar comando PTZ.';
        if (activeMovementRef.current === movement) {
          activeMovementRef.current = null;
          setActiveDirection(null);
        }
        setCommandState('error');
        setLastError(message);
        setLastCommand(`Falha ao mover para ${DIRECTION_LABEL[direction]} em ${selectedCam.name}`);
        toast({ title: 'Movimento não disponível', description: message });
      }
    },
    [angleDegrees, controlsDisabled, selectedCam],
  );

  const stopMove = useCallback(async () => {
    const movement = activeMovementRef.current;
    if (!movement) return;
    activeMovementRef.current = null;
    const currentDirection = movement.direction;
    setActiveDirection(null);
    setCommandState('sending');

    try {
      // Ação explícita de emergência: não espere o passo terminar para parar.
      await sendPtzCommand(movement.cameraId, { action: 'stop', direction: currentDirection });
      setCommandState('ok');
      setLastError(null);
      setLastCommand(`Movimento para ${DIRECTION_LABEL[currentDirection]} finalizado em ${movement.cameraName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao parar movimento PTZ.';
      setCommandState('error');
      setLastError(message);
      setLastCommand(`Falha ao parar movimento para ${DIRECTION_LABEL[currentDirection]} em ${movement.cameraName}`);
      toast({ title: 'O controle não confirmou a parada', description: message });
    }
  }, []);

  const runDiagnostics = useCallback(async () => {
    if (!selectedCam || !accessToken) return;
    setDiagnosing(true);
    try {
      const response = await fetch(`${API_URL}/ptz/${selectedCam.id}/diagnostics`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error('Não foi possível consultar a câmera agora.');
      const data = (await response.json()) as PtzDiagnostics;
      setDiagnostics(data);
      toast({
        title: data.ptzLikelyWorking ? 'Controle PTZ pronto' : 'Controle PTZ indisponível',
        description: data.ptzLikelyWorking
          ? 'A câmera aceitou o controle externo.'
          : 'Não foi possível confirmar o controle externo desta câmera.',
        variant: data.ptzLikelyWorking ? undefined : 'destructive',
      });
    } catch (error) {
      toast({
        title: 'Não foi possível verificar o PTZ',
        description: 'A câmera não respondeu à verificação. Aguarde alguns segundos e tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setDiagnosing(false);
    }
  }, [accessToken, selectedCam]);

  const testarCamera = useCallback(async () => {
    const camera = candidatas.find((item) => item.id === cameraParaTestar);
    if (!camera || !accessToken || !situacaoDeDeteccao(camera).podeTestar) return;

    setTestando(true);
    setResultadoDoTeste(null);
    try {
      const response = await fetch(`${API_URL}/ptz/${camera.id}/diagnostics`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as PtzDiagnostics;
      setResultadoDoTeste(data.ptzLikelyWorking
        ? {
          sucesso: true,
          titulo: 'Controle PTZ encontrado',
          detalhe: 'Esta câmera respondeu ao teste. Abra o painel para usar os controles.',
        }
        : {
          sucesso: false,
          titulo: 'Controle PTZ não confirmado',
          detalhe: 'Confira se a câmera possui PTZ e se a porta ONVIF ou HTTP foi configurada corretamente.',
        });
    } catch {
      setResultadoDoTeste({
        sucesso: false,
        titulo: 'Não foi possível verificar a câmera',
        detalhe: 'Confira a conexão da câmera e tente novamente.',
      });
    } finally {
      setTestando(false);
    }
  }, [accessToken, cameraParaTestar, candidatas, situacaoDeDeteccao]);

  if (!ptzCameras.length) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card/85 text-center shadow-lg">
          <div className="border-b border-border bg-[radial-gradient(circle_at_top,hsl(var(--primary)_/_0.16),transparent_68%)] px-8 py-9">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[hsl(var(--primary)_/_0.28)] bg-[hsl(var(--primary)_/_0.10)] shadow-[0_12px_32px_hsl(var(--primary)_/_0.12)]">
              <Crosshair className="h-7 w-7 text-[hsl(var(--primary))]" />
            </div>
            <h2 className="text-lg font-semibold">Nenhuma câmera com PTZ detectado</h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              O sistema pergunta a cada câmera se ela aceita comandos de movimento e guarda a resposta.
              Só aparecem aqui as que responderam que sim.
            </p>
          </div>

          {/* A AÇÃO, no lugar do texto genérico. Antes havia dois cartões
              ("já possui uma câmera PTZ?", "câmeras fixas continuam normais")
              que não faziam nada — e a única frase específica dizia que as
              câmeras estavam "fora do ar", o que era falso para as do dono.
              Agora a tela testa a câmera que o operador escolher. */}
          <div className="border-t border-border px-8 py-6 text-left">
            <div className="text-xs font-semibold">Acha que uma câmera tem PTZ?</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Escolha e teste agora. A verificação pergunta direto ao equipamento.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={cameraParaTestar}
                onChange={(e) => { setCameraParaTestar(e.target.value); setResultadoDoTeste(null); }}
                className="h-8 min-w-[220px] flex-1 rounded border border-border bg-background px-2 text-[11px]"
                aria-label="Câmera para testar PTZ"
              >
                <option value="">Selecione uma câmera…</option>
                {candidatas.map((c) => (
                  <option key={c.id} value={c.id} disabled={!situacaoDeDeteccao(c).podeTestar}>
                    {c.name}{situacaoDeDeteccao(c).podeTestar ? '' : ' — fora do ar'}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void testarCamera()}
                disabled={!cameraParaTestar || testando}
                className="btn btn-primary btn-sm"
              >
                {testando ? 'Testando…' : 'Testar agora'}
              </button>
            </div>

            {/* O motivo de ESTA câmera, não uma frase para todas. */}
            {cameraParaTestar && !resultadoDoTeste && (() => {
              const c = candidatas.find((x) => x.id === cameraParaTestar);
              if (!c) return null;
              return (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {situacaoDeDeteccao(c).motivo}
                </p>
              );
            })()}

            {resultadoDoTeste && (
              <div className={`mt-3 rounded-lg border px-3 py-2.5 ${resultadoDoTeste.sucesso
                ? 'border-[hsl(var(--status-online)_/_0.4)] bg-[hsl(var(--status-online)_/_0.08)]'
                : 'border-border bg-[hsl(var(--muted)_/_0.4)]'}`}>
                <div className="text-[11px] font-medium">{resultadoDoTeste.titulo}</div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {resultadoDoTeste.detalhe}
                </p>
                {!resultadoDoTeste.sucesso && (
                  <button
                    type="button"
                    onClick={() => setLocation(`/cameras?${userRole === 'admin' ? 'edit' : 'cameraId'}=${encodeURIComponent(cameraParaTestar)}`)}
                    className="btn btn-secondary btn-sm mt-2"
                  >
                    Abrir cadastro desta câmera
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-center gap-2 border-t border-border px-8 py-4">
            <button type="button" onClick={() => setLocation('/live')} className="btn btn-secondary btn-sm">Voltar ao Ao Vivo</button>
            {userRole !== 'viewer' && (
              <button type="button" onClick={() => setLocation('/cameras')} className="btn btn-primary btn-sm">Ver câmeras</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
      <div className="flex h-full min-h-0 flex-col">
      <div className="toolbar flex-wrap">
        <div className="w-[min(100%,340px)]">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Câmera</div>
          <SeletorDeCamera
            cameras={ptzCameras}
            value={selectedCamId}
            onChange={setSelectedCamId}
            placeholder="Selecione uma câmera"
            className="h-10 w-full"
            vazio="Nenhuma câmera disponível."
          />
        </div>

        <div className="w-full rounded-xl border border-border bg-background/65 px-3 py-2 sm:w-auto">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--muted-foreground))]">
            Movimento por toque
          </div>
          <div className="flex gap-1" role="group" aria-label="Deslocamento aproximado por toque">
            {[2, 5, 10, 20].map((degrees) => (
              <button
                key={degrees}
                type="button"
                onClick={() => setAngleDegrees(degrees)}
                aria-pressed={angleDegrees === degrees}
                className={angleDegrees === degrees ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              >
                {degrees}°
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => selectedCam && setLocation(`/cameras?cameraId=${encodeURIComponent(selectedCam.id)}`)}
          disabled={!selectedCam}
          className="btn btn-secondary btn-sm"
        >
          Abrir painel da câmera
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => void runDiagnostics()}
          disabled={!selectedCam || diagnosing}
          className="btn btn-secondary btn-sm"
        >
          {diagnosing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Radar className="h-3.5 w-3.5" />}
          Verificar
        </button>
      </div>

      {requestedCameraUnavailable && (
        <div className="mx-4 mt-4 rounded-lg border border-[hsl(var(--status-warning)_/_0.35)] bg-[hsl(var(--status-warning)_/_0.10)] px-4 py-3 text-xs text-[hsl(var(--status-warning))] md:mx-5">
          A câmera aberta anteriormente não está disponível. Selecionamos outra câmera.
        </div>
      )}

      <div className="grid flex-1 min-h-0 gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1.35fr)_420px]">
        <div className="flex min-h-0 flex-col gap-4">
          <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border bg-[linear-gradient(160deg,hsl(222_22%_9%),hsl(220_18%_7%))] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {selectedCam ? (
              <LiveStreamPlayer
                cameraId={selectedCam.id}
                cameraName={selectedCam.name}
                className="absolute inset-0 h-full w-full"
                muted
                showOverlay
                aiEnabled={selectedCam.aiEnabled}
                liveViewMode="selected"
              />
            ) : null}

            <div className="pointer-events-none absolute inset-0 camera-scanline opacity-60" />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-24 w-24 opacity-35">
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[hsl(var(--primary))]" />
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[hsl(var(--primary))]" />
                <div className="absolute inset-5 rounded-xl border border-[hsl(var(--primary)_/_0.7)]" />
              </div>
            </div>

            {!selectedCam && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                <div className="rounded-lg border border-border bg-black/45 px-5 py-4 text-center">
                  <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-[hsl(var(--muted-foreground))]" />
                  <div className="text-sm font-medium">Stream indisponível</div>
                  <div className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    Selecione uma câmera para abrir o vídeo.
                  </div>
                </div>
              </div>
            )}

            <div className="absolute left-3 top-3 flex items-center gap-2">
              <span className="rounded-md border border-white/10 bg-black/45 px-2 py-1 text-[10px] text-white/70">
                {selectedCam?.code ?? 'SEM CAMERA'}
              </span>
              <span className="rounded-md border border-white/10 bg-black/45 px-2 py-1 text-[10px] text-white/70">
                {selectedCam?.isOnline ? 'Ao vivo' : 'Verificando vídeo'}
              </span>
              {activeDirection && (
                <span className="rounded-md border border-[hsl(var(--primary)_/_0.4)] bg-[hsl(var(--primary)_/_0.14)] px-2 py-1 font-mono text-[10px] text-[hsl(var(--primary-foreground))]">
                  {activeDirection}
                </span>
              )}
            </div>

            <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
              <div className="rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-xs text-white/78 backdrop-blur-sm">
                <div className="font-semibold">{selectedCam?.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-white/55">
                  <span>{selectedCam?.ipAddress}</span>
                  <span>•</span>
                  <span>{selectedCam?.model}</span>
                  <span>•</span>
                  <span>{selectedCam?.hasAudio ? 'Áudio' : 'Sem áudio'}</span>
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/45 px-3 py-2 text-right font-mono text-[10px] text-white/72 backdrop-blur-sm">
                <div>{selectedCam?.zone}</div>
                <div className="mt-1 text-white/45">Movimento {angleDegrees}° por toque</div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/70 p-4 shadow-sm">
            <div className="mb-1 text-[11px] text-[hsl(var(--muted-foreground))]">Status</div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              {commandState === 'sending' ? <LoaderCircle className="h-4 w-4 animate-spin text-[hsl(var(--primary))]" /> : <Radar className="h-4 w-4 text-[hsl(var(--primary))]" />}
              {commandState === 'error' ? 'Não foi possível concluir o movimento' : commandState === 'sending' ? 'Movendo a câmera' : 'Pronto'}
            </div>
            <div className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
              {commandState === 'idle' ? 'Aguardando comando.' : lastCommand}
            </div>
            {lastError && (
              <div className="mt-3 rounded-xl border border-[hsl(var(--destructive)_/_0.28)] bg-[hsl(var(--destructive)_/_0.08)] px-3 py-2 text-xs text-[hsl(var(--destructive))]">
                {lastError}
              </div>
            )}
            {diagnostics && (
              <details className="mt-3 rounded-xl border border-border bg-background/55 px-3 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                <summary className="cursor-pointer font-semibold text-foreground">Resultado da verificação</summary>
                <div className="mt-2">
                  <div>{diagnostics.ptzLikelyWorking
                    ? 'A câmera respondeu e está pronta para receber movimentos.'
                    : 'A câmera não confirmou o controle. Confira a porta ONVIF/HTTP e as credenciais no cadastro.'}</div>
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <div className="rounded-lg border border-border bg-card/75 p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Direção</div>
              </div>
              <button
                type="button"
                onClick={() => void stopMove()}
                disabled={!activeDirection}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Parar
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!selectedCam || controlsDisabled) return;
                  setCommandState('sending');
                  setLastError(null);
                  try {
                    await sendPtzCommand(selectedCam.id, { action: 'home' });
                    setCommandState('ok');
                    setLastCommand(`Posição inicial executada em ${selectedCam.name}`);
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Falha ao enviar a posição inicial.';
                    setCommandState('error');
                    setLastError(message);
                    setLastCommand(`Falha na posição inicial em ${selectedCam.name}`);
                  }
                }}
                disabled={controlsDisabled}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Camera className="h-3.5 w-3.5" />
                Posição inicial
              </button>
            </div>

            <div className="mx-auto grid w-fit grid-cols-3 gap-2">
              <div />
              <ControlButton
                label="Mover para cima"
                icon={<ArrowUp className="h-4 w-4" />}
                active={activeDirection === 'Up'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('Up')}
              />
              <div />
              <ControlButton
                label="Mover para a esquerda"
                icon={<ArrowLeft className="h-4 w-4" />}
                active={activeDirection === 'Left'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('Left')}
              />
              <button
                type="button"
                onClick={() => void stopMove()}
                disabled={!activeDirection}
                className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-45"
                title="Parar movimento"
              >
                <Crosshair className="h-4 w-4" />
              </button>
              <ControlButton
                label="Mover para a direita"
                icon={<ArrowRight className="h-4 w-4" />}
                active={activeDirection === 'Right'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('Right')}
              />
              <div />
              <ControlButton
                label="Mover para baixo"
                icon={<ArrowDown className="h-4 w-4" />}
                active={activeDirection === 'Down'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('Down')}
              />
              <div />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <ControlButton
                label="Aproximar zoom"
                icon={<ZoomIn className="h-4 w-4" />}
                active={activeDirection === 'ZoomIn'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('ZoomIn')}
              />
              <ControlButton
                label="Afastar zoom"
                icon={<ZoomOut className="h-4 w-4" />}
                active={activeDirection === 'ZoomOut'}
                disabled={controlsDisabled}
                onActivate={() => void startMove('ZoomOut')}
              />
            </div>

            {selectedCam && (
              <PosicoesDaCamera
                key={selectedCam.id}
                cameraId={selectedCam.id}
                podeGravar={userRole === 'admin'}
                desabilitado={controlsDisabled}
                aoIr={(nome) => { setCommandState('ok'); setLastCommand(`Foi para "${nome}" em ${selectedCam.name}`); }}
              />
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
