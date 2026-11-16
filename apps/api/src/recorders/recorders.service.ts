import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { type Request } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { assertCameraTargetAllowed } from '../common/network/safe-url.helper';
import { CamerasService } from '../cameras/cameras.service';
import { CommercialPolicyService } from '../commercial-policy/commercial-policy.service';
import { AuditService } from '../audit/audit.service';
import { type AuthUser } from '../common/types/auth-user.type';
import { CreateRecorderDto, ImportRecorderChannelDto, ImportRecorderChannelsDto, UpdateRecorderDto } from './recorders.dto';
import { groupRecorderProfiles, recorderPath } from './recorder-channel.helper';

@Injectable()
export class RecordersService {
  private readonly busy = new Set<string>();
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly cameras: CamerasService,
    private readonly policy: CommercialPolicyService, private readonly audit: AuditService) {}

  private enabled() { if (process.env.RECORDERS_ENABLED !== 'true') throw new NotFoundException('Recurso indisponível nesta instalação.'); }
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new ConflictException('Já existe uma operação em andamento. Aguarde e tente novamente.');
    this.busy.add(key); try { return await work(); } finally { this.busy.delete(key); }
  }
  private async recorder(id: string) {
    this.enabled(); const row = await this.prisma.recorder.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Gravador não encontrado.'); return row;
  }
  async list() {
    this.enabled();
    return this.prisma.recorder.findMany({ orderBy: { name: 'asc' }, select: {
      id: true, name: true, ip: true, rtspPort: true, httpPort: true, onvifPort: true, username: true,
      manufacturer: true, groupId: true, group: { select: { name: true } }, _count: { select: { channels: true } },
    } });
  }
  async detail(id: string) {
    const row = await this.recorder(id);
    const channels = await this.prisma.camera.findMany({ where: { recorderId: id }, orderBy: { channel: 'asc' }, select: {
      id: true, publicId: true, channel: true, name: true, status: true, enabled: true, recordingMode: true,
      isPrivate: true, ownerUserId: true,
    } });
    const { passwordEncrypted: _secret, ...safe } = row;
    const candidates = await this.prisma.camera.findMany({ where: { recorderId: null, isPrivate: false, groupId: row.groupId,
      ip: row.ip, rtspPort: row.rtspPort, username: row.username }, select: { id: true, name: true, channel: true } });
    return { ...safe, channels, candidates };
  }
  async update(id: string, dto: UpdateRecorderDto, actor: AuthUser, req: Request) {
    return this.exclusive(id, async () => {
      const row = await this.recorder(id);
      for (const port of [dto.rtspPort, dto.httpPort, dto.onvifPort].filter((p): p is number => p != null)) assertCameraTargetAllowed(dto.ip, port);
      if (!dto.name.trim() || !dto.username.trim()) throw new BadRequestException('Informe o nome e o usuário.');
      const channels = await this.prisma.camera.findMany({ where: { recorderId: id }, select: { id: true, enabled: true } });
      if (channels.length && (dto.groupId !== row.groupId || dto.manufacturer !== row.manufacturer)) throw new BadRequestException('Não é possível trocar o grupo ou fabricante de um gravador com canais vinculados.');
      const networkChanged = dto.ip !== row.ip || dto.rtspPort !== row.rtspPort || dto.httpPort !== row.httpPort
        || (dto.onvifPort ?? null) !== row.onvifPort || dto.username !== row.username || Boolean(dto.password);
      if (networkChanged && channels.some(c => c.enabled)) throw new BadRequestException('Desative os canais na aba Canais antes de alterar a conexão. Depois, reative-os para usar o novo acesso.');
      const group = await this.prisma.cameraGroup.findUnique({ where: { id: dto.groupId } });
      if (!group || !group.isActive || group.accessStatus !== 'ACTIVE') throw new BadRequestException('Selecione um grupo ativo.');
      const { password, ...data } = dto;
      const secret = password ? this.crypto.encrypt(password) : row.passwordEncrypted;
      await this.prisma.$transaction(async tx => {
        await tx.recorder.update({ where: { id }, data: { ...data, onvifPort: dto.onvifPort ?? null, name: data.name.trim(), passwordEncrypted: secret } });
        if (networkChanged) await tx.camera.updateMany({ where: { recorderId: id }, data: {
          ip: dto.ip, rtspPort: dto.rtspPort, httpPort: dto.httpPort, onvifPort: dto.onvifPort ?? null,
          username: dto.username, passwordEncrypted: secret,
        } });
      });
      await this.audit.log(actor.id, 'recorder.update', 'Recorder', id, { connectionChanged: networkChanged }, req);
      return this.detail(id);
    });
  }
  async link(id: string, cameraId: string, actor: AuthUser, req: Request) {
    return this.exclusive(id, async () => {
      const row = await this.recorder(id);
      const camera = await this.prisma.camera.findUnique({ where: { id: cameraId } });
      if (!camera || camera.isPrivate || camera.sourceMode !== 'rtsp_pull' || camera.recorderId
        || camera.ip !== row.ip || camera.rtspPort !== row.rtspPort || camera.username !== row.username || camera.groupId !== row.groupId
        || this.crypto.decrypt(camera.passwordEncrypted) !== this.crypto.decrypt(row.passwordEncrypted)) {
        throw new BadRequestException('Vincule somente canais do mesmo endereço, grupo e credencial. Câmeras privadas não podem ser vinculadas por este fluxo.');
      }
      if (camera.motionTrigger === 'CAMERA' || camera.hasEdgeAi) throw new BadRequestException('Este canal usa eventos do equipamento. Mantenha o cadastro atual até a etapa de eventos DVR/NVR.');
      if (await this.prisma.camera.findUnique({ where: { recorderId_channel: { recorderId: id, channel: camera.channel } } })) throw new ConflictException('Este canal já está vinculado.');
      await this.prisma.camera.update({ where: { id: cameraId }, data: { recorderId: id } });
      await this.audit.log(actor.id, 'recorder.channel.link', 'Camera', cameraId, { recorderId: id, channel: camera.channel }, req);
      return { ok: true };
    });
  }
  async create(dto: CreateRecorderDto, actor: AuthUser, req: Request) {
    this.enabled(); await this.policy.assertFeature('addCameras', actor);
    if (!dto.name.trim() || !dto.username.trim()) throw new BadRequestException('Informe o nome e o usuário.');
    for (const port of [dto.rtspPort, dto.httpPort, dto.onvifPort].filter((p): p is number => p != null)) assertCameraTargetAllowed(dto.ip, port);
    const group = await this.prisma.cameraGroup.findUnique({ where: { id: dto.groupId } });
    if (!group || !group.isActive || group.accessStatus !== 'ACTIVE') throw new BadRequestException('Selecione um grupo ativo.');
    const existing = await this.prisma.recorder.findFirst({ where: { ip: dto.ip, rtspPort: dto.rtspPort, username: dto.username } });
    if (existing) throw new ConflictException('Este gravador já está cadastrado. Abra o cadastro existente.');
    const { password, ...data } = dto;
    const recorder = await this.prisma.recorder.create({ data: { ...data, name: data.name.trim(), passwordEncrypted: this.crypto.encrypt(password) } });
    await this.audit.log(actor.id, 'recorder.create', 'Recorder', recorder.id, { name: recorder.name, groupId: recorder.groupId }, req);
    return this.detail(recorder.id);
  }
  async discover(id: string) {
    return this.exclusive(id, async () => {
      const row = await this.recorder(id);
      const profiles = await this.cameras.discoverRecorderProfiles({ host: row.ip, port: row.onvifPort ?? row.httpPort,
        username: row.username, password: this.crypto.decrypt(row.passwordEncrypted) });
      const channels = groupRecorderProfiles(profiles);
      return { channels, message: channels.length ? 'Confira os canais e verifique o vídeo antes de importar.' : 'A descoberta ONVIF não identificou canais. Você pode adicioná-los manualmente.',
        // Never present partial, timeout-bounded discovery as a complete equipment inventory.
        complete: false };
    });
  }
  private connection(row: Awaited<ReturnType<RecordersService['recorder']>>, dto: ImportRecorderChannelDto) {
    let rtspPath: string;
    try { rtspPath = recorderPath(row.manufacturer, dto.channel, dto.rtspPath); } catch (error) { throw new BadRequestException((error as Error).message); }
    return { ip: row.ip, rtspPort: row.rtspPort, httpPort: row.httpPort, onvifPort: row.onvifPort ?? undefined,
      username: row.username, password: this.crypto.decrypt(row.passwordEncrypted), rtspPath, channel: dto.channel,
      subtype: Number(/[?&]subtype=(\d+)/i.exec(rtspPath)?.[1] ?? 0) };
  }
  async check(id: string, dto: ImportRecorderChannelDto, actor: AuthUser) {
    return this.exclusive(id, async () => {
      await this.policy.assertFeature('addCameras', actor);
      const row = await this.recorder(id); const connection = this.connection(row, dto);
      await this.cameras.verifyRecorderChannel(connection);
      const frame = await this.cameras.capturePreviewFrame(connection, { strictPath: true });
      return { ok: true, frame };
    });
  }
  async import(id: string, dto: ImportRecorderChannelsDto, actor: AuthUser, req: Request) {
    this.enabled();
    return this.exclusive('import', () => this.exclusive(id, async () => {
      const row = await this.recorder(id);
      await this.policy.assertFeature('addCameras', actor);
      const group = await this.prisma.cameraGroup.findUnique({ where: { id: row.groupId } });
      if (!group || !group.isActive || group.accessStatus !== 'ACTIVE') throw new BadRequestException('O grupo deste gravador está inativo ou suspenso.');
      await this.policy.assertRetentionQuota(group.retentionDays);
      const results: Array<{ channel: number; name: string; status: string; cameraId?: string; message?: string }> = [];
      const inputs = [...new Map(dto.channels.map(c => [c.channel, c])).values()];
      for (const item of inputs) {
        const previous = await this.prisma.camera.findUnique({ where: { recorderId_channel: { recorderId: id, channel: item.channel } } });
        if (previous) { results.push({ channel: item.channel, name: previous.name, status: 'existing', cameraId: previous.id }); continue; }
        try {
          await this.policy.assertFeature('addCameras', actor);
          await this.policy.assertCameraQuota(1, actor);
          const connection = this.connection(row, item);
          // Same IP alone is not a duplicate: a recorder serves many channels.
          const existing = await this.prisma.camera.findFirst({ where: { ip: row.ip, rtspPort: row.rtspPort, channel: item.channel, username: row.username, recorderId: null } });
          if (existing) {
            results.push({ channel: item.channel, name: item.name, status: 'error', message: 'Este canal pode já estar cadastrado em Câmeras. Vincule o cadastro existente para preservar o histórico.' }); continue;
          }
          const camera = await this.cameras.create({ ...connection, name: item.name.trim(), groupId: row.groupId,
            liveChannel: item.channel, recordingChannel: item.channel, analyticsChannel: item.channel,
            // Use the confirmed stream for all consumers; no guessed substream from another channel.
            subtype: connection.subtype, liveSubtype: connection.subtype, recordingSubtype: connection.subtype, analyticsSubtype: connection.subtype,
            recordingEnabled: false, recordingMode: 'manual', aiEnabled: false,
            motionNoticeEnabled: false, objectNoticeEnabled: false, noticeSoundEnabled: false,
            retentionDays: group.retentionDays, retentionFollowsGroup: true, recordingVideoCodec: 'original',
          }, undefined, id);
          await this.audit.log(actor.id, 'recorder.channel.import', 'Camera', camera.id, { recorderId: id, channel: item.channel }, req);
          results.push({ channel: item.channel, name: item.name, status: 'created', cameraId: camera.id });
        } catch (error) {
          // Vendor/ffprobe exception text may embed credentials; only known validation messages are returned.
          const message = error instanceof BadRequestException ? error.message : 'Não foi possível importar. Confira conexão, limite contratado e permissões.';
          results.push({ channel: item.channel, name: item.name, status: 'error', message });
        }
      }
      return { results };
    }));
  }
}
