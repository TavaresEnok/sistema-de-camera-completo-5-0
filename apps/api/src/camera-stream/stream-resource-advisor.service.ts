import { Injectable } from '@nestjs/common';
import {
  isHevcCodec,
  resolveAnalyticsRtspProfile,
  resolveDeliveryVideoCodec,
  resolveLiveRtspProfile,
  resolveOriginalVideoCodec,
  resolveRecordingRtspProfile,
} from '../cameras/helpers/rtsp-url.helper';
import { CamerasService } from '../cameras/cameras.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediamtxProxyService } from './mediamtx-proxy.service';

type ResourceSeverity = 'info' | 'warning' | 'critical';

type ResourceFinding = {
  code: string;
  severity: ResourceSeverity;
  message: string;
  action: string;
};

function normalizeCodec(codec?: string | null) {
  const value = String(codec ?? '').trim().toLowerCase();
  if (!value || value === 'original' || value === 'source') return null;
  if (['hevc', 'h.265', 'h265', 'hvc1'].includes(value)) return 'h265';
  if (['avc1', 'h.264', 'h264'].includes(value)) return 'h264';
  if (['mjpeg', 'mjpg', 'jpeg'].includes(value)) return 'mjpeg';
  return value;
}

function pixelCount(width?: number | null, height?: number | null) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w * h;
}

function profileEquals(a: { channel: number; subtype: number }, b: { channel: number; subtype: number }) {
  return a.channel === b.channel && a.subtype === b.subtype;
}

@Injectable()
export class StreamResourceAdvisorService {
  constructor(
    private readonly camerasService: CamerasService,
    private readonly mediamtxProxyService: MediamtxProxyService,
    private readonly prisma: PrismaService,
  ) {}

  private addFinding(findings: ResourceFinding[], finding: ResourceFinding) {
    if (!findings.some((item) => item.code === finding.code)) {
      findings.push(finding);
    }
  }

  private riskScore(findings: ResourceFinding[]) {
    return findings.reduce((score, finding) => {
      if (finding.severity === 'critical') return score + 40;
      if (finding.severity === 'warning') return score + 20;
      return score + 5;
    }, 0);
  }

  private riskLevel(score: number): 'ok' | 'attention' | 'high' | 'critical' {
    if (score >= 80) return 'critical';
    if (score >= 50) return 'high';
    if (score >= 20) return 'attention';
    return 'ok';
  }

  async getFleetReport(accessibleCameraIds?: string[]) {
    const allowed = accessibleCameraIds ? new Set(accessibleCameraIds) : null;
    const cameras = (await this.camerasService.findAllInternal())
      .filter((camera: any) => !allowed || allowed.has(camera.id));
    const cameraReports = await Promise.all(cameras.map((camera: any) => this.buildCameraReport(camera)));
    const warningCount = cameraReports.reduce((total, camera) => total + camera.resource.findings.filter((item) => item.severity === 'warning').length, 0);
    const criticalCount = cameraReports.reduce((total, camera) => total + camera.resource.findings.filter((item) => item.severity === 'critical').length, 0);
    const mediaMtxReaders = cameraReports.reduce((total, camera) => total + camera.mediaMtx.readerCount, 0);

    return {
      generatedAt: new Date().toISOString(),
      scope: accessibleCameraIds ? 'accessible_cameras' : 'all_cameras',
      principles: [
        'Gravação preserva o stream original sempre que possível.',
        'Live usa WebRTC por padrão e liga transcode somente sob demanda.',
        'Analytics deve usar substream direto da câmera, sem MediaMTX e sem áudio.',
        'Playback usa cache compatível quando o arquivo original não toca bem no navegador.',
      ],
      summary: {
        totalCameras: cameraReports.length,
        onlineCameras: cameraReports.filter((camera) => camera.status === 'ONLINE').length,
        webrtcPreferred: cameraReports.filter((camera) => camera.profiles.live.protocol === 'webrtc').length,
        analyticsSeparated: cameraReports.filter((camera) => camera.profiles.analytics.separatedFromLive).length,
        liveTranscodeLikely: cameraReports.filter((camera) => camera.profiles.live.transcodeForBrowser).length,
        audioTranscodeLikely: cameraReports.filter((camera) => camera.profiles.live.audioForcesTranscode).length,
        highCpuRiskCameras: cameraReports.filter((camera) => ['high', 'critical'].includes(camera.resource.level)).length,
        playbackCompatibilityRisk: cameraReports.filter((camera) => camera.playback.compatibilityCacheRecommended).length,
        mediaMtxReaders,
        liveFailuresLast24h: cameraReports.reduce((total, camera) => total + camera.operations.live.failuresLast24h, 0),
        recordingSegmentsLast24h: cameraReports.reduce((total, camera) => total + camera.operations.recording.segmentsLast24h, 0),
        recordingGapSecondsLast24h: cameraReports.reduce((total, camera) => total + camera.operations.recording.gapSecondsLast24h, 0),
        camerasWithRecordingAttention: cameraReports.filter((camera) => camera.operations.recording.state === 'attention').length,
        warningCount,
        criticalCount,
      },
      cameras: cameraReports,
      optimizationPlan: this.buildSafeOptimizationPlan(cameraReports),
      recommendations: this.aggregateRecommendations(cameraReports),
    };
  }

  async getCameraReport(cameraId: string) {
    const camera = await this.camerasService.getCameraOrThrow(cameraId);
    return this.buildCameraReport(camera);
  }

  async getOptimizationPlan(accessibleCameraIds?: string[]) {
    const report = await this.getFleetReport(accessibleCameraIds);
    return {
      generatedAt: report.generatedAt,
      scope: report.scope,
      plan: report.optimizationPlan,
    };
  }

  async applySafeOptimizations(accessibleCameraIds?: string[]) {
    const report = await this.getFleetReport(accessibleCameraIds);
    const updated: Array<{ cameraId: string; cameraName: string; changes: string[] }> = [];

    for (const camera of report.cameras) {
      const data: Record<string, unknown> = {};
      const changes: string[] = [];

      if (camera.profiles.live.protocol !== 'webrtc') {
        data.preferredLiveProtocol = 'webrtc';
        changes.push('preferredLiveProtocol=webrtc');
      }
      if (camera.profiles.live.subtype !== 0) {
        data.liveSubtype = 0;
        changes.push('liveSubtype=0');
      }
      if (camera.profiles.recording.subtype !== 0) {
        data.recordingSubtype = 0;
        changes.push('recordingSubtype=0');
      }
      if (!camera.profiles.analytics.separatedFromLive) {
        data.analyticsSubtype = 1;
        changes.push('analyticsSubtype=1');
      }

      if (!changes.length) continue;

      await this.prisma.camera.update({
        where: { id: camera.cameraId },
        data,
      });
      this.mediamtxProxyService.invalidateMainCodecCache(camera.cameraId);
      updated.push({ cameraId: camera.cameraId, cameraName: camera.cameraName, changes });
    }

    return {
      appliedAt: new Date().toISOString(),
      totalChanged: updated.length,
      updated,
      skipped: report.cameras.length - updated.length,
      note: 'Aplicação segura não altera IP, usuário, senha, caminho RTSP, ONVIF, codec físico da câmera ou áudio.',
    };
  }

  private aggregateRecommendations(cameraReports: Array<Awaited<ReturnType<StreamResourceAdvisorService['buildCameraReport']>>>) {
    const counts = new Map<string, { code: string; severity: ResourceSeverity; message: string; action: string; cameras: string[] }>();
    for (const camera of cameraReports) {
      for (const finding of camera.resource.findings) {
        const current = counts.get(finding.code) ?? { ...finding, cameras: [] };
        current.cameras.push(camera.cameraName);
        counts.set(finding.code, current);
      }
    }
    return [...counts.values()]
      .sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 };
        return order[a.severity] - order[b.severity] || b.cameras.length - a.cameras.length;
      })
      .slice(0, 12);
  }

  private buildSafeOptimizationPlan(cameraReports: Array<Awaited<ReturnType<StreamResourceAdvisorService['buildCameraReport']>>>) {
    const items = cameraReports.map((camera) => {
      const actions: Array<{ code: string; label: string; safe: boolean }> = [];
      if (camera.profiles.live.protocol !== 'webrtc') {
        actions.push({ code: 'set_live_webrtc', label: 'Definir WebRTC como protocolo live principal.', safe: true });
      }
      if (camera.profiles.live.subtype !== 0) {
        actions.push({ code: 'set_live_main', label: 'Usar main stream como fonte da live.', safe: true });
      }
      if (camera.profiles.recording.subtype !== 0) {
        actions.push({ code: 'set_recording_main', label: 'Usar main stream como fonte de gravação.', safe: true });
      }
      if (!camera.profiles.analytics.separatedFromLive) {
        actions.push({ code: 'set_analytics_substream', label: 'Separar analytics para subtype 1.', safe: true });
      }
      if (camera.profiles.live.audioForcesTranscode) {
        actions.push({ code: 'review_audio', label: 'Revisar áudio: ele força Opus na live.', safe: false });
      }
      if (camera.profiles.live.transcodeForBrowser) {
        actions.push({ code: 'review_live_h264_profile', label: 'Considerar perfil live H.264 dedicado na própria câmera.', safe: false });
      }
      return {
        cameraId: camera.cameraId,
        cameraName: camera.cameraName,
        safeActionCount: actions.filter((action) => action.safe).length,
        manualActionCount: actions.filter((action) => !action.safe).length,
        actions,
      };
    });

    const safeActionCount = items.reduce((total, item) => total + item.safeActionCount, 0);
    const manualActionCount = items.reduce((total, item) => total + item.manualActionCount, 0);

    return {
      safeActionCount,
      manualActionCount,
      canApplySafely: safeActionCount > 0,
      items: items.filter((item) => item.actions.length > 0),
    };
  }

  private async getOperationalSnapshot(camera: any, dayStart: Date, now: Date) {
    const failures = await this.prisma.auditLog.findMany({
      where: {
        action: 'stream.live.failure',
        entityType: 'Camera',
        entityId: camera.id,
        createdAt: { gte: dayStart, lte: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const [windowRecordings, activeRecordingCount, latestRecording] = await Promise.all([
      this.prisma.recording.findMany({
        where: {
          cameraId: camera.id,
          startedAt: { gte: dayStart, lte: now },
        },
        orderBy: { startedAt: 'asc' },
        select: {
          startedAt: true,
          endedAt: true,
          durationSeconds: true,
          sizeBytes: true,
        },
        take: 5000,
      }),
      this.prisma.recording.count({
        where: {
          cameraId: camera.id,
          endedAt: null,
        },
      }),
      this.prisma.recording.findFirst({
        where: { cameraId: camera.id },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          sizeBytes: true,
        },
      }),
    ]);

    const windowStartMs = dayStart.getTime();
    const windowEndMs = now.getTime();
    const totalWindowSeconds = Math.max(1, Math.floor((windowEndMs - windowStartMs) / 1000));
    const intervals = windowRecordings
      .map((recording: any) => {
        const startMs = Math.max(recording.startedAt.getTime(), windowStartMs);
        const explicitEnd = recording.endedAt?.getTime?.();
        const durationEnd = Number.isFinite(Number(recording.durationSeconds))
          ? recording.startedAt.getTime() + Number(recording.durationSeconds) * 1000
          : null;
        const endMs = Math.min(explicitEnd ?? durationEnd ?? windowEndMs, windowEndMs);
        return endMs > startMs ? { startMs, endMs } : null;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.startMs - b.startMs) as Array<{ startMs: number; endMs: number }>;

    const merged: Array<{ startMs: number; endMs: number }> = [];
    for (const interval of intervals) {
      const last = merged[merged.length - 1];
      if (!last || interval.startMs > last.endMs + 1000) {
        merged.push({ ...interval });
      } else {
        last.endMs = Math.max(last.endMs, interval.endMs);
      }
    }

    let coveredSeconds = 0;
    let cursor = windowStartMs;
    let largestGapSeconds = 0;
    for (const interval of merged) {
      if (interval.startMs > cursor) {
        largestGapSeconds = Math.max(largestGapSeconds, Math.floor((interval.startMs - cursor) / 1000));
      }
      coveredSeconds += Math.floor((interval.endMs - interval.startMs) / 1000);
      cursor = Math.max(cursor, interval.endMs);
    }
    if (cursor < windowEndMs) {
      largestGapSeconds = Math.max(largestGapSeconds, Math.floor((windowEndMs - cursor) / 1000));
    }
    const gapSeconds = Math.max(totalWindowSeconds - coveredSeconds, 0);
    const coveragePercent = Math.max(0, Math.min(100, Math.round((coveredSeconds / totalWindowSeconds) * 100)));
    const usableWindowSegments = windowRecordings.filter((recording: any) => Number(recording.sizeBytes ?? 0) > 1024).length;
    const latestAgeMs = latestRecording ? now.getTime() - latestRecording.startedAt.getTime() : null;
    const continuousRecordingExpected = Boolean(camera.recordingEnabled) && String(camera.recordingMode ?? '').toLowerCase() === 'continuous';
    const recordingState =
      !camera.recordingEnabled
        ? 'disabled'
        : continuousRecordingExpected && windowRecordings.length === 0
          ? 'attention'
        : continuousRecordingExpected && latestAgeMs != null && latestAgeMs > 2 * 60 * 60 * 1000
            ? 'attention'
            : continuousRecordingExpected && largestGapSeconds > 30 * 60
              ? 'attention'
            : 'ok';

    return {
      live: {
        failuresLast24h: failures.length,
        lastFailureAt: failures[0]?.createdAt?.toISOString() ?? null,
        lastFailure: failures[0]
          ? {
              stage: typeof (failures[0].metadata as any)?.stage === 'string' ? (failures[0].metadata as any).stage : null,
              protocol: typeof (failures[0].metadata as any)?.protocol === 'string' ? (failures[0].metadata as any).protocol : null,
              reason: typeof (failures[0].metadata as any)?.reason === 'string' ? (failures[0].metadata as any).reason : null,
              state: typeof (failures[0].metadata as any)?.state === 'string' ? (failures[0].metadata as any).state : null,
            }
          : null,
      },
      recording: {
        state: recordingState,
        segmentsLast24h: windowRecordings.length,
        activeSegments: activeRecordingCount,
        coveragePercentLast24h: coveragePercent,
        coveredSecondsLast24h: coveredSeconds,
        gapSecondsLast24h: gapSeconds,
        largestGapSecondsLast24h: largestGapSeconds,
        usableSegmentsLast24h: usableWindowSegments,
        lastSegmentAt: latestRecording?.startedAt?.toISOString() ?? null,
        lastSegmentAgeMs: latestAgeMs,
        lastSegmentSizeBytes: latestRecording?.sizeBytes?.toString() ?? null,
      },
      playback: {
        state: usableWindowSegments > 0 ? 'ready' : latestRecording ? 'metadata_only' : 'empty',
        lastPlayableCandidateAt: latestRecording?.startedAt?.toISOString() ?? null,
      },
    };
  }

  private async buildCameraReport(camera: any) {
    const now = new Date();
    const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const liveProfile = resolveLiveRtspProfile(camera);
    const recordingProfile = resolveRecordingRtspProfile(camera);
    const analyticsProfile = resolveAnalyticsRtspProfile(camera);
    const liveCodec = normalizeCodec(resolveDeliveryVideoCodec(camera) ?? camera.detectedVideoCodec ?? camera.streamVideoCodec);
    const originalCodec = normalizeCodec(resolveOriginalVideoCodec(camera) ?? camera.recordingVideoCodec ?? camera.detectedVideoCodec);
    const recordingCodec = normalizeCodec(camera.recordingVideoCodec ?? originalCodec);
    const analyticsCodec = profileEquals(analyticsProfile, liveProfile) ? liveCodec : null;
    const livePixels = pixelCount(camera.streamWidth ?? camera.detectedWidth, camera.streamHeight ?? camera.detectedHeight);
    const recordingPixels = pixelCount(camera.recordingWidth ?? camera.detectedWidth, camera.recordingHeight ?? camera.detectedHeight);
    const analyticsSeparated = !profileEquals(analyticsProfile, liveProfile);
    const recordingMain = recordingProfile.subtype === 0;
    const liveMain = liveProfile.subtype === 0;
    const liveHevc = isHevcCodec(liveCodec);
    const liveTranscodeForBrowser = liveHevc || Boolean(camera.audioEnabled);
    const findings: ResourceFinding[] = [];

    if ((camera.preferredLiveProtocol ?? 'webrtc') !== 'webrtc') {
      this.addFinding(findings, {
        code: 'live_protocol_not_webrtc',
        severity: 'warning',
        message: 'A live não está configurada para WebRTC como protocolo principal.',
        action: 'Usar WebRTC como padrão e deixar LL-HLS/HLS apenas como fallback.',
      });
    }

    if (liveHevc) {
      this.addFinding(findings, {
        code: 'hevc_live_transcode',
        severity: livePixels && livePixels > 2_000_000 ? 'critical' : 'warning',
        message: 'O stream de live é HEVC/H.265; clientes incompatíveis ainda podem exigir contingência H.264.',
        action: 'Priorizar H.265/WebRTC e manter transcode on-demand apenas para clientes incompatíveis.',
      });
    }

    if (camera.audioEnabled) {
      this.addFinding(findings, {
        code: 'audio_opus_transcode',
        severity: 'warning',
        message: 'Áudio habilitado força conversão para Opus no WebRTC.',
        action: 'Desligar áudio em câmeras que não precisam de escuta ao vivo.',
      });
    }

    if (!analyticsSeparated) {
      this.addFinding(findings, {
        code: 'analytics_reuses_live',
        severity: 'critical',
        message: 'Analytics está usando o mesmo perfil da live.',
        action: 'Usar analyticsSubtype=1 para a IA ler substream direto da câmera.',
      });
    }

    if (analyticsCodec && isHevcCodec(analyticsCodec)) {
      this.addFinding(findings, {
        code: 'analytics_hevc_decode',
        severity: 'warning',
        message: 'O substream de analytics aparenta ser HEVC/H.265.',
        action: 'Configurar substream da câmera como H.264, 640x480 ou 704x480, 10-15 FPS.',
      });
    }

    if (!recordingMain) {
      this.addFinding(findings, {
        code: 'recording_not_main_stream',
        severity: 'warning',
        message: 'Gravação não está usando o perfil principal da câmera.',
        action: 'Usar recordingSubtype=0 para preservar qualidade máxima.',
      });
    }

    if (recordingCodec && !isHevcCodec(recordingCodec)) {
      this.addFinding(findings, {
        code: 'recording_not_hevc',
        severity: 'info',
        message: 'A fonte de gravação não foi detectada como H.265.',
        action: 'Se economia de disco for prioridade, preferir main stream H.265 direto da câmera.',
      });
    }

    if (!liveCodec) {
      this.addFinding(findings, {
        code: 'live_metadata_missing',
        severity: 'info',
        message: 'Metadados de codec/resolução da live ainda não estão completos.',
        action: 'Executar teste de conexão ou abrir a live para atualizar metadados detectados.',
      });
    }

    const mediaMtx = await this.mediamtxProxyService.getPathRuntimeSummaryForCamera(camera.id);
    const operations = await this.getOperationalSnapshot(camera, dayStart, now);
    if (liveTranscodeForBrowser && mediaMtx.readerCount > 1) {
      this.addFinding(findings, {
        code: 'multi_reader_transcode_pressure',
        severity: 'warning',
        message: 'Há múltiplos leitores em uma live que provavelmente exige transcode.',
        action: 'Monitorar CPU do MediaMTX/FFmpeg ou usar perfil live H.264 dedicado.',
      });
    }

    if (operations.live.failuresLast24h >= 3) {
      this.addFinding(findings, {
        code: 'repeated_live_failures',
        severity: operations.live.failuresLast24h >= 8 ? 'critical' : 'warning',
        message: 'A live registrou falhas repetidas nas últimas 24 horas.',
        action: 'Verificar ICE/WebRTC, codec, token e disponibilidade do path MediaMTX desta câmera.',
      });
    }

    if (operations.recording.state === 'attention') {
      this.addFinding(findings, {
        code: operations.recording.largestGapSecondsLast24h > 30 * 60 ? 'recording_large_gap' : 'recording_recent_segments_missing',
        severity: 'warning',
        message: operations.recording.largestGapSecondsLast24h > 30 * 60
          ? 'Gravação contínua com gap relevante nas últimas 24 horas.'
          : 'Gravação contínua esperada, mas sem segmento recente suficiente.',
        action: 'Verificar processo de gravação, path RTSP da câmera, disponibilidade da câmera e espaço em disco.',
      });
    }

    const score = this.riskScore(findings);

    return {
      cameraId: camera.id,
      cameraName: camera.name,
      status: camera.status,
      updatedAt: camera.updatedAt,
      profiles: {
        live: {
          source: liveMain ? 'main_stream' : 'substream',
          channel: liveProfile.channel,
          subtype: liveProfile.subtype,
          protocol: camera.preferredLiveProtocol ?? 'webrtc',
          codec: liveCodec,
          width: camera.streamWidth ?? camera.detectedWidth ?? null,
          height: camera.streamHeight ?? camera.detectedHeight ?? null,
          fps: camera.streamFps ?? camera.detectedFps ?? null,
          bitrateKbps: camera.streamBitrateKbps ?? camera.detectedBitrateKbps ?? null,
          transcodeForBrowser: liveTranscodeForBrowser,
          audioForcesTranscode: Boolean(camera.audioEnabled),
          deliveryCodec: liveTranscodeForBrowser ? 'h264' : liveCodec ?? 'h264',
          onDemandRecommended: liveTranscodeForBrowser,
        },
        recording: {
          source: recordingMain ? 'main_stream' : 'substream',
          channel: recordingProfile.channel,
          subtype: recordingProfile.subtype,
          codec: recordingCodec,
          width: camera.recordingWidth ?? camera.detectedWidth ?? null,
          height: camera.recordingHeight ?? camera.detectedHeight ?? null,
          fps: camera.recordingFps ?? camera.detectedFps ?? null,
          bitrateKbps: camera.recordingBitrateKbps ?? camera.detectedBitrateKbps ?? null,
          enabled: Boolean(camera.recordingEnabled),
          mode: camera.recordingMode,
          copyFriendly: recordingMain && Boolean(recordingCodec && isHevcCodec(recordingCodec)),
          pixelCount: recordingPixels,
        },
        analytics: {
          source: 'direct_camera',
          channel: analyticsProfile.channel,
          subtype: analyticsProfile.subtype,
          codec: analyticsCodec,
          separatedFromLive: analyticsSeparated,
          usesMediaMtx: false,
          audioRequested: false,
        },
      },
      mediaMtx,
      operations,
      playback: {
        originalCodec,
        browserNativeLikely: Boolean(originalCodec && !isHevcCodec(originalCodec)),
        compatibilityCacheRecommended: Boolean(originalCodec && isHevcCodec(originalCodec)),
        policy: 'serve_original_with_range_or_cached_h264_aac_when_needed',
      },
      resource: {
        level: this.riskLevel(score),
        score,
        findings,
        cpuHotspots: [
          liveTranscodeForBrowser ? 'live_ffmpeg_transcode' : null,
          camera.audioEnabled ? 'audio_to_opus' : null,
          analyticsSeparated ? null : 'analytics_on_live_stream',
        ].filter(Boolean),
      },
    };
  }
}
