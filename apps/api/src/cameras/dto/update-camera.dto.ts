import { ArrayMaxSize, IsArray, IsBoolean, IsIP, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DetectionZoneDto } from './detection-zone.dto';

const RECORDING_MODES = ['continuous', 'motion', 'object', 'manual'] as const;
const VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const STREAM_VIDEO_CODECS = ['original', 'h264', 'h265', 'hevc', 'mjpeg'] as const;
const RTSP_TRANSPORTS = ['tcp', 'udp'] as const;
const LIVE_PROTOCOLS = ['auto', 'flv', 'hls', 'llhls', 'webrtc', 'mjpeg'] as const;

export class UpdateCameraDto {
  /** Revisão lida pelo editor; impede sobrescrever outra edição silenciosamente. */
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @IsIP()
  ip?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  rtspPort?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  onvifPort?: number;


  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  httpPort?: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  rtspPath?: string;

  @IsOptional()
  @IsString()
  onvifPath?: string;

  @IsOptional()
  @IsString()
  onvifProfileToken?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  subtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  liveChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  liveSubtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  recordingSubtype?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  analyticsChannel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  analyticsSubtype?: number;

  @IsOptional()
  @IsString()
  siteId?: string;

  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  locationAddress?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number | null;

  @IsOptional()
  @IsString()
  groupId?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  recordingEnabled?: boolean;

  /**
   * Override manual de PTZ (editor avançado). Definir aqui marca a origem como
   * 'manual' e a sonda automática passa a NÃO tocar mais nesta câmera — é a
   * saída para equipamento que a sonda não sabe ler. Mandar `null` devolve o
   * controle ao automático.
   */
  @IsOptional()
  @IsBoolean()
  ptzCapable?: boolean | null;

  /**
   * Como esta câmera participa da detecção de OBJETO.
   * `auto` (padrão) roda só com linha de perímetro desenhada — o custo segue a
   * necessidade declarada em vez de uma lista paralela para manter.
   */
  @IsOptional()
  @IsString()
  @IsIn(['auto', 'sempre', 'nunca'])
  objectMode?: 'auto' | 'sempre' | 'nunca';

  /** Subconjunto das classes de objeto liberadas pela política da instalação. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck'], { each: true })
  aiObjectClasses?: string[];

  /** Perfil simples de confirmação; não mexe no limiar bruto do rastreador. */
  @IsOptional()
  @IsString()
  @IsIn(['sensitive', 'balanced', 'precise'])
  aiSensitivity?: 'sensitive' | 'balanced' | 'precise';

  /** Confiança mínima exibida na barra simples da tela de IA. */
  @IsOptional()
  @IsInt()
  @Min(55)
  @Max(90)
  aiConfidence?: number;

  @IsOptional()
  @IsString()
  @IsIn(RECORDING_MODES)
  recordingMode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  /** Segue a retenção do grupo? Câmera nova nasce seguindo. */
  @IsOptional()
  @IsBoolean()
  retentionFollowsGroup?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(RTSP_TRANSPORTS)
  preferredRtspTransport?: string;

  @IsOptional()
  @IsString()
  @IsIn(LIVE_PROTOCOLS)
  preferredLiveProtocol?: string;

  @IsOptional()
  @IsString()
  @IsIn(STREAM_VIDEO_CODECS)
  streamVideoCodec?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamWidth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamHeight?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamFps?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  streamBitrateKbps?: number | null;

  @IsOptional()
  @IsString()
  @IsIn(VIDEO_CODECS)
  recordingVideoCodec?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingWidth?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingHeight?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingFps?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recordingBitrateKbps?: number | null;

  @IsOptional()
  @IsBoolean()
  audioEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  alarmsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  hasEdgeAi?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['SYSTEM', 'CAMERA'])
  motionTrigger?: string;

  /// Zonas de detecção: polígonos normalizados (0..1). Ver DetectionZoneDto.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => DetectionZoneDto)
  detectionZones?: DetectionZoneDto[];

  /**
   * Classes que iniciam gravação no modo `object`. Vazio = conjunto padrão
   * (pessoa + veículos), preservando quem já usava o modo.
   *
   * Restrita ao que o modelo realmente detecta e ao que faz sentido para um
   * VMS: aceitar classe livre deixaria o operador digitar "ladrao" e ficar com
   * uma câmera que nunca grava — falha silenciosa, a pior de todas.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck'], { each: true })
  recordingObjectClasses?: string[];
}
