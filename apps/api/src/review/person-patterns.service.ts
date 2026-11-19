import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccessControlService } from '../access-control/access-control.service';
import { AuthUser } from '../common/types/auth-user.type';

const TYPES = ['OBJECT_DETECTED', 'PERSON_BOX_REVIEW'];
const PREFIX = 'ai.personPatterns.';
type Box = [number, number, number, number];
type Pattern = { eventId: string; box: Box };
type EventRow = { id: string; occurredAt: Date; metadata: Prisma.JsonValue; type: string };

export function personExample(row: EventRow) {
  const meta = row.metadata as Record<string, unknown> | null;
  if (!TYPES.includes(row.type) || !meta || meta.estimated === true || meta.observedByModel === false ||
      !['pessoa', 'person'].includes(String(meta.label ?? meta.semanticLabel).toLowerCase())) return null;
  const { frameWidth: w, frameHeight: h, bbox } = meta;
  const score = meta.confidence ?? meta.semanticConfidence;
  if (typeof score !== 'number' || !(score > 0 && score <= 1) || typeof w !== 'number' || !(w > 0) ||
      typeof h !== 'number' || !(h > 0) || !Array.isArray(bbox) || bbox.length !== 4 ||
      !bbox.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const box: Box = [bbox[0]/w,bbox[1]/h,bbox[2]/w,bbox[3]/h];
  if (box.some(v => !Number.isFinite(v) || v < 0 || v > 1) || box[0]>=box[2] || box[1]>=box[3]) return null;
  return { id: row.id, at: row.occurredAt, box, score, reported: meta.personReviewReported === true,
    suspect: meta.sceneReview === 'unconfirmed' };
}

function readPatterns(value?: string): Pattern[] {
  if (!value) return [];
  return JSON.parse(value) as Pattern[];
}

@Injectable()
export class PersonPatternsService {
  constructor(private readonly db: PrismaService, private readonly access: AccessControlService) {}

  async active() {
    const rows = await this.db.systemSetting.findMany({ where: { key: { startsWith: PREFIX } }, select: { key:true,value:true } });
    return Object.fromEntries(rows.map(r => [r.key.slice(PREFIX.length), readPatterns(r.value).map(p=>p.box)]));
  }

  async capture(input: Record<string, unknown>) {
    const camera = input?.camera;
    if (typeof camera !== 'string' || camera.length > 96) throw new BadRequestException('Câmera inválida.');
    const {bbox, frameWidth, frameHeight, confidence} = input;
    const metadata = {label:'pessoa',bbox,frameWidth,frameHeight,confidence,sceneReview:'unconfirmed'};
    const at = new Date();
    if (!personExample({id:'',type:'PERSON_BOX_REVIEW',occurredAt:at,metadata:metadata as Prisma.JsonValue})) {
      throw new BadRequestException('Exemplo inválido.');
    }
    // Apenas diagnóstico. A criação direta não aciona alarmes, gravação ou contagem.
    await this.db.cameraEvent.create({data:{cameraId:camera,type:'PERSON_BOX_REVIEW',severity:'INFO',
      message:'Caixa de pessoa para revisão',occurredAt:at,metadata:metadata as Prisma.InputJsonValue}});
    return {saved:true};
  }

  private async example(camera: string, event: string) {
    const row = await this.db.cameraEvent.findFirst({ where: {id:event,cameraId:camera,type:{in:TYPES}} });
    const ex = row && personExample(row);
    if (!ex) throw new NotFoundException('Ocorrência de pessoa indisponível.');
    return ex;
  }

  async list(user: AuthUser, camera: string) {
    await this.access.assertCanPlaybackCamera(user,camera);
    const [rows, setting] = await Promise.all([
      this.db.cameraEvent.findMany({where:{cameraId:camera,type:{in:TYPES}},orderBy:{occurredAt:'desc'},take:120}),
      this.db.systemSetting.findUnique({where:{key:PREFIX+camera}}),
    ]);
    return { events: rows.flatMap(r=>personExample(r) ?? []), rules: readPatterns(setting?.value).map(p=>p.eventId) };
  }

  async report(user: AuthUser, camera: string, id: string) {
    await this.access.assertCanPlaybackCamera(user,camera);
    await this.example(camera,id);
    await this.db.$executeRaw`UPDATE "CameraEvent" SET metadata=jsonb_set(metadata,'{personReviewReported}','true') WHERE id=${id} AND "cameraId"=${camera}`;
    return { reported:true };
  }

  async preview(user: AuthUser, camera: string, id: string) {
    await this.access.assertCanPlaybackCamera(user,camera);
    const source = await this.example(camera,id);
    const rows = await this.db.cameraEvent.findMany({where:{cameraId:camera,type:{in:TYPES}},orderBy:{occurredAt:'desc'},take:300});
    const matched = rows.flatMap(r => personExample(r) ?? []).filter(e =>
      e.score <= .65 && e.box.every((v,i)=>Math.abs(v-source.box[i]) <= .025));
    const samples = matched.slice(0,12);
    const items = await Promise.all(samples.map(async e => {
      const recording = await this.db.recording.findFirst({where:{cameraId:camera,startedAt:{lte:e.at},
        OR:[{endedAt:null},{endedAt:{gte:e.at}}]},select:{id:true}});
      return {id:e.id, at:e.at, hasVideo:!!recording};
    }));
    return {checked:rows.length, matched:matched.length, items};
  }

  async change(user: AuthUser, camera: string, id: string, enable: boolean) {
    await this.access.assertCanPlaybackCamera(user,camera);
    await this.access.assertCanAdminCamera(user,camera);
    const src = enable ? await this.example(camera,id) : null;
    if (src && (!src.reported || src.score > .65)) throw new BadRequestException('Marque primeiro uma detecção de até 65% como falso positivo.');
    if (src) {
      const preview = await this.preview(user,camera,id);
      if (!preview.items.some(e=>e.hasVideo)) throw new BadRequestException('Nenhuma gravação disponível para validar este padrão.');
    }
    const key = PREFIX+camera;
    await this.db.$transaction(async tx => {
      const row = await tx.$queryRaw<{id:string}[]>`SELECT id FROM "Camera" WHERE id=${camera} FOR UPDATE`;
      if (!row.length) throw new NotFoundException('Câmera indisponível.');
      const existing = await tx.systemSetting.findUnique({where:{key}});
      const rules = readPatterns(existing?.value).filter(r=>r.eventId!==id);
      if (src) {
        if (rules.length>=8) throw new BadRequestException('Limite de oito padrões por câmera.');
        rules.push({eventId:id, box:src.box});
      }
      if (!rules.length) { await tx.systemSetting.deleteMany({where:{key}}); return; }
      const data = {value:JSON.stringify(rules),updatedByUserId:user.id};
      await tx.systemSetting.upsert({where:{key},create:{key,...data},update:data});
    });
    return {active:enable};
  }
}
