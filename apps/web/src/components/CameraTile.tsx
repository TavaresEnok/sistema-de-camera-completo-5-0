import { useState } from 'react';
import { motion } from 'framer-motion';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PlaySquare, Crosshair, Maximize2, Info, AlertTriangle, Circle, Lock, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { Camera } from '../store/vmsDataStore';
import { LiveStreamPlayer, type LivePlayerStatus } from './LiveStreamPlayer';
import { mostrarAvisoDeOffline } from '../lib/aviso-de-offline-no-tile';

import { useGridStore } from '../store/gridStore';
import { useAuthStore } from '../store/authStore';

interface CameraTileProps {
  camera: Camera;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onAction?: (action: string, camera: Camera) => void;
  onReplace?: () => void;
  onRemove?: () => void;
  recordingBusy?: boolean;
  compact?: boolean;
  streamStartDelayMs?: number;
  routeActive?: boolean;
  playbackEnabled?: boolean;
  showDetectionOverlay?: boolean;
  liveViewMode?: 'selected' | 'grid';
  detectionDisplayMode?: 'selected' | 'grid';
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
  onReplace,
  onRemove,
  recordingBusy = false,
  compact,
  streamStartDelayMs = 0,
  routeActive = true,
  playbackEnabled = true,
  showDetectionOverlay = false,
  liveViewMode = 'grid',
  detectionDisplayMode = 'grid',
  wallMode: wallModeProp,
  onGridSourceIsOriginal,
}: CameraTileProps) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const canRecord = useAuthStore(state => state.user?.role === 'admin' || state.user?.role === 'operator');
  const [playerStatus, setPlayerStatus] = useState<LivePlayerStatus | null>(null);
  const [audioControlContainer, setAudioControlContainer] = useState<HTMLDivElement | null>(null);
  const [streamControlsContainer, setStreamControlsContainer] = useState<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const storedWallMode = useGridStore((state) => state.wallMode);
  const wallMode = wallModeProp ?? storedWallMode;

  // Câmera privada que ESTE usuário não pode ver (ex.: admin numa câmera do
  // cliente). O player NÃO é montado — mostramos um aviso de privacidade limpo
  // no lugar. O backend já bloqueia o conteúdo; aqui é só a UX respeitosa.
  const contentLocked = camera.canViewContent === false;

  // Overlay "Offline" do tile só quando o player também não tem imagem viva —
  // e tocar por contingência (`fallback`) CONTA como imagem viva. Ver
  // lib/aviso-de-offline-no-tile.ts (tag sobre vídeo rodando, IBTelecom 18/09).
  const showOfflineOverlay = mostrarAvisoDeOffline(camera.status, playerStatus?.state);
  const isAlarm    = camera.status === 'alarm';
  const isMotion   = camera.status === 'motion';
  // Regras de movimento/objeto podem estar gravando automaticamente; elas não
  // são o REC acionado na grade e não devem pintar o botão de vermelho.
  const isManualRecordingActive = camera.manualRecordingActive
    ?? (camera.recordingMode === 'manual' && camera.status === 'recording');

  return (
    <motion.div
      data-camera-tile={camera.id}
      className={`relative w-full h-full rounded-sm overflow-hidden cursor-pointer select-none
        ${selected ? 'ring-2 ring-inset ring-[hsl(var(--primary))] shadow-[inset_0_0_0_1px_hsl(var(--primary)_/_0.28)]' : ''}
        ${isAlarm   ? 'alarm-glow ring-1 ring-[hsl(var(--status-alarm)_/_0.5)]' : ''}
      `}
      style={{ background: 'hsl(var(--layer-base))', minHeight: 0, containerType: 'inline-size' }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onFocusCapture={() => setKeyboardFocused(true)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocused(false); }}
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
            <div className="text-[11px] font-medium text-white/80">{camera.isPrivate ? 'Câmera privada' : 'Acesso restrito'}</div>
            <div className="mt-0.5 text-[10px] text-white/65">Seu usuário não pode visualizar esta câmera.</div>
          </div>
        </div>
      ) : (
        <div className="absolute inset-0">
          <LiveStreamPlayer
            cameraId={camera.id}
            cameraName={camera.name}
            showOverlay={showDetectionOverlay && !wallMode && !showOfflineOverlay}
            showAudioControl={!showOfflineOverlay && routeActive && playbackEnabled}
            audioControlContainer={audioControlContainer}
            streamControlsInMenu
            streamControlsContainer={streamControlsContainer}
            showEssentialStatus
            aiEnabled={camera.aiEnabled}
            showDetectorPercentage={camera.showDetectorPercentage}
            detectionDisplayMode={detectionDisplayMode}
            liveViewMode={liveViewMode}
            className="h-full w-full"
            muted
            startDelayMs={streamStartDelayMs}
            routeActive={routeActive}
            playbackEnabled={playbackEnabled}
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

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/10" />

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

      {/* One layout owns every control. Portals escape player paint containment,
          not this row; camera names shrink instead of covering buttons. */}
      <div className={`camera-tile-topbar pointer-events-none absolute inset-x-1 top-1 z-40 flex min-w-0 flex-nowrap items-center gap-1 rounded-md bg-black/65 px-1 backdrop-blur-[2px] ${wallMode && !hovered && !selected && !keyboardFocused && !menuOpen ? 'camera-tile-wall-idle' : ''}`}>
          <div className="min-w-0 flex-1 overflow-hidden">
            <span className="block truncate px-1 text-[11px] font-medium text-white/95" title={camera.name}>
              {camera.name}
            </span>
            {(camera.isPrivate || isAlarm || isMotion || isManualRecordingActive) && <span className="block truncate px-1 text-[9px] text-white/80">
              {[camera.isPrivate && 'Privada', isAlarm && 'Alarme', isMotion && 'Movimento', isManualRecordingActive && 'Gravação manual'].filter(Boolean).join(' · ')}
            </span>}
          </div>
          {!contentLocked && <div ref={setAudioControlContainer} className="pointer-events-none flex shrink-0 items-center" />}
          {!contentLocked && !showOfflineOverlay && !wallMode && <>
            {canRecord && camera.recordingMode !== 'continuous' && <button
              type="button"
              disabled={recordingBusy}
              aria-label={`${isManualRecordingActive ? 'Parar' : 'Iniciar'} gravação manual de ${camera.name}`}
              className={`camera-tile-record camera-tile-tool pointer-events-auto shrink-0 flex items-center justify-center rounded text-[9px] font-medium transition-colors ${
                isManualRecordingActive
                  ? 'border-[hsl(var(--destructive)_/_0.6)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.2)]'
                  : 'border-[hsl(var(--status-online)_/_0.6)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))] hover:bg-[hsl(var(--status-online)_/_0.2)]'
              }`}
              onClick={event => { event.stopPropagation(); onAction?.(isManualRecordingActive ? 'record-stop' : 'record-start', camera); }}
              onDoubleClick={event => event.stopPropagation()}
              title={isManualRecordingActive ? 'Parar gravação manual' : 'Iniciar gravação manual (máximo de 10 minutos)'}
            >
              <Circle className={`w-3 h-3 ${isManualRecordingActive ? 'fill-current' : ''}`} />
            </button>}
            <button
              type="button"
              aria-label={`Abrir ${camera.name} em tela cheia`}
              className="camera-tile-expand camera-tile-tool pointer-events-auto shrink-0 flex items-center justify-center rounded text-white/80 hover:bg-white/15"
              onClick={event => { event.stopPropagation(); onAction?.('fullscreen', camera); }}
              onDoubleClick={event => event.stopPropagation()}
              title="Tela cheia"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </>}
          <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="camera-tile-tool pointer-events-auto flex shrink-0 items-center justify-center rounded text-white/90 hover:bg-white/15"
                aria-label={`Mais opções de ${camera.name}`} title="Mais opções"
                onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal container={document.fullscreenElement as HTMLElement | null ?? document.body}>
              <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8}
                className="camera-tile-menu z-[100] max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-white/20 bg-[hsl(var(--popover))] p-1 text-[hsl(var(--popover-foreground))] shadow-xl"
                onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
                <div className="truncate px-3 py-2 text-xs font-semibold" title={camera.name}>{camera.name}</div>
                {!contentLocked && !showOfflineOverlay && <>
                  {canRecord && camera.recordingMode !== 'continuous' && <DropdownMenu.Item disabled={recordingBusy} onSelect={() => onAction?.(isManualRecordingActive ? 'record-stop' : 'record-start', camera)}>
                    <Circle className={isManualRecordingActive ? 'fill-current' : ''} />{recordingBusy ? 'Aguarde…' : isManualRecordingActive ? 'Parar gravação manual' : 'Gravar por 10 minutos'}
                  </DropdownMenu.Item>}
                  {camera.ptzCapable && <DropdownMenu.Item onSelect={() => onAction?.('ptz', camera)}><Crosshair />Mover câmera</DropdownMenu.Item>}
                  <DropdownMenu.Item onSelect={() => onAction?.('playback', camera)}><PlaySquare />Ver gravações</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => onAction?.('fullscreen', camera)}><Maximize2 />Tela cheia</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => onAction?.('info', camera)}><Info />Detalhes da câmera</DropdownMenu.Item>
                  <div ref={setStreamControlsContainer} className="border-t border-white/10 p-2" />
                </>}
                {!wallMode && onReplace && <DropdownMenu.Item onSelect={onReplace}><RefreshCw />Trocar câmera deste quadro</DropdownMenu.Item>}
                {!wallMode && onRemove && <DropdownMenu.Item onSelect={onRemove}><X />Remover câmera deste quadro</DropdownMenu.Item>}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
      </div>
    </motion.div>
  );
}
