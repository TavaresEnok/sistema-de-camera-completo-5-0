import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PlaySquare, Crosshair, Maximize2, Info, AlertTriangle, Circle, Lock } from 'lucide-react';
import { Camera } from '../store/vmsDataStore';
import { LiveStreamPlayer, type LivePlayerStatus } from './LiveStreamPlayer';
import { mostrarAvisoDeOffline } from '../lib/aviso-de-offline-no-tile';

import { useGridStore } from '../store/gridStore';

interface CameraTileProps {
  camera: Camera;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onAction?: (action: string, camera: Camera) => void;
  recordingBusy?: boolean;
  compact?: boolean;
  streamStartDelayMs?: number;
  routeActive?: boolean;
  showDetectionOverlay?: boolean;
  liveViewMode?: 'selected' | 'grid';
  wallMode?: boolean;
  onGridSourceIsOriginal?: (cameraId: string, isOriginal: boolean) => void;
}

const STATUS_DOT: Record<string, string> = {
  online:      'hsl(var(--status-online))',
  recording:   'hsl(var(--status-rec))',
  motion:      'hsl(var(--status-motion))',
  alarm:       'hsl(var(--status-alarm))',
  offline:     'hsl(var(--status-offline))',
  no_signal:   'hsl(var(--status-offline))',
  maintenance: 'hsl(var(--status-warning))',
};

export function CameraTile({
  camera,
  selected,
  onClick,
  onDoubleClick,
  onAction,
  recordingBusy = false,
  compact,
  streamStartDelayMs = 0,
  routeActive = true,
  showDetectionOverlay = false,
  liveViewMode = 'grid',
  wallMode: wallModeProp,
  onGridSourceIsOriginal,
}: CameraTileProps) {
  const [hovered, setHovered] = useState(false);
  const [playerStatus, setPlayerStatus] = useState<LivePlayerStatus | null>(null);
  const storedWallMode = useGridStore((state) => state.wallMode);
  const wallMode = wallModeProp ?? storedWallMode;

  // Câmera privada que ESTE usuário não pode ver (ex.: admin numa câmera do
  // cliente). O player NÃO é montado — mostramos um aviso de privacidade limpo
  // no lugar. O backend já bloqueia o conteúdo; aqui é só a UX respeitosa.
  const contentLocked = camera.isPrivate === true && camera.canViewContent === false;

  // Overlay "Offline" do tile só quando o player também não tem imagem viva —
  // e tocar por contingência (`fallback`) CONTA como imagem viva. Ver
  // lib/aviso-de-offline-no-tile.ts (tag sobre vídeo rodando, IBTelecom 18/09).
  const showOfflineOverlay = mostrarAvisoDeOffline(camera.status, playerStatus?.state);
  const isAlarm    = camera.status === 'alarm';
  const isMotion   = camera.status === 'motion';
  // Regras de movimento/objeto podem estar gravando automaticamente; elas não
  // são o REC acionado na grade e não devem pintar o botão de vermelho.
  const isManualRecordingActive = camera.manualRecordingActive === true
    || (camera.recordingMode === 'manual' && camera.status === 'recording');

  return (
    <motion.div
      className={`relative w-full h-full rounded-sm overflow-hidden cursor-pointer select-none
        ${selected ? 'ring-2 ring-inset ring-[hsl(var(--primary))] shadow-[inset_0_0_0_1px_hsl(var(--primary)_/_0.28)]' : ''}
        ${isAlarm   ? 'alarm-glow ring-1 ring-[hsl(var(--status-alarm)_/_0.5)]' : ''}
      `}
      style={{ background: 'hsl(var(--layer-base))', minHeight: compact ? 80 : 120 }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      transition={{ duration: 0.12 }}
    >
      {/* O stream fica MONTADO mesmo com status "offline": o status vem de sondagem
          periódica e pode flapear em WAN — desmontar aqui derrubava uma conexão
          WebRTC saudável (piscada) por causa de um falso-offline de um ciclo. O
          próprio player cuida de retry/backoff quando o stream realmente cai; o
          overlay de offline abaixo só cobre a imagem enquanto não há frame vivo. */}
      {contentLocked ? (
        // Câmera privada do cliente: conteúdo protegido. NÃO monta o player (nem
        // tenta buscar o stream — o backend devolveria 403). Aviso limpo e digno.
        <div className="absolute inset-0 flex items-center justify-center bg-[hsl(210,18%,9%)]">
          <div className="text-center px-4">
            <Lock className="mx-auto mb-2 h-6 w-6 text-white/30" />
            <div className="text-[11px] font-medium text-white/60">Câmera privada</div>
            <div className="mt-0.5 text-[9px] text-white/35">Conteúdo acessível somente ao cliente</div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0">
          <LiveStreamPlayer
            cameraId={camera.id}
            cameraName={camera.name}
            showOverlay={showDetectionOverlay && !wallMode && !showOfflineOverlay}
            showEssentialStatus={wallMode}
            aiEnabled={camera.aiEnabled}
            liveViewMode={liveViewMode}
            className="h-full w-full"
            muted
            startDelayMs={streamStartDelayMs}
            routeActive={routeActive}
            onStatusChange={setPlayerStatus}
            onGridSourceIsOriginal={(isOriginal) => onGridSourceIsOriginal?.(camera.id, isOriginal)}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        aria-label={`${camera.name}, ${showOfflineOverlay ? 'vídeo indisponível' : 'visualização ao vivo'}`}
        aria-pressed={selected}
        className="absolute inset-0 z-[15] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[hsl(var(--primary))]"
      >
        <span className="sr-only">Selecionar {camera.name}</span>
      </button>

      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/10" />

      {/* Offline overlay — só quando o player também não tem imagem viva (status
          "offline" com stream tocando = sondagem desatualizada; mostra o vídeo). */}
      {showOfflineOverlay && (
        <div className="pointer-events-none absolute inset-0 z-20 bg-black/60 flex items-center justify-center">
          <div className="text-center">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--status-offline))] mx-auto mb-1" />
            <div className="font-mono text-[9px] text-[hsl(var(--muted-foreground))] tracking-widest uppercase">
              Vídeo indisponível
            </div>
          </div>
        </div>
      )}

      {!wallMode && (
        <>
          {/* Top-left: camera name + status badge */}
          <div className="absolute top-1.5 left-1.5 z-20 flex items-center gap-1">
            <span className="max-w-[220px] truncate rounded bg-black/65 px-2 py-1 text-[11px] font-medium text-white/95 shadow-sm backdrop-blur-[2px]">
              {camera.name}
            </span>
            {camera.isPrivate && (
              <span className="inline-flex items-center gap-0.5 rounded-sm border border-white/20 bg-black/55 px-1.5 py-px text-[9px] text-white/70 backdrop-blur-[2px]" title="Câmera privada — conteúdo acessível somente ao cliente">
                <Lock className="h-2.5 w-2.5" /> Privada
              </span>
            )}
            {isAlarm && (
              <span className="text-[9px] text-[hsl(var(--status-alarm))] bg-[hsl(var(--status-alarm)_/_0.18)] border border-[hsl(var(--status-alarm)_/_0.4)] px-1.5 py-px rounded-sm rec-pulse">
                Alarme
              </span>
            )}
            {isMotion && (
              <span className="text-[9px] text-[hsl(var(--status-motion))] bg-[hsl(var(--status-motion)_/_0.15)] border border-[hsl(var(--status-motion)_/_0.35)] px-1.5 py-px rounded-sm">
                Movimento
              </span>
            )}
            {isManualRecordingActive && (
              <span className="text-[9px] font-medium text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)_/_0.18)] border border-[hsl(var(--destructive)_/_0.45)] px-1.5 py-px rounded-sm rec-pulse">
                Gravação manual
              </span>
            )}
          </div>

          {/* Bottom gradient */}
          <div className="absolute bottom-0 left-0 right-0 z-10 h-6 bg-gradient-to-t from-black/40 to-transparent pointer-events-none" />
        </>
      )}

      {/* Hover action bar */}
      <AnimatePresence>
        {(hovered || selected) && !showOfflineOverlay && !wallMode && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-1 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 rounded-md py-1.5 px-2 bg-black/75 backdrop-blur-[2px]"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label={`Abrir controle PTZ de ${camera.name}`}
              className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-[hsl(var(--primary))] hover:bg-white/8 transition-colors"
              onClick={() => onAction?.('ptz', camera)}
              title="Controle PTZ"
            >
              <Crosshair className="w-3 h-3" />
            </button>
            {camera.recordingMode !== 'continuous' && <button
              type="button"
              disabled={recordingBusy}
              aria-label={`${isManualRecordingActive ? 'Parar' : 'Iniciar'} gravação manual de ${camera.name}`}
              className={`flex h-6 items-center justify-center gap-1 rounded border px-1.5 text-[9px] font-medium transition-colors ${
                isManualRecordingActive
                  ? 'border-[hsl(var(--destructive)_/_0.6)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.2)]'
                  : 'border-[hsl(var(--status-online)_/_0.6)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))] hover:bg-[hsl(var(--status-online)_/_0.2)]'
              }`}
              onClick={() => onAction?.(isManualRecordingActive ? 'record-stop' : 'record-start', camera)}
              title={isManualRecordingActive ? 'Parar gravação manual' : 'Iniciar gravação manual (máximo de 10 minutos)'}
            >
              <Circle className={`w-3 h-3 ${isManualRecordingActive ? 'fill-current' : ''}`} />
              <span>{recordingBusy ? 'Aguarde' : isManualRecordingActive ? 'Manual' : 'Gravar'}</span>
            </button>}
            <button
              type="button"
              aria-label={`Abrir reprodução de ${camera.name}`}
              className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-[hsl(var(--primary))] hover:bg-white/8 transition-colors"
              onClick={() => onAction?.('playback', camera)}
              title="Reprodução"
            >
              <PlaySquare className="w-3 h-3" />
            </button>
            <button
              type="button"
              aria-label={`Abrir ${camera.name} em tela cheia`}
              className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-[hsl(var(--primary))] hover:bg-white/8 transition-colors"
              onClick={() => onAction?.('fullscreen', camera)}
              title="Tela cheia"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
            <button
              type="button"
              aria-label={`Abrir detalhes de ${camera.name}`}
              className="w-6 h-6 flex items-center justify-center rounded text-white/50 hover:text-[hsl(var(--primary))] hover:bg-white/8 transition-colors"
              onClick={() => onAction?.('info', camera)}
              title="Detalhes da câmera"
            >
              <Info className="w-3 h-3" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
