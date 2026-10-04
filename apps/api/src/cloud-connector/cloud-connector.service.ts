import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AlarmStatus, CameraStatus } from '@prisma/client';
import axios from 'axios';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { statfs, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { sanitizeSensitiveText } from '../common/security/sensitive-text.helper';
import { AiManagerService } from '../ai/ai-manager.service';
import { AiService } from '../ai/ai.service';
import { RecordingProcessManagerService } from '../recordings/recording-process-manager.service';
import { StreamResourceAdvisorService } from '../camera-stream/stream-resource-advisor.service';
import { CameraObservabilityService } from '../observability/camera-observability.service';
import {
  buildHeartbeatCameras,
  HEARTBEAT_CAMERA_LIMIT_DEFAULT,
  type HeartbeatAlert,
  type HeartbeatCamerasBlock,
} from './heartbeat-cameras.helper';
import { buildReactivationSnapshot, type ReactivationSnapshot } from './reactivation-snapshot.helper';
import { SettingsService } from '../settings/settings.service';
import { decidirSobreVpn, type PerfilDeVpn } from './helpers/perfil-de-vpn.helper';

type LicenseStatus = 'UNKNOWN' | 'ACTIVE' | 'GRACE' | 'RESTRICTED' | 'SUSPENDED';

/**
 * POR QUE não há storage provisionado. `disabled` é PAUSA (nada assume o
 * lugar); `absent` é EXCLUSÃO (a instalação segue com outro storage que ainda
 * tenha, ou volta a gravar só no disco local).
 */
export type CloudStorageState = 'configured' | 'disabled' | 'absent';

/**
 * Storage em nuvem provisionado pela Central. Carrega a credencial porque é a
 * instalação que fala com o bucket — a Central só a repassa.
 */
export type CloudStorageConfig = {
  enabled: true;
  /** Nome que o operador deu na Central. Sem ele, todo storage vira "Storage principal". */
  name: string;
  /** Quantos envios em paralelo. Escolha do operador, feita na Central. */
  uploadConcurrency: number;
  /** `tier` = grava local e envia; `mount` = grava direto no bucket montado. */
  mode: 'tier' | 'mount';
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  localWindowHours: number;
  forcePathStyle: boolean;
  updatedAt: string | null;
};

const SETTING_KEYS = [
  'cloud.lastSyncAt',
  'cloud.lastError',
  'cloud.licenseStatus',
  'cloud.licenseMessage',
  'cloud.restrictions',
  'cloud.lastPayloadSummary',
  // Storage em nuvem provisionado pela Central. Guardado como setting (e não em
  // variável de ambiente) justamente para poder mudar sem recriar container —
  // que é o ponto do provisionamento remoto.
  'cloud.storage',
  // POR QUE não há storage. Sem isto a instalação não distingue "o operador
  // desligou o envio" de "o storage foi EXCLUÍDO" — reações opostas.
  'cloud.storageState',
  // Storages EXCLUÍDOS na Central. Excluir lá quer dizer "este destino acabou
  // e o conteúdo já foi embora"; a instalação expurga o que aponta para ele.
  'cloud.storageRemovals',
  // CONFIRMAÇÃO DE APLICAÇÃO. Sem isto, a Central só sabe que a instalação
  // esteve online depois da mudança — não que ela APLICOU a mudança. Uma
  // instalação antiga que ignore um campo desconhecido sumiria da lista de
  // pendências sem nunca ter aplicado nada.
  'cloud.appliedConfigRevision',
  'cloud.configApplyStatus',
  'cloud.configApplyError',
  // Hash confirmado pela Central do último snapshot de marca. O logo pode ter
  // centenas de KB; sem ACK ele viajaria de novo a cada minuto.
  'cloud.brandingReportedHash',
  'cloud.reactivationArchiveRequestId',
  'cloud.reactivationArchiveStatus',
  'cloud.reactivationArchiveError',
  'cloud.reactivationRestoreRequestId',
  'cloud.reactivationRestoreStatus',
  'cloud.reactivationRestoreError',
];

@Injectable()
export class CloudConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CloudConnectorService.name);
  private timer: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) return;

    const intervalMs = this.getIntervalMs();
    this.timer = setInterval(() => void this.syncHeartbeat(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();

    const firstRun = setTimeout(() => void this.syncHeartbeat(), 5000);
    if (typeof firstRun.unref === 'function') firstRun.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async getStatus() {
    const settings = await this.readSettings();

    return {
      ...this.getPublicConfig(),
      lastSyncAt: settings['cloud.lastSyncAt'] ?? null,
      lastError: settings['cloud.lastError'] ?? null,
      licenseStatus: (settings['cloud.licenseStatus'] as LicenseStatus | undefined) ?? 'UNKNOWN',
      licenseMessage: settings['cloud.licenseMessage'] ?? null,
      restrictions: this.parseJsonSetting(settings['cloud.restrictions'], {}),
      lastPayloadSummary: this.parseJsonSetting(settings['cloud.lastPayloadSummary'], null),
    };
  }

  async syncHeartbeat() {
    const config = this.getConfig();
    if (!config.enabled) return { skipped: true, reason: 'disabled' };
    if (!config.configured) {
      await this.writeSetting('cloud.lastError', 'Cloud connector sem CLOUD_API_URL, CLOUD_INSTALLATION_ID ou CLOUD_LICENSE_KEY.');
      return { skipped: true, reason: 'missing_config' };
    }
    if (this.syncing) return { skipped: true, reason: 'already_running' };

    this.syncing = true;
    try {
      const payload = await this.collectPayload();
      const response = await axios.post(`${config.apiUrl}/api/agent/heartbeat`, payload, {
        timeout: config.timeoutMs,
        headers: {
          'x-drac-installation-id': config.installationId,
          'x-drac-license-key': config.licenseKey,
        },
      });

      const licenseStatus = this.normalizeLicenseStatus(response.data?.licenseStatus);
      const restrictions = this.applyStatusCaps(licenseStatus, response.data?.restrictions ?? {});
      const licenseMessage = String(response.data?.licenseMessage ?? '');

      // Storage em nuvem: a Central manda `null` quando não há nada configurado
      // (ou quando a instalação está suspensa). `null` DESLIGA — é assim que o
      // operador remove o storage sem precisar entrar na instalação.
      const cloudStorage = this.normalizeCloudStorage(response.data?.cloudStorage);

      // Revisão que a Central diz ser a desejada. Guardamos DEPOIS de aplicar,
      // e só se aplicar der certo: marcar antes transformaria uma falha em
      // "aplicado" e a Central passaria a mentir.
      const desiredRevision = Number(response.data?.configRevision ?? 0) || 0;
      const previouslyAppliedRevision = Number(payload.configState?.appliedRevision ?? 0) || 0;
      const shouldApplyDesiredConfig = desiredRevision > previouslyAppliedRevision
        || payload.configState?.applyStatus === 'FAILED';
      let applyStatus = 'APPLIED';
      let applyError = '';

      try {
        await Promise.all([
          this.writeSetting('cloud.lastSyncAt', new Date().toISOString()),
          this.marcarInstante(),
          this.writeSetting('cloud.lastError', ''),
          this.writeSetting('cloud.licenseStatus', licenseStatus),
          this.writeSetting('cloud.licenseMessage', licenseMessage),
          this.writeSetting('cloud.restrictions', JSON.stringify(restrictions)),
          // Teto de câmeras contratado. Ausente na resposta = sem teto; nunca
          // inventamos um número, senão um campo esquecido no painel travaria
          // o cadastro de um cliente que pagou por mais.
          this.writeSetting('cloud.maxCameras', this.tetoDeCameras(response.data?.maxCameras)),
          this.writeSetting('cloud.maxUsers', this.tetoDeCameras(response.data?.maxUsers)),
          this.writeSetting('cloud.maxRetentionDays', this.tetoDeCameras(response.data?.maxRetentionDays)),
          // Túnel até as câmeras do cliente. Guardado como veio; quem decide se
          // aplica é `decidirSobreVpn`, e quem aplica de fato é o script do
          // host — a API não mexe em rota de rede.
          this.writeSetting('cloud.vpn', response.data?.vpn ? JSON.stringify(response.data.vpn) : ''),
          this.writeSetting('cloud.lastPayloadSummary', JSON.stringify(payload.summary)),
          // A credencial NUNCA em claro no banco: a mesma secret é cifrada na
          // tabela CloudStorage, mas esta cópia ia em texto puro — qualquer
          // dump/backup/réplica do Postgres entregava a chave S3 do cliente.
          this.writeSetting('cloud.storage', cloudStorage ? JSON.stringify(this.cifrarSegredoStorage(cloudStorage)) : ''),
          // POR QUE não desceu credencial. `disabled` é pausa (o operador
          // desligou, ou a licença suspendeu) e nada deve assumir o lugar;
          // `absent` é exclusão, e a instalação segue com outro storage que
          // ainda tenha, ou volta a gravar só no disco local. Central antiga não
          // manda o campo: nesse caso `disabled` é o palpite conservador —
          // promover storage sozinho é o erro caro.
          this.writeSetting('cloud.storageState', this.normalizeStorageState(response.data?.cloudStorageState)),
          // Storages que a Central EXCLUIU. Excluir lá significa "este destino
          // acabou e o conteúdo já foi embora" — a instalação expurga o que
          // aponta para ele. Lista (e não um aviso único) porque a instalação
          // pode passar dias offline e perder a notificação de uma exclusão.
          this.writeSetting('cloud.storageRemovals', JSON.stringify(
            Array.isArray(response.data?.cloudStorageRemovals) ? response.data.cloudStorageRemovals : [],
          )),
        ]);
        if (response.data?.branding != null && shouldApplyDesiredConfig) {
          await this.applyManagedBranding(response.data.branding);
        }
        await this.enforceRuntimeRestrictions(restrictions);
      } catch (applyFailure) {
        applyStatus = 'FAILED';
        applyError = sanitizeSensitiveText(applyFailure).slice(0, 500);
        this.logger.error(`Falha ao APLICAR configuração da Central: ${applyError}`);
      }

      // A Central recebe isto no próximo heartbeat e para de adivinhar por data.
      await Promise.all([
        this.writeSetting('cloud.configApplyStatus', applyStatus),
        this.writeSetting('cloud.configApplyError', applyError),
        ...(applyStatus === 'APPLIED'
          ? [this.writeSetting('cloud.appliedConfigRevision', String(desiredRevision))]
          : []),
      ]);

      if (payload.brandingStateHash
        && response.data?.brandingAcceptedHash === payload.brandingStateHash) {
        await this.writeSetting('cloud.brandingReportedHash', payload.brandingStateHash);
      }

      // Cancelamento/recontratação usa o mesmo canal de saída do heartbeat. A
      // instalação pode estar atrás de NAT/CGNAT; a Central nunca tenta entrar
      // nela. O snapshot é estritamente de configuração, sem vídeo, eventos,
      // sessões, biometria ou credenciais, e a Central o cifra ao receber.
      await this.avaliarVpn(response.data?.vpn).catch((e) =>
        this.logger.warn(`Falha ao avaliar o perfil de VPN: ${e?.message ?? e}`));

      await this.processReactivationArchive(response.data?.reactivationArchive, config).catch(async (archiveError) => {
        const detail = sanitizeSensitiveText(archiveError).slice(0, 500);
        this.logger.error(`Falha no arquivo de reativação: ${detail}`);
        await Promise.all([
          this.writeSetting('cloud.reactivationArchiveStatus', 'FAILED'),
          this.writeSetting('cloud.reactivationArchiveError', detail),
        ]).catch(() => undefined);
      });

      return {
        skipped: false,
        synced: true,
        licenseStatus,
        restrictions,
        configRevision: desiredRevision,
        applyStatus,
        central: {
          acknowledged: Boolean(response.data?.ok ?? response.data?.accepted),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeSetting('cloud.lastError', message);
      // A marca do relógio avança MESMO SEM CONTATO — é justamente no período
      // sem Central que alguém tentaria atrasar a data para ganhar dias.
      await this.marcarInstante().catch(() => undefined);
      this.logger.warn(`Falha ao enviar heartbeat para DRAC Central: ${message}`);
      return { skipped: false, synced: false, error: message };
    } finally {
      this.syncing = false;
    }
  }

  private isEnabled() {
    return String(process.env.CLOUD_CONNECTOR_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  private async processReactivationArchive(command: unknown, config: { apiUrl: string; installationId: string; licenseKey: string; timeoutMs: number }) {
    if (!command || typeof command !== 'object') return;
    const value = command as { action?: unknown; requestId?: unknown };
    const action = String(value.action || '').toUpperCase();
    const requestId = String(value.requestId || '').trim();
    if (!requestId) return;
    if (action === 'RESTORE') {
      await this.processReactivationRestore(requestId, config);
      return;
    }
    if (action !== 'CREATE') return;
    const settings = await this.readSettings();
    if (settings['cloud.reactivationArchiveRequestId'] === requestId && settings['cloud.reactivationArchiveStatus'] === 'UPLOADED') return;

    await this.writeSetting('cloud.reactivationArchiveStatus', 'PREPARING');
    const snapshot = await this.collectReactivationSnapshot(config.installationId);
    await axios.post(`${config.apiUrl}/api/agent/reactivation-archive`, { requestId, snapshot }, {
      timeout: Math.max(config.timeoutMs ?? 0, 30_000),
      maxBodyLength: 8 * 1024 * 1024,
      headers: {
        'x-drac-installation-id': config.installationId,
        'x-drac-license-key': config.licenseKey,
      },
    });
    await Promise.all([
      this.writeSetting('cloud.reactivationArchiveRequestId', requestId),
      this.writeSetting('cloud.reactivationArchiveStatus', 'UPLOADED'),
      this.writeSetting('cloud.reactivationArchiveError', ''),
    ]);
  }

  private async processReactivationRestore(
    requestId: string,
    config: { apiUrl: string; installationId: string; licenseKey: string; timeoutMs: number },
  ) {
    const settings = await this.readSettings();
    if (settings['cloud.reactivationRestoreRequestId'] === requestId
        && ['RESTORED', 'PRESERVED_EXISTING'].includes(settings['cloud.reactivationRestoreStatus'] || '')) return;

    await this.writeSetting('cloud.reactivationRestoreStatus', 'RESTORING');
    const headers = {
      'x-drac-installation-id': config.installationId,
      'x-drac-license-key': config.licenseKey,
    };
    try {
      const response = await axios.get(`${config.apiUrl}/api/agent/reactivation-archive/${encodeURIComponent(requestId)}`, {
        timeout: Math.max(config.timeoutMs ?? 0, 30_000),
        maxContentLength: 8 * 1024 * 1024,
        headers,
      });
      const result = await this.restoreReactivationSnapshot(response.data?.snapshot);
      const status = result.preservedExisting ? 'PRESERVED_EXISTING' : 'RESTORED';
      await axios.post(
        `${config.apiUrl}/api/agent/reactivation-archive/${encodeURIComponent(requestId)}/restored`,
        { status, summary: result },
        { timeout: Math.max(config.timeoutMs ?? 0, 30_000), headers },
      );
      await Promise.all([
        this.writeSetting('cloud.reactivationRestoreRequestId', requestId),
        this.writeSetting('cloud.reactivationRestoreStatus', status),
        this.writeSetting('cloud.reactivationRestoreError', ''),
      ]);
    } catch (error) {
      const detail = sanitizeSensitiveText(error).slice(0, 500);
      await Promise.all([
        this.writeSetting('cloud.reactivationRestoreStatus', 'FAILED'),
        this.writeSetting('cloud.reactivationRestoreError', detail),
      ]);
      throw error;
    }
  }

  /**
   * Restaura somente uma instalação LIMPA. Se já houver câmeras, nada é
   * mesclado ou sobrescrito: esse é o caso normal da reativação no mesmo
   * servidor, cujo banco já contém os cadastros. Em máquina nova, usuários
   * voltam inativos e câmeras voltam desligadas/sem senha até a confirmação
   * humana das credenciais.
   */
  private async restoreReactivationSnapshot(snapshot: unknown) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Arquivo de reativação inválido.');
    const source = snapshot as Partial<ReactivationSnapshot>;
    if (source.version !== 1) throw new Error('Versão do arquivo de reativação incompatível.');
    const rows = (value: unknown): Record<string, any>[] => Array.isArray(value)
      ? value.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : [];
    const unmanaged = (value: Record<string, any>) => {
      const { createdAt: _createdAt, updatedAt: _updatedAt, lastSeenAt: _lastSeenAt, ...rest } = value;
      return rest;
    };
    const existingCameras = await this.prisma.camera.count();
    if (existingCameras > 0) return { preservedExisting: true, existingCameras };

    const recoveryHash = await bcrypt.hash(randomBytes(48).toString('base64url'), 10);
    const cryptoService = this.moduleRef.get(CryptoService, { strict: false });
    const blankCameraPassword = cryptoService.encrypt('');
    return this.prisma.$transaction(async (tx) => {
      const userIds = new Map<string, string>();
      for (const raw of rows(source.users)) {
        if (!raw.id || (!raw.email && !raw.username)) continue;
        const login = String(raw.username || raw.email).toLowerCase();
        const existing = await tx.user.findFirst({ where: { OR: [{ username: login }, { email: String(raw.email || '').toLowerCase() }] } });
        if (existing) {
          userIds.set(String(raw.id), existing.id);
          continue;
        }
        const user = await tx.user.create({ data: {
          id: String(raw.id),
          name: String(raw.name || raw.username || raw.email),
          username: login,
          email: raw.email ? String(raw.email).toLowerCase() : null,
          role: raw.role,
          isActive: false,
          passwordHash: recoveryHash,
        } });
        userIds.set(String(raw.id), user.id);
      }

      await tx.site.createMany({ data: rows(source.sites).map(unmanaged) as any, skipDuplicates: true });
      await tx.cameraGroup.createMany({ data: rows(source.groups).map(unmanaged) as any, skipDuplicates: true });
      await tx.area.createMany({ data: rows(source.areas).map(unmanaged) as any, skipDuplicates: true });
      await tx.siteMapLayout.createMany({
        data: rows(source.siteMapLayouts).map((raw) => ({ ...unmanaged(raw), svgDataUrl: null })) as any,
        skipDuplicates: true,
      });

      const cameraRows = rows(source.cameras).map((raw) => {
        const { groupIds: _groupIds, ...camera } = unmanaged(raw);
        return {
          ...camera,
          enabled: false,
          passwordEncrypted: blankCameraPassword,
          ownerUserId: raw.ownerUserId ? userIds.get(String(raw.ownerUserId)) || null : null,
        };
      });
      if (cameraRows.length) await tx.camera.createMany({ data: cameraRows as any, skipDuplicates: true });
      for (const raw of rows(source.cameras)) {
        if (raw.id && Array.isArray(raw.groupIds)) {
          const ids = [...new Set(raw.groupIds.filter((id): id is string => typeof id === 'string'))];
          if (ids.length > 4) throw new Error('Uma câmera do arquivo tem mais de 4 grupos.');
          await tx.camera.update({ where: { id: String(raw.id) }, data: { groups: { connect: ids.map((id) => ({ id })) } } });
        }
      }

      const permissionRows = rows(source.cameraPermissions).flatMap((raw) => {
        const userId = userIds.get(String(raw.userId || ''));
        return userId ? [{ ...unmanaged(raw), userId }] : [];
      });
      if (permissionRows.length) await tx.cameraPermission.createMany({ data: permissionRows as any, skipDuplicates: true });
      const layoutRows = rows(source.liveLayouts).flatMap((raw) => {
        const userId = userIds.get(String(raw.userId || ''));
        return userId ? [{ ...unmanaged(raw), userId }] : [];
      });
      if (layoutRows.length) await tx.liveLayout.createMany({ data: layoutRows as any, skipDuplicates: true });
      for (const raw of rows(source.aiSettings)) {
        const data = unmanaged(raw);
        await tx.aiSettings.upsert({ where: { id: String(data.id || 'global') }, create: data, update: data });
      }
      for (const raw of rows(source.rolePermissions)) {
        const data = unmanaged(raw);
        await tx.rolePermission.upsert({ where: { role: data.role }, create: data as any, update: { permissions: data.permissions } });
      }
      for (const raw of rows(source.systemSettings)) {
        const data = unmanaged(raw);
        delete data.updatedByUserId;
        await tx.systemSetting.upsert({ where: { key: String(data.key) }, create: data as any, update: { value: String(data.value) } });
      }
      return {
        preservedExisting: false,
        sites: rows(source.sites).length,
        groups: rows(source.groups).length,
        areas: rows(source.areas).length,
        users: userIds.size,
        cameras: cameraRows.length,
        credentialsRequired: true,
      };
    }, { timeout: 60_000 });
  }

  private async collectReactivationSnapshot(installationId: string): Promise<ReactivationSnapshot> {
    const [sites, siteMapLayouts, areas, groups, users, cameras, cameraPermissions, liveLayouts, aiSettings, rolePermissions, systemSettings] = await Promise.all([
      this.prisma.site.findMany(),
      this.prisma.siteMapLayout.findMany(),
      this.prisma.area.findMany(),
      this.prisma.cameraGroup.findMany(),
      this.prisma.user.findMany(),
      this.prisma.camera.findMany({ include: { groups: { select: { id: true } } } }).then((items) => items.map(({ groups, ...camera }) => ({ ...camera, groupIds: groups.map((g) => g.id) }))),
      this.prisma.cameraPermission.findMany(),
      this.prisma.liveLayout.findMany(),
      this.prisma.aiSettings.findMany(),
      this.prisma.rolePermission.findMany(),
      this.prisma.systemSetting.findMany(),
    ]);
    return buildReactivationSnapshot({
      installationId,
      customerName: process.env.CLOUD_CUSTOMER_NAME || null,
      collections: { sites, siteMapLayouts, areas, groups, users, cameras, cameraPermissions, liveLayouts, aiSettings, rolePermissions, systemSettings },
    });
  }

  private getConfig() {
    const apiUrl = this.trimTrailingSlash(process.env.CLOUD_API_URL ?? '');
    const installationId = String(process.env.CLOUD_INSTALLATION_ID ?? '').trim();
    const licenseKey = String(process.env.CLOUD_LICENSE_KEY ?? '').trim();

    return {
      enabled: this.isEnabled(),
      configured: Boolean(apiUrl && installationId && licenseKey),
      apiUrl,
      installationId,
      licenseKey,
      timeoutMs: this.getPositiveInt(process.env.CLOUD_CONNECTOR_TIMEOUT_MS, 8000),
    };
  }

  private getPublicConfig() {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      configured: config.configured,
      apiUrl: config.apiUrl || null,
      installationId: config.installationId || null,
      heartbeatIntervalSeconds: Math.round(this.getIntervalMs() / 1000),
      customerName: process.env.CLOUD_CUSTOMER_NAME || null,
    };
  }

  private getIntervalMs() {
    return Math.max(this.getPositiveInt(process.env.CLOUD_HEARTBEAT_INTERVAL_SECONDS, 60), 15) * 1000;
  }

  /**
   * Lê o status do watchdog de infra (scripts/runtime-watchdog.sh grava em
   * <storage>/.monitor/runtime-status.json). Traz p/ o heartbeat os problemas de
   * INFRA (portas do MediaMTX/502 no /live, container morto, auto-cura) que a API,
   * sozinha, não enxerga — assim a Central mostra verde/vermelho por instalação.
   * Se o arquivo não existe (watchdog não instalado) ou está velho (>15min = watchdog
   * parado), devolve null / marca stale sem derrubar o heartbeat.
   */
  private async getInfraWatchdogHealth(recordingsRoot: string): Promise<{
    status: string;
    issues: string[];
    selfHealed: string[];
    checkedAt: string | null;
    stale: boolean;
  } | null> {
    const file = join(recordingsRoot, '.monitor', 'runtime-status.json');
    try {
      const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const data = JSON.parse(raw) as {
        status?: string;
        issues?: unknown;
        selfHealed?: unknown;
        checkedAt?: string;
      };
      const ageMs = Date.now() - st.mtimeMs;
      return {
        status: String(data.status ?? 'unknown'),
        issues: Array.isArray(data.issues) ? data.issues.map(String) : [],
        selfHealed: Array.isArray(data.selfHealed) ? data.selfHealed.map(String) : [],
        checkedAt: data.checkedAt ?? null,
        stale: ageMs > 15 * 60 * 1000,
      };
    } catch {
      return null; // watchdog não instalado / arquivo ausente — silencioso
    }
  }

  private async collectPayload() {
    const recordingsRoot = process.env.RECORDINGS_ROOT ?? '/storage';
    const now = new Date();
    const launchProfile = this.getLaunchProfile();

    const [disk, cameraCounts, cameraOperational, streamPerformance, recordings, recentRecordings, activeRecordings, openAlarms, activeUsers, cameraHealth] = await Promise.all([
      this.getDiskStats(recordingsRoot),
      this.getCameraCounts(),
      this.getCameraOperationalStats(),
      this.getStreamPerformanceSummary(),
      this.prisma.recording.aggregate({
        _count: { id: true },
        _sum: { sizeBytes: true },
        _max: { startedAt: true },
      }),
      this.prisma.recording.count({
        where: { startedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
      }),
      this.prisma.recording.count({ where: { endedAt: null } }),
      this.prisma.alarmInstance.count({ where: { status: AlarmStatus.OPEN } }),
      this.prisma.user.count({ where: { isActive: true } }),
      this.getCameraHealthForHeartbeat(),
    ]);

    const alerts: Array<{ level: 'warning' | 'critical'; code: string; message: string; key?: string }> = [];
    if (disk?.usagePercent !== null && disk?.usagePercent !== undefined && disk.usagePercent >= 85) {
      alerts.push({ level: 'critical', code: 'disk_usage_high', key: 'disk_usage', message: `O disco do servidor está com ${disk.usagePercent}% de uso. O espaço para novas gravações está crítico.` });
    } else if (disk?.usagePercent !== null && disk?.usagePercent !== undefined && disk.usagePercent >= 75) {
      alerts.push({ level: 'warning', code: 'disk_usage_attention', key: 'disk_usage', message: `O disco do servidor está com ${disk.usagePercent}% de uso e precisa de atenção.` });
    }
    if (cameraCounts.offline + cameraCounts.error > 0) {
      const indisponiveis = cameraCounts.offline + cameraCounts.error;
      alerts.push({
        level: 'warning',
        code: 'cameras_unavailable',
        message: `${indisponiveis} ${indisponiveis === 1 ? 'câmera está' : 'câmeras estão'} sem comunicação ou com erro.`,
      });
    }
    if (cameraCounts.total > 0 && cameraCounts.online === 0) {
      alerts.push({ level: 'critical', code: 'no_online_cameras', message: 'Todas as câmeras da instalação estão sem comunicação.' });
    }
    if (streamPerformance?.summary?.highCpuRiskCameras > 0) {
      const cameras = streamPerformance.summary.highCpuRiskCameras;
      alerts.push({
        level: cameras >= 3 ? 'critical' : 'warning',
        code: 'stream_high_cpu_risk',
        message: `${cameras} ${cameras === 1 ? 'câmera está exigindo' : 'câmeras estão exigindo'} processamento elevado para exibir vídeo. As imagens podem apresentar lentidão.`,
      });
    }
    if (streamPerformance?.summary?.liveFailuresLast24h > 0) {
      const falhas = streamPerformance.summary.liveFailuresLast24h;
      alerts.push({
        level: falhas >= 10 ? 'critical' : 'warning',
        code: 'live_failures_recent',
        message: `${falhas === 1 ? 'Foi detectada' : 'Foram detectadas'} ${falhas} ${falhas === 1 ? 'falha' : 'falhas'} ao abrir imagens ao vivo nas últimas 24 horas.`,
      });
    }
    if (recordings._count.id > 0 && !recordings._max.startedAt) {
      alerts.push({ level: 'warning', code: 'recording_without_last_segment', message: 'O sistema não conseguiu identificar o horário da gravação mais recente.' });
    }

    const mediamtxOriginsRestricted =
      String(process.env.MEDIAMTX_HLS_ALLOW_ORIGIN ?? '*') !== '*' &&
      String(process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN ?? '*') !== '*';
    const recordingRuntime = this.getRecordingRuntimeSummary();
    const recordingCapacity = await this.getRecordingCapacityEstimate(disk);
    const continuousRecordingConfigured = cameraOperational.recordingContinuous > 0;
    const recordingAutoStartEnabled = String(process.env.RECORDING_AUTO_START_ENABLED ?? 'false') === 'true';
    const recordingCapacityEnforced = continuousRecordingConfigured || recordingAutoStartEnabled;
    const recordingOptionalByProfile = launchProfile === 'standard' && !recordingCapacityEnforced;

    if (!recordingOptionalByProfile && cameraCounts.total > 0 && cameraOperational.recordingEnabled === 0) {
      alerts.push({
        level: 'warning',
        code: 'recording_disabled_all',
        message: 'Nenhuma câmera está configurada para gravar, embora a instalação exija gravação.',
      });
    }
    if (recordingCapacityEnforced && recordingCapacity.status === 'blocked') {
      alerts.push({
        level: 'critical',
        code: 'recording_storage_capacity_insufficient',
        key: 'recording_storage_capacity',
        message: `O armazenamento disponível não é suficiente para manter ${recordingCapacity.retentionDays} dias de gravações.`,
      });
    } else if (recordingCapacityEnforced && recordingCapacity.status === 'attention') {
      alerts.push({
        level: 'warning',
        code: 'recording_storage_capacity_attention',
        key: 'recording_storage_capacity',
        message: `O armazenamento está próximo do limite necessário para manter ${recordingCapacity.retentionDays} dias de gravações.`,
      });
    }
    // Saúde POR CÂMERA → alerts derivados (mesmo esquema level/code/message).
    // Se a observabilidade falhou, `cameraHealth` é null e o heartbeat segue
    // exatamente como antes: métrica nova não pode custar o heartbeat.
    if (cameraHealth) alerts.push(...cameraHealth.alerts);

    // Saúde de INFRA do watchdog → vira alerts (a Central já os exibe/historia).
    const motionFailsafeCameras = this.getMotionFailsafeCount();
    const [infraHealth, cloudOffloadMetrics] = await Promise.all([
      this.getInfraWatchdogHealth(recordingsRoot),
      this.getCloudOffloadMetrics(),
    ]);

    if (motionFailsafeCameras > 0) {
      alerts.push({
        level: 'critical',
        code: 'motion_detection_failsafe',
        message: `A detecção de movimento deixou de responder em ${motionFailsafeCameras} ${motionFailsafeCameras === 1 ? 'câmera' : 'câmeras'}. A gravação de segurança foi ativada automaticamente.`,
      });
    }

    const cloudCopiesMissing = Number(cloudOffloadMetrics.cloudCopiesMissing || 0);
    if (cloudCopiesMissing > 0) {
      alerts.push({
        level: 'critical',
        code: 'cloud_recordings_missing',
        message: `${cloudCopiesMissing} ${cloudCopiesMissing === 1 ? 'gravação que deveria estar armazenada na nuvem não foi encontrada' : 'gravações que deveriam estar armazenadas na nuvem não foram encontradas'}.`,
      });
    }
    const cloudUploadPending = Number(cloudOffloadMetrics.cloudUploadPending || 0);
    const cloudUploadOldestPendingSeconds = Number(cloudOffloadMetrics.cloudUploadOldestPendingSeconds || 0);
    const cloudUploadAlertAfterSeconds = this.getPositiveInt(process.env.CLOUD_UPLOAD_ALERT_AFTER_SECONDS, 15 * 60);
    if (cloudUploadPending > 0 && cloudUploadOldestPendingSeconds >= cloudUploadAlertAfterSeconds) {
      alerts.push({
        level: cloudUploadOldestPendingSeconds >= 60 * 60 ? 'critical' : 'warning',
        code: 'cloud_upload_delayed',
        message: `${cloudUploadPending} ${cloudUploadPending === 1 ? 'gravação aguarda' : 'gravações aguardam'} envio para a nuvem há mais tempo que o esperado.`,
      });
    }

    if (infraHealth) {
      for (const issue of infraHealth.issues) {
        if (issue.startsWith('disk:')) continue; // disco já coberto pelos alerts acima
        const critical = /^(live:|container:|api:|web:|security:|site-cameras:)/.test(issue);
        alerts.push({
          level: critical ? 'critical' : 'warning',
          code: `infra_${issue.split(':')[0]}`,
          message: `Infra: ${issue}`,
        });
      }
      if (infraHealth.stale) {
        alerts.push({
          level: 'warning',
          code: 'infra_watchdog_stale',
          message: 'Watchdog de infra sem atualizar há >15min (pode estar parado).',
        });
      }
    }

    const appReadinessStatus = alerts.some((alert) => alert.level === 'critical')
      ? 'blocked'
      : alerts.length > 0 || !mediamtxOriginsRestricted
        ? 'attention'
        : 'ready';

    // Estado de aplicação, defensivo: se a leitura falhar (banco em recuperação,
    // tabela ausente numa instalação antiga), o heartbeat SEGUE. Ele é a linha
    // de vida com a Central — deixar de reportar por causa de um setting seria
    // trocar um problema pequeno por perder a visibilidade da instalação.
    const applied = await this.readSettings().catch(() => ({} as Record<string, string>));
    const brandingState = await this.getManagedBrandingState().catch(() => null);
    const brandingStateHash = brandingState
      ? createHash('sha256').update(JSON.stringify(brandingState)).digest('hex')
      : null;
    const shouldReportBranding = Boolean(
      brandingStateHash && brandingStateHash !== applied['cloud.brandingReportedHash'],
    );
    return {
      installation: {
        id: process.env.CLOUD_INSTALLATION_ID,
        customerName: process.env.CLOUD_CUSTOMER_NAME || os.hostname(),
        version: process.env.DRAC_VERSION || process.env.npm_package_version || 'local',
        // Endereço público canônico usado pela Central para gerar o app. Em
        // NAT o IP observado é o mesmo para todos os tenants e não identifica
        // o destino; o subdomínio HTTPS configurado no instalador identifica.
        apiUrl: process.env.API_PUBLIC_URL || null,
        launchProfile,
      },
      // O que ESTA instalação de fato aplicou. É o que permite a Central dizer
      // a verdade ("aplicou a revisão 42") em vez de inferir por data.
      configState: {
        appliedRevision: Number(applied['cloud.appliedConfigRevision'] ?? 0) || 0,
        applyStatus: applied['cloud.configApplyStatus'] || 'UNKNOWN',
        applyError: applied['cloud.configApplyError'] || null,
        // Campos que ESTA versão entende. A Central usa isto para não marcar
        // como "pendente para sempre" uma config que a instalação nem conhece.
        supports: ['licenseStatus', 'restrictions', 'aiPolicy', 'cloudStorage', 'branding', 'resourceLimits'],
      },
      ...(shouldReportBranding ? { brandingState, brandingStateHash } : {}),
      summary: {
        status: appReadinessStatus === 'blocked' ? 'blocked' : appReadinessStatus === 'attention' ? 'attention' : 'ok',
        productionReadiness: appReadinessStatus,
        launchProfile,
        cameraTotal: cameraCounts.total,
        cameraOnline: cameraCounts.online,
        cameraOffline: cameraCounts.offline,
        cameraError: cameraCounts.error,
        openAlarms,
        recordingCount: recordings._count.id,
        recordingBytes: Number(recordings._sum.sizeBytes ?? 0),
        lastRecordingStartedAt: recordings._max.startedAt,
        recentRecordingCountLastHour: recentRecordings,
        activeRecordingCount: recordingRuntime?.activeCount ?? activeRecordings,
        recordingCapacityStatus: recordingCapacity.status,
        recordingCapacityEnforced,
        streamHighCpuRiskCameras: streamPerformance?.summary?.highCpuRiskCameras ?? 0,
        streamLiveTranscodeLikely: streamPerformance?.summary?.liveTranscodeLikely ?? 0,
        streamLiveFailuresLast24h: streamPerformance?.summary?.liveFailuresLast24h ?? 0,
        streamMediaMtxReaders: streamPerformance?.summary?.mediaMtxReaders ?? 0,
        streamOptimizationSafeActions: streamPerformance?.optimizationPlan?.safeActionCount ?? 0,
        recordingGapSecondsLast24h: streamPerformance?.summary?.recordingGapSecondsLast24h ?? 0,
        recordingAttentionCameras: streamPerformance?.summary?.camerasWithRecordingAttention ?? 0,
        // Detector de movimento cego com gravação de emergência ligada. Zero é
        // o normal; qualquer valor > 0 é a instalação se defendendo de um
        // detector que parou — e o operador da Central PRECISA ver isso.
        motionFailsafeCameras,
        // Saúde do envio à nuvem (fila, última falha) — só quando configurado.
        ...cloudOffloadMetrics,
        activeUsers,
        diskUsagePercent: disk?.usagePercent ?? null,
        infraHealth: infraHealth
          ? {
              status: infraHealth.status,
              issues: infraHealth.issues,
              selfHealed: infraHealth.selfHealed,
              checkedAt: infraHealth.checkedAt,
              stale: infraHealth.stale,
            }
          : null,
        alerts,
      },
      server: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptimeSeconds: os.uptime(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
        cpuCount: os.cpus().length,
        loadAverage: os.loadavg(),
      },
      storage: {
        recordingsRoot,
        disk,
      },
      // Bloco novo: saúde por câmera para o painel de frota da Central. Sai do
      // payload por completo quando indisponível (a Central trata como "esta
      // instalação ainda não reporta por câmera", não como frota vazia).
      ...(cameraHealth ? { cameras: cameraHealth.cameras } : {}),
      production: {
        launchProfile,
        readiness: {
          status: appReadinessStatus,
          generatedAt: now.toISOString(),
          alerts,
        },
        cameras: cameraOperational,
        recordings: {
          totalCount: recordings._count.id,
          totalBytes: Number(recordings._sum.sizeBytes ?? 0),
          activeCount: recordingRuntime?.activeCount ?? activeRecordings,
          activeDatabaseSegments: activeRecordings,
          recentCountLastHour: recentRecordings,
          lastStartedAt: recordings._max.startedAt,
          runtime: recordingRuntime,
          capacity: recordingCapacity,
          capacityEnforced: recordingCapacityEnforced,
        },
        streams: streamPerformance,
        ai: {
          autoStartEnabled: String(process.env.AI_AUTO_START_ENABLED ?? 'true') !== 'false',
          usesMediamtx: String(process.env.AI_USE_MEDIAMTX ?? 'false') === 'true',
          rtspSubtype: process.env.AI_RTSP_SUBTYPE ?? 'auto',
          analyticsSource: process.env.AI_ANALYTICS_SOURCE ?? 'direct_camera',
        },
        security: {
          cameraTestAllowPublicIp: String(process.env.CAMERA_TEST_ALLOW_PUBLIC_IP ?? 'false') === 'true',
          mediamtxOriginsRestricted,
          hlsAllowOrigin: process.env.MEDIAMTX_HLS_ALLOW_ORIGIN ?? '*',
          webrtcAllowOrigin: process.env.MEDIAMTX_WEBRTC_ALLOW_ORIGIN ?? '*',
          dockerSocketMountedInApi: false,
        },
      },
      time: now.toISOString(),
    };
  }

  private async getCameraCounts() {
    const grouped = await this.prisma.camera.groupBy({
      by: ['status'],
      _count: { id: true },
    });
    const counts = { total: 0, online: 0, offline: 0, error: 0, unknown: 0 };

    for (const row of grouped) {
      const count = row._count.id;
      counts.total += count;
      if (row.status === CameraStatus.ONLINE) counts.online += count;
      if (row.status === CameraStatus.OFFLINE) counts.offline += count;
      if (row.status === CameraStatus.ERROR) counts.error += count;
      if (row.status === CameraStatus.UNKNOWN) counts.unknown += count;
    }

    return counts;
  }

  /**
   * Saúde por câmera para o heartbeat. NUNCA lança: a Central dá por morta a
   * instalação que para de bater, então uma falha aqui (banco lento, serviço
   * ausente no container) só pode custar o bloco novo — jamais o heartbeat.
   */
  private async getCameraHealthForHeartbeat(): Promise<{ cameras: HeartbeatCamerasBlock; alerts: HeartbeatAlert[] } | null> {
    try {
      const observability = this.moduleRef.get(CameraObservabilityService, { strict: false });
      const report = await observability.getCamerasHealth();
      return buildHeartbeatCameras(report, this.getHeartbeatCameraLimit());
    } catch (error) {
      this.logger.warn(
        `Heartbeat sem bloco de saude por camera: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private getHeartbeatCameraLimit() {
    return this.getPositiveInt(process.env.CLOUD_HEARTBEAT_CAMERA_LIMIT, HEARTBEAT_CAMERA_LIMIT_DEFAULT);
  }

  private getRecordingRuntimeSummary() {
    try {
      const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false }) as RecordingProcessManagerService & {
        getRuntimeSummary?: () => unknown;
      };
      return typeof manager.getRuntimeSummary === 'function' ? manager.getRuntimeSummary() : null;
    } catch {
      return null;
    }
  }

  /**
   * Saúde do envio para a nuvem, achatada em métricas de heartbeat. Mesmo
   * princípio do fail-safe abaixo: horas de NoSuchBucket ficaram invisíveis
   * porque nenhum número viajava. Import dinâmico para não criar ciclo de
   * módulos (o offload já importa este serviço); falha vira métricas nulas.
   */
  private async getCloudOffloadMetrics(): Promise<Record<string, unknown>> {
    try {
      const { CloudOffloadService } = await import('../cloud-storage/cloud-offload.service');
      const offload = this.moduleRef.get(CloudOffloadService, { strict: false }) as {
        saudeDoEnvio?: () => Promise<{
          configurado: boolean;
          pendentes: number;
          maisAntigaPendenteSegundos: number | null;
          ultimoEnvioOkHaSegundos: number | null;
          ultimaFalhaCodigo: string | null;
          ultimaFalhaHaSegundos: number | null;
        } | null>;
      };
      const saude = typeof offload.saudeDoEnvio === 'function' ? await offload.saudeDoEnvio() : null;
      if (!saude || !saude.configurado) return {};
      return {
        cloudUploadPending: saude.pendentes,
        cloudUploadOldestPendingSeconds: saude.maisAntigaPendenteSegundos,
        cloudUploadLastSuccessAgeSeconds: saude.ultimoEnvioOkHaSegundos,
        cloudUploadLastErrorCode: saude.ultimaFalhaCodigo,
        cloudUploadLastErrorAgeSeconds: saude.ultimaFalhaHaSegundos,
        // Objetos que SUMIRAM do bucket com ele saudável — apagados por fora.
        cloudCopiesMissing: (saude as { sumidasDaNuvem?: number }).sumidasDaNuvem ?? 0,
      };
    } catch {
      return {};
    }
  }

  /**
   * Quantas câmeras estão gravando por FAIL-SAFE agora (detector de movimento
   * cego). Este número precisa viajar no heartbeat: o episódio real ficou
   * invisível — 9 câmeras cegas por horas e a Central mostrando tudo normal,
   * porque nenhuma métrica carregava essa informação. O dono só fica sabendo
   * de um defeito que a Central consegue enxergar.
   */
  private getMotionFailsafeCount(): number {
    try {
      const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false }) as RecordingProcessManagerService & {
        camerasEmFailsafeCego?: () => string[];
      };
      return typeof manager.camerasEmFailsafeCego === 'function' ? manager.camerasEmFailsafeCego().length : 0;
    } catch {
      return 0;
    }
  }

  private async getStreamPerformanceSummary() {
    try {
      const advisor = this.moduleRef.get(StreamResourceAdvisorService, { strict: false });
      const report = await advisor.getFleetReport();
      return {
        generatedAt: report.generatedAt,
        summary: report.summary,
        recommendations: report.recommendations.slice(0, 8).map((item: any) => ({
          code: item.code,
          severity: item.severity,
          message: item.message,
          action: item.action,
          cameras: Array.isArray(item.cameras) ? item.cameras.slice(0, 8) : [],
        })),
        optimizationPlan: {
          safeActionCount: report.optimizationPlan.safeActionCount,
          manualActionCount: report.optimizationPlan.manualActionCount,
          canApplySafely: report.optimizationPlan.canApplySafely,
        },
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        summary: {
          highCpuRiskCameras: 0,
          liveTranscodeLikely: 0,
          liveFailuresLast24h: 0,
          mediaMtxReaders: 0,
          recordingGapSecondsLast24h: 0,
          camerasWithRecordingAttention: 0,
        },
        recommendations: [],
        optimizationPlan: {
          safeActionCount: 0,
          manualActionCount: 0,
          canApplySafely: false,
        },
      };
    }
  }

  private async getCameraOperationalStats() {
    const [
      total,
      recordingEnabled,
      recordingContinuous,
      aiEnabled,
      audioEnabled,
      byLiveProtocol,
      byLiveSubtype,
      byRecordingSubtype,
      byAnalyticsSubtype,
      byDetectedCodec,
    ] = await Promise.all([
      this.prisma.camera.count(),
      this.prisma.camera.count({ where: { recordingEnabled: true } }),
      this.prisma.camera.count({ where: { recordingEnabled: true, recordingMode: 'continuous' } }),
      this.prisma.camera.count({ where: { aiEnabled: true } }),
      this.prisma.camera.count({ where: { audioEnabled: true } }),
      this.prisma.camera.groupBy({ by: ['preferredLiveProtocol'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['liveSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['recordingSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['analyticsSubtype'], _count: { id: true } }),
      this.prisma.camera.groupBy({ by: ['detectedVideoCodec'], _count: { id: true } }),
    ]);

    return {
      total,
      recordingEnabled,
      recordingContinuous,
      aiEnabled,
      audioEnabled,
      byLiveProtocol: this.groupRowsToRecord(byLiveProtocol, 'preferredLiveProtocol'),
      byLiveSubtype: this.groupRowsToRecord(byLiveSubtype, 'liveSubtype'),
      byRecordingSubtype: this.groupRowsToRecord(byRecordingSubtype, 'recordingSubtype'),
      byAnalyticsSubtype: this.groupRowsToRecord(byAnalyticsSubtype, 'analyticsSubtype'),
      byDetectedCodec: this.groupRowsToRecord(byDetectedCodec, 'detectedVideoCodec'),
    };
  }

  private groupRowsToRecord(rows: Array<Record<string, unknown> & { _count: { id: number } }>, field: string) {
    return Object.fromEntries(
      rows.map((row) => {
        const rawValue = row[field];
        const key = rawValue === null || rawValue === undefined || rawValue === '' ? 'unset' : String(rawValue);
        return [key, row._count.id];
      }),
    );
  }

  private async getRecordingCapacityEstimate(disk: { totalBytes: number | null }) {
    const retentionDays = this.getPositiveInt(process.env.RECORDING_RETENTION_DAYS ?? process.env.RETENTION_DAYS, 7);
    const safeCapacityBytes = disk.totalBytes == null ? null : disk.totalBytes * 0.8;
    let estimatedRequiredBytes = 0;
    let source = 'indisponivel';

    const recordingStats = await this.prisma.recording.aggregate({
      _sum: { sizeBytes: true },
      _min: { startedAt: true },
      _max: { startedAt: true },
    });
    const totalRecordingBytes = Number(recordingStats._sum.sizeBytes ?? 0);
    const minStartedAt = recordingStats._min.startedAt?.getTime() ?? null;
    const maxStartedAt = recordingStats._max.startedAt?.getTime() ?? null;
    const historySeconds = minStartedAt != null && maxStartedAt != null ? Math.max((maxStartedAt - minStartedAt) / 1000, 0) : 0;

    if (totalRecordingBytes > 0 && historySeconds >= 900) {
      estimatedRequiredBytes = (totalRecordingBytes / historySeconds) * 86400 * retentionDays;
      source = 'historical_recording_rate';
    } else {
      const [cameraCount, knownBitrateCount, bitrate] = await Promise.all([
        this.prisma.camera.count(),
        this.prisma.camera.count({ where: { recordingBitrateKbps: { gt: 0 } } }),
        this.prisma.camera.aggregate({ _sum: { recordingBitrateKbps: true } }),
      ]);
      const fallbackKbps = this.getPositiveInt(process.env.RECORDING_CAPACITY_FALLBACK_CAMERA_KBPS, 4096);
      const knownKbps = Number(bitrate._sum.recordingBitrateKbps ?? 0);
      const missingCount = Math.max(cameraCount - knownBitrateCount, 0);
      const estimatedKbps = knownKbps + missingCount * fallbackKbps;
      estimatedRequiredBytes = (estimatedKbps * 1000 * 86400 * retentionDays) / 8;
      source = `configured_bitrate_with_${fallbackKbps}kbps_fallback`;
    }

    const status =
      safeCapacityBytes == null || safeCapacityBytes <= 0
        ? 'unknown'
        : estimatedRequiredBytes > safeCapacityBytes
          ? 'blocked'
          : estimatedRequiredBytes > safeCapacityBytes * 0.7
            ? 'attention'
            : 'ready';

    return {
      status,
      source,
      retentionDays,
      estimatedRequiredBytes: Math.round(estimatedRequiredBytes),
      estimatedRequiredGb: Math.round((estimatedRequiredBytes / 1024 / 1024 / 1024) * 10) / 10,
      safeCapacityBytes: safeCapacityBytes == null ? null : Math.round(safeCapacityBytes),
      safeCapacityGb: safeCapacityBytes == null ? null : Math.round((safeCapacityBytes / 1024 / 1024 / 1024) * 10) / 10,
    };
  }

  private async getDiskStats(path: string) {
    try {
      const disk = await statfs(path);
      const totalBytes = Number(disk.blocks) * Number(disk.bsize);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const usedBytes = Math.max(totalBytes - freeBytes, 0);
      return {
        totalBytes,
        usedBytes,
        freeBytes,
        usagePercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
      };
    } catch (error) {
      return {
        totalBytes: null,
        usedBytes: null,
        freeBytes: null,
        usagePercent: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async readSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: SETTING_KEYS } },
    });

    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  private async writeSetting(key: string, value: string) {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /**
   * Aplica o subconjunto simples de marca administrado pela Central. A
   * validação definitiva continua no SettingsService, a mesma usada pela tela
   * local, para que nenhum payload remoto consiga contornar limite de imagem
   * ou formato de cor.
   */
  private async applyManagedBranding(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Identidade visual recebida da Central é inválida.');
    }
    const source = raw as Record<string, unknown>;
    const facilityName = String(source.facilityName || '').trim();
    if (!facilityName) throw new Error('Identidade visual recebida sem nome da instalação.');
    const useDefaultColors = source.brandUseDefaultColors === true;
    const primaryColor = String(source.brandPrimaryColor || '').trim();
    const settings = this.moduleRef.get(SettingsService, { strict: false });
    await settings.patch({
      facilityName,
      brandLogoDataUrl: String(source.brandLogoDataUrl || '').trim(),
      brandMobileLogoScale: Number(source.brandMobileLogoScale ?? 1),
      brandUseDefaultColors: useDefaultColors,
      brandPrimaryColor: primaryColor,
      brandBackgroundColor: String(source.brandBackgroundColor || '').trim(),
      // O editor da Central é deliberadamente simples. Limpar os overrides
      // avançados impede que uma personalização antiga (gradiente, cards,
      // textos ou estados) continue escondida e produza o visual exagerado que
      // este editor existe para evitar.
      brandBackgroundColor2: '',
      brandSecondaryColor: '',
      brandPrimaryTextColor: '',
      brandSecondaryTextColor: '',
      brandBackgroundTextColor: '',
      brandMenuColor: '',
      brandMenuTextColor: '',
      brandButtonTextColor: '',
      brandBorderColor: '',
      brandSuccessColor: '',
      brandWarningColor: '',
      brandDangerColor: '',
      // Uma única escolha de destaque vale também no tema claro; o fundo claro
      // e suas superfícies continuam nos padrões neutros do produto.
      brandLightPrimaryColor: useDefaultColors ? '#2563eb' : primaryColor,
    });
  }

  /** Snapshot mínimo da marca local para a Central preencher seu editor. */
  private async getManagedBrandingState() {
    const settings = this.moduleRef.get(SettingsService, { strict: false });
    const branding = await settings.getBranding();
    return {
      facilityName: String(branding.facilityName || '').trim(),
      brandLogoDataUrl: String(branding.brandLogoDataUrl || '').trim(),
      brandMobileLogoScale: Number(branding.brandMobileLogoScale ?? 1),
      brandUseDefaultColors: branding.brandUseDefaultColors === true,
      brandPrimaryColor: String(branding.brandPrimaryColor || '').trim().toLowerCase(),
      brandBackgroundColor: String(branding.brandBackgroundColor || '').trim().toLowerCase(),
    };
  }

  private parseJsonSetting(value: string | undefined, fallback: unknown) {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  /**
   * Registra o MAIOR instante que esta instalação já observou.
   *
   * É a defesa contra atrasar o relógio da máquina para ganhar dias de licença:
   * a conta de "dias sem contato" nunca usa um agora anterior a esta marca.
   * Só cresce — data menor é ignorada, que é exatamente o caso de quem voltou
   * o relógio.
   */
  /**
   * Teto de câmeras vindo da Central, em texto para o `SystemSetting`.
   *
   * A ARMADILHA, que me pegou três vezes num dia: `Number(null)` e `Number('')`
   * devolvem 0 em JavaScript, e 0 aqui significa "nenhuma câmera permitida".
   * A primeira versão disto gravou `0` na Vibe e travou o cadastro de câmeras
   * de uma instalação que não tem teto nenhum.
   *
   * Só vira número quando a Central mandou um NÚMERO de verdade. Ausente, nulo
   * ou ilegível vira vazio, que a política lê como "sem teto" — errar para este
   * lado custa uma cobrança a menos; errar para o outro trava o cliente.
   */
  private tetoDeCameras(valor: unknown): string {
    if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0) {
      return String(Math.floor(valor));
    }
    if (typeof valor === 'string' && valor.trim() !== '') {
      const n = Number(valor.trim());
      if (Number.isFinite(n) && n >= 0) return String(Math.floor(n));
    }
    return '';
  }

  /**
   * O que fazer com o perfil de VPN que a Central mandou.
   *
   * A API NÃO monta túnel: ela registra a decisão e o perfil, e quem aplica é o
   * script do host (`infra/vpn/aplicar-vpn.sh`), com privilégio para mexer em
   * rota. Serviço em contêiner reconfigurando a rede do host seria poder demais
   * pelo caminho errado — e a instalação inteira depende dessa rede.
   *
   * A recusa é registrada com motivo: perfil que pede rota padrão, faixa
   * inválida ou sem prova de vida NÃO é aplicado, e o operador precisa saber
   * por quê.
   */
  private async avaliarVpn(perfil: unknown) {
    const aplicadaBruta = await this.prisma.systemSetting
      .findUnique({ where: { key: 'cloud.vpnRevisaoAplicada' } })
      .catch(() => null);
    const aplicada = aplicadaBruta?.value ? Number(aplicadaBruta.value) : null;
    const decisao = decidirSobreVpn(perfil as PerfilDeVpn | null, Number.isFinite(aplicada as number) ? aplicada : null);

    await this.writeSetting('cloud.vpnDecisao', decisao.acao);
    await this.writeSetting('cloud.vpnMotivo', decisao.motivo + (decisao.detalhe ? `: ${decisao.detalhe}` : ''));
    if (decisao.acao === 'recusar') {
      this.logger.error(
        `Perfil de VPN RECUSADO (${decisao.motivo}${decisao.detalhe ? `: ${decisao.detalhe}` : ''}). `
        + 'O túnel NÃO foi montado.',
      );
    }
    return decisao;
  }

  private async marcarInstante() {
    const agora = Date.now();
    const atual = await this.prisma.systemSetting
      .findUnique({ where: { key: 'cloud.maiorInstanteVisto' } })
      .catch(() => null);
    const anterior = atual?.value ? Date.parse(atual.value) : 0;
    if (Number.isFinite(anterior) && anterior >= agora) return;
    await this.writeSetting('cloud.maiorInstanteVisto', new Date(agora).toISOString());
  }

  private normalizeLicenseStatus(value: unknown): LicenseStatus {
    if (value === 'ACTIVE' || value === 'GRACE' || value === 'RESTRICTED' || value === 'SUSPENDED') return value;
    return 'UNKNOWN';
  }

  /**
   * Valida o storage vindo da Central antes de persistir.
   *
   * Config pela metade é tratada como AUSENTE: aceitar um bucket sem credencial
   * (ou sem endpoint) faria a instalação tentar subir gravação para lugar
   * nenhum, falhando em laço e enchendo o log — enquanto o operador acha que
   * provisionou. Melhor não ligar do que ligar quebrado.
   */
  private normalizeCloudStorage(raw: unknown): CloudStorageConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    if (source.enabled !== true) return null;

    const text = (key: string) => String(source[key] ?? '').trim();
    const endpoint = text('endpoint');
    const bucket = text('bucket');
    const accessKeyId = text('accessKeyId');
    const secretAccessKey = text('secretAccessKey');
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    if (!/^https?:\/\//i.test(endpoint)) return null;

    const mode = source.mode === 'mount' ? 'mount' : 'tier';
    const windowHours = Number(source.localWindowHours);
    return {
      enabled: true,
      // Preservado do payload da Central: era descartado aqui, e por isso o
      // resolvedor rotulava TODOS os storages de "Storage principal" — depois
      // de uma troca, o antigo e o novo ficavam idênticos na tela.
      name: text('name'),
      // Paralelismo do envio, escolhido na Central. Fora da faixa cai no padrão:
      // valor absurdo vindo de fora não pode virar pico de memória nem afogar o
      // link do cliente.
      uploadConcurrency: (() => {
        const n = Number(source.uploadConcurrency);
        return Number.isFinite(n) && n >= 1 && n <= 64 ? Math.round(n) : 6;
      })(),
      mode,
      provider: text('provider') || 's3',
      endpoint,
      region: text('region') || 'us-east-1',
      bucket,
      prefix: text('prefix'),
      accessKeyId,
      secretAccessKey,
      localWindowHours: Number.isFinite(windowHours) && windowHours >= 1 && windowHours <= 720
        ? Math.round(windowHours)
        : 24,
      forcePathStyle: source.forcePathStyle !== false,
      updatedAt: text('updatedAt') || null,
    };
  }

  /** Config vigente, para quem precisa falar com o bucket. */
  /**
   * Valor do estado, com o padrão CONSERVADOR para Central antiga.
   *
   * Central que não manda o campo cai em `disabled`: sem storage provisionado,
   * a instalação para de enviar e ninguém assume o lugar. O erro caro seria o
   * inverso — promover um storage arquivado sozinho, ressuscitando um contrato
   * que o cliente já cancelou e voltando a gerar custo.
   */
  private normalizeStorageState(raw: unknown): CloudStorageState {
    const valor = String(raw ?? '').trim();
    return valor === 'configured' || valor === 'absent' ? valor : 'disabled';
  }

  /** Por que não há storage provisionado — veja `normalizeStorageState`. */
  async getCloudStorageState(): Promise<CloudStorageState> {
    const settings = await this.readSettings();
    return this.normalizeStorageState(settings['cloud.storageState']);
  }

  /**
   * Cifra a secret antes de persistir em SystemSetting. Prefixo `enc:` marca o
   * formato; valor legado em claro continua sendo lido (e é recifrado no
   * próximo heartbeat). Falha de cifra mantém o comportamento antigo — perder
   * a config custaria o offload inteiro, o que é pior que o risco em repouso.
   */
  private cifrarSegredoStorage<T extends { secretAccessKey?: unknown }>(cloudStorage: T): T {
    const secret = cloudStorage?.secretAccessKey;
    if (typeof secret !== 'string' || !secret || secret.startsWith('enc:')) return cloudStorage;
    try {
      const crypto = this.moduleRef.get(CryptoService, { strict: false });
      return { ...cloudStorage, secretAccessKey: `enc:${crypto.encrypt(secret)}` };
    } catch {
      return cloudStorage;
    }
  }

  /** Storages que a Central excluiu (endpoint/bucket/prefixo de cada um). */
  async getCloudStorageRemovals(): Promise<Array<{ endpoint?: string; bucket?: string; prefix?: string }>> {
    const settings = await this.readSettings();
    const raw = settings['cloud.storageRemovals'];
    if (!raw) return [];
    try {
      const lista = JSON.parse(raw);
      return Array.isArray(lista) ? lista : [];
    } catch {
      return [];
    }
  }

  async getCloudStorageConfig(): Promise<CloudStorageConfig | null> {
    const settings = await this.readSettings();
    const raw = settings['cloud.storage'];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { secretAccessKey?: unknown };
      if (typeof parsed?.secretAccessKey === 'string' && parsed.secretAccessKey.startsWith('enc:')) {
        try {
          const crypto = this.moduleRef.get(CryptoService, { strict: false });
          parsed.secretAccessKey = crypto.decrypt(parsed.secretAccessKey.slice(4));
        } catch {
          // Chave mestra trocada sem a legada: usar o cifrado como senha só
          // geraria SignatureDoesNotMatch silencioso. Melhor parar e gritar.
          this.logger.error(
            'Credencial do storage em SystemSetting está ILEGÍVEL (a chave mestra mudou?). '
            + 'O envio à nuvem fica parado até o próximo heartbeat trazer a credencial de novo.',
          );
          return null;
        }
      }
      return this.normalizeCloudStorage(parsed);
    } catch {
      // Setting corrompido não pode derrubar quem consulta: tratar como
      // "sem storage" é o comportamento seguro.
      return null;
    }
  }

  private async enforceRuntimeRestrictions(restrictions: Record<string, unknown>) {
    if (restrictions.localRecording === false) {
      try {
        const manager = this.moduleRef.get(RecordingProcessManagerService, { strict: false });
        await manager.stopAll();
      } catch (error) {
        this.logger.warn(`Falha ao parar gravacoes por restricao comercial: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.enforceAiRestrictions(restrictions);
  }

  /**
   * Aplica a política de IA vinda da Central.
   *
   * ⚠️ ARMADILHA que este método existe para evitar: antes, QUALQUER
   * `aiAdvanced:false` derrubava TODA a IA via stopAll(). Com a política
   * granular, "somente movimento" (o estado desejado e mais comum) produz
   * `aiAdvanced:false` — e o stopAll cego mataria também o MOG2, que é o que ARMA
   * a gravação por movimento. Resultado: câmeras armadas parariam de gravar
   * silenciosamente. Por isso a decisão é tomada por CAPACIDADE, não pelo campo
   * legado.
   *
   * COMPATIBILIDADE: uma Central antiga não envia as chaves granulares. Nesse
   * caso preservamos o comportamento histórico (aiAdvanced:false ⇒ para tudo),
   * senão uma restrição comercial legítima deixaria de ser aplicada.
   */
  private async enforceAiRestrictions(restrictions: Record<string, unknown>) {
    const hasGranular = 'aiMotion' in restrictions || 'aiObject' in restrictions || 'aiFace' in restrictions;

    const mustStopEverything = hasGranular
      // Movimento é a base: sem ele, nenhuma análise deve rodar.
      ? restrictions.aiMotion === false
      // Central antiga: comportamento histórico.
      : restrictions.aiAdvanced === false;

    if (!mustStopEverything) {
      // OBJETO/FACE PROIBIDOS: rebaixar para MOVIMENTO — de verdade.
      //
      // Este ramo só REGISTRAVA no log e voltava. O dono desligou a detecção de
      // objeto na Central (17/08/2026), a política chegou correta
      // (`aiAdvanced:false, aiObject:false`), o log apareceu a cada minuto — e
      // a IA seguiu em modo `general`, com 70% de CPU detectando pessoa. A
      // decisão comercial não tinha braço: quem manda parar não parava nada.
      //
      // A checagem que rebaixa o modo existe em `performSyncAll`, mas só roda
      // quando ALGUÉM dispara uma sincronização. Mudança de política na Central
      // não disparava nada — então valia só no próximo reinício da API.
      if (hasGranular && restrictions.aiObject !== true && restrictions.aiFace !== true) {
        this.logger.log('Política da Central: somente detecção de MOVIMENTO habilitada (objeto/face desligados).');
        try {
          const ai = this.moduleRef.get(AiManagerService, { strict: false });
          const r = await ai.rebaixarParaMovimentoPorPolitica();
          if (r.mudou) {
            this.logger.warn(
              `Política da Central: objeto/face desligados — IA rebaixada de "${r.modoAnterior}" para movimento.`,
            );
          }
        } catch (error) {
          this.logger.warn(
            `Falha ao rebaixar a IA para movimento por política da Central: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return;
    }

    try {
      const aiService = this.moduleRef.get(AiService, { strict: false });
      await aiService.stopAll();
      this.logger.warn('Toda a IA foi parada por política da Central (movimento desabilitado).');
    } catch (error) {
      this.logger.warn(`Falha ao parar IA por restricao comercial: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyStatusCaps(status: LicenseStatus, restrictions: Record<string, unknown>) {
    if (status === 'SUSPENDED') {
      return {
        ...restrictions,
        localLive: false,
        localRecording: false,
        addCameras: false,
        aiAdvanced: false,
        cloudSupport: false,
        updates: false,
      };
    }
    if (status === 'RESTRICTED') {
      return {
        ...restrictions,
        addCameras: false,
        aiAdvanced: false,
        updates: false,
      };
    }
    return restrictions;
  }

  private getPositiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private getLaunchProfile() {
    const value = String(process.env.DRAC_LAUNCH_PROFILE || 'standard').trim().toLowerCase();
    return value || 'standard';
  }

  private trimTrailingSlash(value: string) {
    return value.trim().replace(/\/+$/, '');
  }
}
