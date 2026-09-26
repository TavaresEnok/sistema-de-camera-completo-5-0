import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma, UserRole } from '@prisma/client';
import { Queue } from 'bullmq';
import { existsSync } from 'node:fs';
import { ensureFileUnderRoot } from '../recordings/helpers/safe-file.helper';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user.type';
import { CreateInvestigationDto } from './dto/create-investigation.dto';
import { UpdateInvestigationDto } from './dto/update-investigation.dto';
import { CreateInvestigationItemDto } from './dto/create-investigation-item.dto';
import { UpdateInvestigationItemDto } from './dto/update-investigation-item.dto';
import { UpdateInvestigationLifecycleDto } from './dto/update-investigation-lifecycle.dto';
import { CreateBookmarkDto } from './dto/create-bookmark.dto';
import { EvidenceService } from '../evidence/evidence.service';
import { EVIDENCE_EXPORT_QUEUE } from '../jobs/queues/evidence-export.queue';

@Injectable()
export class InvestigationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evidenceService: EvidenceService,
    @InjectQueue(EVIDENCE_EXPORT_QUEUE) private readonly exportQueue: Queue,
  ) {}
  private readonly allowedLifecycle = new Set(['OPEN', 'IN_REVIEW', 'PENDING_APPROVAL', 'CLOSED', 'ARCHIVED']);

  private normalizeLifecycle(status?: string | null) {
    const raw = String(status ?? 'OPEN').trim().toUpperCase();
    if (raw === 'ACTIVE') return 'IN_REVIEW';
    if (raw === 'REVIEW') return 'IN_REVIEW';
    return this.allowedLifecycle.has(raw) ? raw : 'OPEN';
  }

  private async addActivity(investigationId: string, label: string, actor: { id: string; name: string }, notes?: string | null) {
    await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'activity',
        label,
        timestamp: new Date(),
        notes: notes?.trim() || null,
        metadata: { actorUserId: actor.id, actorUserName: actor.name } as Prisma.InputJsonValue,
      },
    });
  }

  private async getActiveLegalHold(investigationId: string) {
    const latest = await this.prisma.investigationItem.findFirst({
      where: { investigationId, type: 'legal_hold' },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest || !latest.metadata || typeof latest.metadata !== 'object') {
      return { enabled: false, reason: null, recordingIds: [], clipIds: [], itemIds: [] as string[] };
    }
    const m = latest.metadata as Record<string, unknown>;
    const enabled = Boolean(m.enabled);
    const recordingIds = Array.isArray(m.recordingIds) ? m.recordingIds.filter((x): x is string => typeof x === 'string') : [];
    const clipIds = Array.isArray(m.clipIds) ? m.clipIds.filter((x): x is string => typeof x === 'string') : [];
    const itemIds = Array.isArray(m.itemIds) ? m.itemIds.filter((x): x is string => typeof x === 'string') : [];
    return { enabled, reason: typeof m.reason === 'string' ? m.reason : null, recordingIds, clipIds, itemIds };
  }

  private map(investigation: any) {
    const metaItems = Array.isArray(investigation.items)
      ? investigation.items.filter((item: any) => item.type === 'case_meta')
      : [];
    const latestMeta = metaItems.length ? metaItems[metaItems.length - 1] : null;
    const caseMeta = latestMeta?.metadata && typeof latestMeta.metadata === 'object'
      ? (latestMeta.metadata as Record<string, unknown>)
      : {};
    const owner = caseMeta.owner && typeof caseMeta.owner === 'object'
      ? (caseMeta.owner as Record<string, unknown>)
      : null;
    const participants = Array.isArray(caseMeta.participants) ? caseMeta.participants : [];
    return {
      id: investigation.id,
      title: investigation.title,
      status: investigation.status,
      priority: typeof caseMeta.priority === 'string' ? caseMeta.priority : 'NORMAL',
      classification: typeof caseMeta.classification === 'string' ? caseMeta.classification : 'GENERAL',
      ownerUserId: owner && typeof owner.userId === 'string' ? owner.userId : null,
      ownerUserName: owner && typeof owner.userName === 'string' ? owner.userName : null,
      participants,
      summary: investigation.summary,
      selectedCameraIds: Array.isArray(investigation.selectedCameraIds) ? investigation.selectedCameraIds : [],
      timeStart: investigation.timeStart,
      timeEnd: investigation.timeEnd,
      playbackSpeed: investigation.playbackSpeed,
      activeTrackTime: investigation.activeTrackTime,
      createdByUserId: investigation.createdByUserId,
      createdByUserName: investigation.createdByUserName,
      createdAt: investigation.createdAt,
      updatedAt: investigation.updatedAt,
      items: Array.isArray(investigation.items)
        ? investigation.items.map((item: any) => ({
            id: item.id,
            type: item.type,
            label: item.label,
            cameraId: item.cameraId,
            cameraName: item.cameraName,
            eventId: item.eventId,
            recordingId: item.recordingId,
            timestamp: item.timestamp,
            notes: item.notes,
            metadata: item.metadata,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          }))
        : [],
    };
  }

  private async assertAccessible(user: AuthUser, id: string) {
    const investigation = await this.prisma.investigation.findUnique({
      where: { id },
      include: { items: { orderBy: { timestamp: 'asc' } } },
    });
    if (!investigation) throw new NotFoundException('Investigation não encontrada.');
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) return investigation;
    if (investigation.createdByUserId !== user.id) {
      throw new NotFoundException('Investigation não encontrada.');
    }
    return investigation;
  }

  async list(
    user: AuthUser,
    filters?: { q?: string; status?: string; priority?: string; classification?: string; ownerUserId?: string },
  ) {
    const q = filters?.q?.trim();
    const where: Prisma.InvestigationWhereInput =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN
        ? {}
        : { createdByUserId: user.id };
    if (filters?.status) where.status = filters.status;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { summary: { contains: q, mode: 'insensitive' } },
        { createdByUserName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const items = await this.prisma.investigation.findMany({
      where,
      include: { items: { orderBy: { timestamp: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
    });

    const mapped = items.map((item) => this.map(item));
    const filtered = mapped.filter((item) => {
      if (filters?.priority && item.priority !== filters.priority) return false;
      if (filters?.classification && item.classification !== filters.classification) return false;
      if (filters?.ownerUserId && item.ownerUserId !== filters.ownerUserId) return false;
      return true;
    });

    return { items: filtered.slice(0, 50) };
  }

  async create(user: AuthUser, dto: CreateInvestigationDto) {
    const created = await this.prisma.investigation.create({
      data: {
        title: dto.title.trim(),
        status: this.normalizeLifecycle(dto.status),
        summary: dto.summary?.trim() || null,
        selectedCameraIds: dto.selectedCameraIds as unknown as Prisma.InputJsonValue,
        timeStart: new Date(dto.timeStart),
        timeEnd: new Date(dto.timeEnd),
        playbackSpeed: dto.playbackSpeed ?? '1x',
        activeTrackTime: dto.activeTrackTime ?? 0,
        createdByUserId: user.id,
        createdByUserName: user.name,
      },
      include: { items: true },
    });
    await this.addActivity(created.id, 'Investigation criada', { id: user.id, name: user.name }, dto.summary ?? null);
    return this.map(created);
  }

  async findOne(user: AuthUser, id: string) {
    const investigation = await this.assertAccessible(user, id);
    return this.map(investigation);
  }

  async update(user: AuthUser, id: string, dto: UpdateInvestigationDto) {
    await this.assertAccessible(user, id);
    const updated = await this.prisma.investigation.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.status !== undefined ? { status: this.normalizeLifecycle(dto.status) } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary?.trim() || null } : {}),
        ...(dto.selectedCameraIds !== undefined ? { selectedCameraIds: dto.selectedCameraIds as unknown as Prisma.InputJsonValue } : {}),
        ...(dto.timeStart !== undefined ? { timeStart: new Date(dto.timeStart) } : {}),
        ...(dto.timeEnd !== undefined ? { timeEnd: new Date(dto.timeEnd) } : {}),
        ...(dto.playbackSpeed !== undefined ? { playbackSpeed: dto.playbackSpeed } : {}),
        ...(dto.activeTrackTime !== undefined ? { activeTrackTime: dto.activeTrackTime } : {}),
      },
      include: { items: { orderBy: { timestamp: 'asc' } } },
    });
    await this.addActivity(id, 'Investigation atualizada', { id: user.id, name: user.name });
    return this.map(updated);
  }

  async addItem(user: AuthUser, investigationId: string, dto: CreateInvestigationItemDto) {
    await this.assertAccessible(user, investigationId);
    const item = await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: dto.type,
        label: dto.label.trim(),
        cameraId: dto.cameraId ?? null,
        cameraName: dto.cameraName ?? null,
        eventId: dto.eventId ?? null,
        recordingId: dto.recordingId ?? null,
        timestamp: new Date(dto.timestamp),
        notes: dto.notes?.trim() || null,
        metadata: dto.metadata as Prisma.InputJsonValue | undefined,
      },
    });
    await this.addActivity(investigationId, `Evidência adicionada (${dto.type})`, { id: user.id, name: user.name }, dto.label);
    return item;
  }

  async updateItem(user: AuthUser, investigationId: string, itemId: string, dto: UpdateInvestigationItemDto) {
    await this.assertAccessible(user, investigationId);
    const existing = await this.prisma.investigationItem.findFirst({ where: { id: itemId, investigationId } });
    if (!existing) throw new NotFoundException('Item de evidência não encontrado.');
    const updated = await this.prisma.investigationItem.update({
      where: { id: itemId },
      data: {
        ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
      },
    });
    await this.addActivity(investigationId, 'Evidência atualizada', { id: user.id, name: user.name }, updated.label);
    return updated;
  }

  async removeItem(user: AuthUser, investigationId: string, itemId: string) {
    await this.assertAccessible(user, investigationId);
    const hold = await this.getActiveLegalHold(investigationId);
    if (hold.enabled && hold.itemIds.includes(itemId)) {
      throw new BadRequestException('Item protegido por legal hold ativo.');
    }
    const existing = await this.prisma.investigationItem.findFirst({ where: { id: itemId, investigationId } });
    if (!existing) throw new NotFoundException('Item de evidência não encontrado.');
    await this.prisma.investigationItem.delete({ where: { id: itemId } });
    await this.addActivity(investigationId, 'Evidência removida', { id: user.id, name: user.name }, existing.label);
    return { status: 'deleted', id: itemId };
  }

  async listBookmarks(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    const items = await this.prisma.investigationItem.findMany({
      where: { investigationId, type: 'bookmark' },
      orderBy: { timestamp: 'asc' },
    });
    return { items };
  }

  async addBookmark(user: AuthUser, investigationId: string, dto: CreateBookmarkDto) {
    await this.assertAccessible(user, investigationId);
    const created = await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'bookmark',
        label: dto.label.trim(),
        cameraId: dto.cameraId ?? null,
        cameraName: dto.cameraName ?? null,
        timestamp: new Date(dto.timestamp),
        notes: dto.notes?.trim() || null,
      },
    });
    await this.addActivity(investigationId, 'Bookmark adicionado', { id: user.id, name: user.name }, dto.label);
    return created;
  }

  async transitionLifecycle(user: AuthUser, investigationId: string, dto: UpdateInvestigationLifecycleDto) {
    const current = await this.assertAccessible(user, investigationId);
    const nextStatus = this.normalizeLifecycle(dto.status);
    const previousStatus = this.normalizeLifecycle(current.status);
    const lifecycleMetadata: Record<string, unknown> = {
      actorUserId: user.id,
      actorUserName: user.name,
      previousStatus,
      nextStatus,
      changedAt: new Date().toISOString(),
    };
    if (nextStatus === 'CLOSED') {
      lifecycleMetadata.closedAt = new Date().toISOString();
      lifecycleMetadata.closedByUserId = user.id;
      lifecycleMetadata.closedByUserName = user.name;
      lifecycleMetadata.closureNote = dto.note?.trim() || null;
    }
    const updated = await this.prisma.investigation.update({
      where: { id: investigationId },
      data: {
        status: nextStatus,
        ...(dto.summary !== undefined ? { summary: dto.summary.trim() || null } : {}),
        items: {
          create: {
            type: 'lifecycle',
            label: nextStatus === 'CLOSED' ? 'Caso fechado' : `Status alterado para ${nextStatus}`,
            timestamp: new Date(),
            notes: dto.note?.trim() || null,
            metadata: lifecycleMetadata as Prisma.InputJsonValue,
          },
        },
      },
      include: { items: { orderBy: { timestamp: 'asc' } } },
    });
    if (nextStatus === 'CLOSED') {
      await this.addActivity(
        investigationId,
        'Caso fechado e auditado',
        { id: user.id, name: user.name },
        dto.note?.trim() || null,
      );
    }
    return this.map(updated);
  }

  async getClosureTrace(user: AuthUser, investigationId: string) {
    const inv = await this.assertAccessible(user, investigationId);
    const lifecycleItems = Array.isArray(inv.items) ? inv.items.filter((item: any) => item.type === 'lifecycle') : [];
    const closedEntry = [...lifecycleItems].reverse().find((item: any) => {
      if (!item.metadata || typeof item.metadata !== 'object') return false;
      const m = item.metadata as Record<string, unknown>;
      return String(m.nextStatus ?? '').toUpperCase() === 'CLOSED';
    }) ?? null;

    const audit = await this.prisma.auditLog.findMany({
      where: {
        entityType: 'Investigation',
        entityId: investigationId,
        OR: [
          { action: { contains: 'investigation.lifecycle' } },
          { action: { contains: 'investigation.note' } },
          { action: { contains: 'investigation.meta' } },
          { action: { contains: 'investigation.legal_hold' } },
          { action: { contains: 'investigation.export' } },
          { action: { contains: 'investigation.report' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    return {
      investigationId,
      currentStatus: inv.status,
      closed: Boolean(closedEntry),
      closedLifecycleEntry: closedEntry
        ? {
            id: closedEntry.id,
            timestamp: closedEntry.timestamp,
            notes: closedEntry.notes,
            metadata: closedEntry.metadata,
          }
        : null,
      lifecycleCount: lifecycleItems.length,
      auditCount: audit.length,
      auditItems: audit,
    };
  }

  async listNotes(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    const items = await this.prisma.investigationItem.findMany({
      where: { investigationId, type: 'note' },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  }

  async addNote(user: AuthUser, investigationId: string, note: string) {
    await this.assertAccessible(user, investigationId);
    const clean = note.trim();
    if (!clean) throw new BadRequestException('Nota não pode ser vazia.');
    const item = await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'note',
        label: `Nota de ${user.name}`,
        timestamp: new Date(),
        notes: clean,
        metadata: { actorUserId: user.id, actorUserName: user.name } as Prisma.InputJsonValue,
      },
    });
    await this.addActivity(investigationId, 'Nota adicionada', { id: user.id, name: user.name }, clean);
    return item;
  }

  async listActivity(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    const items = await this.prisma.investigationItem.findMany({
      where: { investigationId, type: { in: ['activity', 'lifecycle'] } },
      orderBy: { timestamp: 'desc' },
      take: 200,
    });
    return { items };
  }

  async setLegalHold(
    user: AuthUser,
    investigationId: string,
    dto: { enabled: boolean; reason?: string; recordingIds?: string[]; clipIds?: string[]; itemIds?: string[] },
  ) {
    await this.assertAccessible(user, investigationId);
    const payload = {
      enabled: Boolean(dto.enabled),
      reason: dto.reason?.trim() || null,
      recordingIds: Array.isArray(dto.recordingIds) ? dto.recordingIds.filter((x) => typeof x === 'string') : [],
      clipIds: Array.isArray(dto.clipIds) ? dto.clipIds.filter((x) => typeof x === 'string') : [],
      itemIds: Array.isArray(dto.itemIds) ? dto.itemIds.filter((x) => typeof x === 'string') : [],
      updatedByUserId: user.id,
      updatedByUserName: user.name,
      updatedAt: new Date().toISOString(),
    };
    await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'legal_hold',
        label: payload.enabled ? 'Legal hold ativado' : 'Legal hold desativado',
        timestamp: new Date(),
        notes: payload.reason,
        metadata: payload as Prisma.InputJsonValue,
      },
    });
    await this.addActivity(
      investigationId,
      payload.enabled ? 'Legal hold ativado' : 'Legal hold desativado',
      { id: user.id, name: user.name },
      payload.reason,
    );
    return { investigationId, ...payload };
  }

  async getLegalHold(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    return this.getActiveLegalHold(investigationId);
  }

  async getCustodyChain(user: AuthUser, investigationId: string) {
    const inv = await this.assertAccessible(user, investigationId);
    const relatedRecordingIds = new Set<string>();
    const relatedClipIds = new Set<string>();
    for (const item of inv.items) {
      if (item.recordingId) relatedRecordingIds.add(item.recordingId);
      if (item.metadata && typeof item.metadata === 'object') {
        const m = item.metadata as Record<string, unknown>;
        if (typeof m.clipId === 'string') relatedClipIds.add(m.clipId);
      }
    }

    // Escopo por ITEM desta investigação. Antes, `{ entityType: 'InvestigationItem' }` e
    // `{ action: { contains: 'evidence' } }` vinham SEM entityId: a cadeia de custódia da
    // própria investigação devolvia a trilha de auditoria de TODAS as investigações e
    // todos os tenants (userId, ipAddress, userAgent, metadata) — contornando o gate
    // @RequirePermission('auditLogs'), que é ADMIN-only. Qualquer OPERATOR criava uma
    // investigação vazia e lia 1000 registros globais.
    const itemIds = inv.items.map((item) => item.id);
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'Investigation', entityId: investigationId },
          { entityType: 'InvestigationItem', entityId: { in: itemIds } },
          { entityType: 'Recording', entityId: { in: [...relatedRecordingIds] } },
          { entityType: 'ExportedClip', entityId: { in: [...relatedClipIds] } },
          // 'evidence' desta investigação (assinatura/verificação dos itens dela).
          { action: { contains: 'evidence' }, entityType: 'Investigation', entityId: investigationId },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return { items: logs };
  }

  async buildInvestigationReport(user: AuthUser, investigationId: string) {
    const inv = await this.findOne(user, investigationId);
    const custody = await this.getCustodyChain(user, investigationId);
    const hold = await this.getLegalHold(user, investigationId);
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const itemsHtml = inv.items.map((i: any) => `<tr><td>${esc(i.type)}</td><td>${esc(i.label)}</td><td>${esc(i.cameraName ?? '-')}</td><td>${esc(i.timestamp)}</td></tr>`).join('');
    const custodyHtml = custody.items.map((l: any) => `<tr><td>${esc(l.createdAt)}</td><td>${esc(l.action)}</td><td>${esc(l.entityType)}</td><td>${esc(l.entityId ?? '-')}</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatorio ${esc(inv.title)}</title><style>body{font-family:Arial;padding:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;font-size:12px}th{background:#f2f2f2}</style></head><body><h1>${esc(inv.title)}</h1><p>Status: ${esc(inv.status)} | Prioridade: ${esc((inv as any).priority ?? 'NORMAL')} | Classificacao: ${esc((inv as any).classification ?? 'GENERAL')}</p><p>Legal hold: ${hold.enabled ? 'ATIVO' : 'INATIVO'} ${hold.reason ? `| Motivo: ${esc(hold.reason)}` : ''}</p><h2>Evidencias</h2><table><thead><tr><th>Tipo</th><th>Label</th><th>Camera</th><th>Timestamp</th></tr></thead><tbody>${itemsHtml}</tbody></table><h2>Cadeia de Custodia</h2><table><thead><tr><th>Quando</th><th>Acao</th><th>Entidade</th><th>ID</th></tr></thead><tbody>${custodyHtml}</tbody></table></body></html>`;
    return { investigationId, title: inv.title, generatedAt: new Date().toISOString(), html };
  }

  async listExportRequests(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    const items = await this.prisma.investigationItem.findMany({
      where: { investigationId, type: { in: ['export_request', 'export_package'] } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { items };
  }

  async createExportRequest(
    user: AuthUser,
    investigationId: string,
    dto: {
      reason: string;
      format?: 'MP4' | 'AVI' | 'NATIVE';
      itemIds?: string[];
      recordingIds?: string[];
      clipIds?: string[];
    },
  ) {
    await this.assertAccessible(user, investigationId);
    const reason = dto.reason?.trim() ?? '';
    if (!reason) throw new BadRequestException('Motivo é obrigatório para solicitar exportação.');
    const request = await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'export_request',
        label: `Solicitação de exportação (${dto.format ?? 'MP4'})`,
        timestamp: new Date(),
        notes: reason,
        metadata: {
          status: 'PENDING',
          format: dto.format ?? 'MP4',
          requestedByUserId: user.id,
          requestedByUserName: user.name,
          reason,
          itemIds: dto.itemIds ?? [],
          recordingIds: dto.recordingIds ?? [],
          clipIds: dto.clipIds ?? [],
          reviewedByUserId: null,
          reviewedByUserName: null,
          reviewedAt: null,
        } as Prisma.InputJsonValue,
      },
    });
    await this.addActivity(investigationId, 'Solicitação de exportação criada', { id: user.id, name: user.name }, reason);
    return request;
  }

  async reviewExportRequest(
    user: AuthUser,
    investigationId: string,
    requestId: string,
    dto: { decision: 'APPROVED' | 'REJECTED'; reason: string },
  ) {
    await this.assertAccessible(user, investigationId);
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new BadRequestException('Apenas ADMIN/SUPER_ADMIN podem aprovar ou rejeitar exportação.');
    }
    const reqItem = await this.prisma.investigationItem.findFirst({
      where: { id: requestId, investigationId, type: 'export_request' },
    });
    if (!reqItem) throw new NotFoundException('Solicitação de exportação não encontrada.');
    const reason = dto.reason?.trim() ?? '';
    if (!reason) throw new BadRequestException('Motivo da decisão é obrigatório.');
    const current = reqItem.metadata && typeof reqItem.metadata === 'object' ? (reqItem.metadata as Record<string, unknown>) : {};
    const updated = await this.prisma.investigationItem.update({
      where: { id: requestId },
      data: {
        metadata: {
          ...current,
          status: dto.decision,
          decisionReason: reason,
          reviewedByUserId: user.id,
          reviewedByUserName: user.name,
          reviewedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await this.addActivity(investigationId, `Solicitação de exportação ${dto.decision === 'APPROVED' ? 'aprovada' : 'rejeitada'}`, { id: user.id, name: user.name }, reason);
    return updated;
  }

  async executeExportRequest(user: AuthUser, investigationId: string, requestId: string, reason: string) {
    await this.assertAccessible(user, investigationId);
    const cleanReason = reason?.trim() ?? '';
    if (!cleanReason) throw new BadRequestException('Motivo é obrigatório para executar exportação.');
    const reqItem = await this.prisma.investigationItem.findFirst({
      where: { id: requestId, investigationId, type: 'export_request' },
    });
    if (!reqItem) throw new NotFoundException('Solicitação de exportação não encontrada.');
    const meta = reqItem.metadata && typeof reqItem.metadata === 'object' ? (reqItem.metadata as Record<string, unknown>) : {};
    if (meta.status !== 'APPROVED') {
      throw new BadRequestException('Solicitação ainda não aprovada.');
    }
    const pkg = await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'export_package',
        eventId: requestId,
        label: `Pacote exportado ${new Date().toISOString()}`,
        timestamp: new Date(),
        notes: cleanReason,
        metadata: {
          requestId,
          status: 'QUEUED',
          progress: 0,
          queuedAt: new Date().toISOString(),
          queuedByUserId: user.id,
          queuedByUserName: user.name,
        } as Prisma.InputJsonValue,
      },
    });
    await this.exportQueue.add(
      'execute-export',
      {
        investigationId,
        requestId,
        packageItemId: pkg.id,
        executionReason: cleanReason,
        executedByUserId: user.id,
        executedByUserName: user.name,
      },
      {
        jobId: `export-${pkg.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    await this.addActivity(investigationId, 'Execução de exportação enfileirada', { id: user.id, name: user.name }, cleanReason);
    return pkg;
  }

  async enqueueRetryPendingSignatures(user: AuthUser, investigationId: string) {
    await this.assertAccessible(user, investigationId);
    const pending = await this.prisma.investigationItem.findMany({
      where: { investigationId, type: 'export_package' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    let queued = 0;
    for (const item of pending) {
      const metadata = item.metadata && typeof item.metadata === 'object' ? (item.metadata as Record<string, unknown>) : {};
      if (metadata.status !== 'PENDING_SIGNATURE' || !metadata.payload || typeof metadata.payload !== 'object') continue;
      await this.exportQueue.add(
        'retry-signature',
        {
          investigationId,
          packageItemId: item.id,
        },
        {
          jobId: `retry-sign-${item.id}-${Date.now()}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      queued += 1;
    }
    await this.addActivity(investigationId, 'Reprocessamento de assinatura enfileirado', { id: user.id, name: user.name }, `itens=${queued}`);
    return { investigationId, queued };
  }

  async getExportPackageDownload(user: AuthUser, investigationId: string, packageItemId: string) {
    await this.assertAccessible(user, investigationId);
    const pkg = await this.prisma.investigationItem.findFirst({
      where: { id: packageItemId, investigationId, type: 'export_package' },
    });
    if (!pkg) throw new NotFoundException('Pacote de exportação não encontrado.');
    const metadata = pkg.metadata && typeof pkg.metadata === 'object' ? (pkg.metadata as Record<string, unknown>) : {};
    const artifact = metadata.artifact && typeof metadata.artifact === 'object' ? (metadata.artifact as Record<string, unknown>) : null;
    const rawFilePath = artifact && typeof artifact.filePath === 'string' ? artifact.filePath : null;
    if (!rawFilePath) {
      throw new NotFoundException('Arquivo do pacote ainda não está disponível no storage.');
    }
    // O `metadata` é um JSON livre gravado por `addItem` — ou seja, controlável por quem
    // cria o item (OPERATOR). Sem esta checagem, forjar um item type='export_package' com
    // metadata.artifact.filePath='/proc/self/environ' fazia o download servir QUALQUER
    // arquivo legível pela API (env → JWT_SECRET → token SUPER_ADMIN forjado).
    // O caminho legítimo é sempre escrito por evidence-export.processor sob esta raiz.
    let filePath: string;
    try {
      filePath = ensureFileUnderRoot(
        process.env.EVIDENCE_PACKAGES_ROOT || './storage/evidence-packages',
        rawFilePath,
      );
    } catch {
      throw new NotFoundException('Pacote de exportação não encontrado.');
    }
    if (!existsSync(filePath)) {
      throw new NotFoundException('Arquivo do pacote ainda não está disponível no storage.');
    }
    return {
      filePath,
      fileName: `investigation-${investigationId}-package-${packageItemId}.json`,
      status: typeof metadata.status === 'string' ? metadata.status : 'UNKNOWN',
      artifact,
    };
  }

  async upsertCaseMeta(
    user: AuthUser,
    investigationId: string,
    dto: {
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
      classification?: string;
      ownerUserId?: string | null;
      ownerUserName?: string | null;
      participants?: Array<{ userId: string; userName: string }>;
    },
  ) {
    await this.assertAccessible(user, investigationId);
    const priority = dto.priority ?? 'NORMAL';
    const classification = (dto.classification ?? 'GENERAL').trim() || 'GENERAL';
    const ownerUserId = dto.ownerUserId?.trim() || null;
    const ownerUserName = dto.ownerUserName?.trim() || null;
    const participants = Array.isArray(dto.participants)
      ? dto.participants
          .filter((p) => p && typeof p.userId === 'string' && typeof p.userName === 'string')
          .map((p) => ({ userId: p.userId.trim(), userName: p.userName.trim() }))
          .filter((p) => p.userId && p.userName)
      : [];

    await this.prisma.investigationItem.create({
      data: {
        investigationId,
        type: 'case_meta',
        label: 'Metadados do caso',
        timestamp: new Date(),
        metadata: {
          priority,
          classification,
          owner: ownerUserId && ownerUserName ? { userId: ownerUserId, userName: ownerUserName } : null,
          participants,
          updatedByUserId: user.id,
          updatedByUserName: user.name,
        } as Prisma.InputJsonValue,
      },
    });
    await this.addActivity(investigationId, 'Metadados do caso atualizados', { id: user.id, name: user.name });
    return this.findOne(user, investigationId);
  }
}
