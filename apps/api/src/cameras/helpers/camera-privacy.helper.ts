import { BadRequestException, ConflictException } from '@nestjs/common';
import { CameraPermissionLevel, Prisma } from '@prisma/client';
import { CameraPrivacyDto } from '../dto/camera-privacy.dto';
import { createHash } from 'node:crypto';

export type PrivateCreation = { isPrivate: boolean; ownerUserId: string | null; viewerUserIds?: string[] };
type Client = Pick<Prisma.TransactionClient, 'camera' | 'cameraPermission' | 'user'>;

export const hasPrivacyFields = (dto: CameraPrivacyDto) =>
  dto.isPrivate !== undefined || dto.ownerUserId !== undefined || dto.privateViewerIds !== undefined;

export function cameraPrivacyRevision(camera: { isPrivate: boolean; ownerUserId: string | null; updatedAt: Date }, grants: { userId: string; level: string }[]) {
  return createHash('sha256').update(JSON.stringify([camera.isPrivate, camera.ownerUserId, camera.updatedAt.toISOString(),
    grants.map(grant => [grant.userId, grant.level]).sort((a, b) => a.join(':').localeCompare(b.join(':')))])).digest('hex');
}

async function assertActiveUsers(db: Client, ids: string[]) {
  const users = await db.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  if (users.length !== ids.length) throw new BadRequestException('Escolha um proprietário e usuários ativos desta instalação.');
}

export async function privateCreation(db: Client, dto: CameraPrivacyDto): Promise<PrivateCreation | undefined> {
  if (!hasPrivacyFields(dto)) return undefined;
  if (dto.isPrivate !== true) {
    if (dto.ownerUserId || dto.privateViewerIds?.length) throw new BadRequestException('Proprietário e acesso individual são opções de câmera privada.');
    return { isPrivate: false, ownerUserId: null };
  }
  if (!dto.ownerUserId) throw new BadRequestException('Escolha o proprietário da câmera privada.');
  const viewerUserIds = [...new Set(dto.privateViewerIds ?? [])].filter(id => id !== dto.ownerUserId);
  await assertActiveUsers(db, [dto.ownerUserId, ...viewerUserIds]);
  return { isPrivate: true, ownerUserId: dto.ownerUserId, viewerUserIds };
}

/** Camera + grants are one serializable transaction; no intermediate exposure. */
export async function applyCameraPrivacy(db: Client, id: string, dto: CameraPrivacyDto & { expectedUpdatedAt?: string }) {
  if (dto.privacyConfirmed !== true || !dto.expectedUpdatedAt || !dto.expectedPrivacyRevision) {
    throw new BadRequestException('Confirme a alteração de privacidade antes de salvar.');
  }
  const current = await db.camera.findUniqueOrThrow({ where: { id }, select: { isPrivate: true, ownerUserId: true, updatedAt: true } });
  if (current.updatedAt.toISOString() !== new Date(dto.expectedUpdatedAt).toISOString()) {
    throw new ConflictException('Esta câmera foi alterada. Reabra o cadastro antes de mudar a privacidade.');
  }
  const grants = await db.cameraPermission.findMany({ where: { cameraId: id }, select: { userId: true, level: true } });
  if (cameraPrivacyRevision(current, grants) !== dto.expectedPrivacyRevision) {
    throw new ConflictException('Os acessos desta câmera foram alterados. Reabra o cadastro antes de salvar.');
  }
  const isPrivate = dto.isPrivate ?? current.isPrivate;
  if (!isPrivate && (dto.ownerUserId || dto.privateViewerIds?.length)) {
    throw new BadRequestException('Proprietário e acesso individual são opções de câmera privada.');
  }
  const resolved = await privateCreation(db, {
    isPrivate,
    ownerUserId: isPrivate ? dto.ownerUserId ?? current.ownerUserId ?? undefined : undefined,
    privateViewerIds: isPrivate
      ? dto.privateViewerIds ?? (current.isPrivate ? grants.map(g => g.userId).filter(userId => userId !== current.ownerUserId) : [])
      : [],
  });
  if (!resolved) throw new BadRequestException('Confira a privacidade da câmera.');
  // Common -> private NEVER inherits former individual access or group access.
  // In private mode this list is authoritative; new additional users are VIEW only.
  if (resolved.isPrivate) {
    await db.cameraPermission.deleteMany({ where: { cameraId: id } });
    await db.cameraPermission.createMany({ data: privacyGrants(resolved).map(grant => ({
      ...grant, cameraId: id,
      // Keep explicit advanced permissions of existing delegates; never inherit
      // the previous owner's ADMIN or old common-camera permissions.
      level: current.isPrivate && grant.userId !== current.ownerUserId && grant.userId !== resolved.ownerUserId
        ? grants.find(old => old.userId === grant.userId)?.level ?? grant.level : grant.level,
    })) });
  } else if (current.ownerUserId) {
    // Restore ordinary group rules, without leaving the former owner's ADMIN grant.
    await db.cameraPermission.deleteMany({ where: { cameraId: id, userId: current.ownerUserId } });
  }
  return { isPrivate: resolved.isPrivate, ownerUserId: resolved.ownerUserId };
}

export function privacyGrants(privacy: PrivateCreation) {
  return privacy.isPrivate && privacy.ownerUserId
    ? [{ userId: privacy.ownerUserId, level: CameraPermissionLevel.ADMIN },
       ...(privacy.viewerUserIds ?? []).map(userId => ({ userId, level: CameraPermissionLevel.VIEW }))]
    : [];
}
