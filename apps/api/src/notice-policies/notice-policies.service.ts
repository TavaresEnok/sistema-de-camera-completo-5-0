import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { DEFAULT_SCHEDULE, validSchedule, withinNoticePeriod, type NoticePolicy, type NoticeSchedule } from './notice-period.helper';

const key = (scope:'camera'|'group',id:string) => `detection.notice-policy.v1.${scope}.${id}`;
function decode(value?:string): NoticePolicy {
  if (!value) return {manualMode:'auto',schedule:null};
  const v=JSON.parse(value);
  if(!['auto','on','off'].includes(v.manualMode))throw Error('Invalid stored notice policy');
  return {manualMode:v.manualMode,schedule:v.schedule===null?null:validSchedule(v.schedule)};
}

@Injectable()
export class NoticePoliciesService {
  constructor(private readonly prisma:PrismaService) {}

  async snapshot(ids:string[],now=new Date()) {
    const cameras=await this.prisma.camera.findMany({where:{id:{in:ids}},select:{id:true,enabled:true,motionNoticeEnabled:true,objectNoticeEnabled:true,groupId:true,group:{select:{name:true}}}});
    const keys=[...new Set(cameras.flatMap(c=>[key('camera',c.id),...(c.groupId?[key('group',c.groupId)]:[])]))];
    const rows=await this.prisma.systemSetting.findMany({where:{key:{in:keys}},select:{key:true,value:true}});
    const settings=new Map(rows.map(r=>[r.key,r.value]));
    return cameras.map(c=>{
      const configured=c.enabled&&(c.motionNoticeEnabled||c.objectNoticeEnabled);
      try {
        const own=decode(settings.get(key('camera',c.id)));
        const group=c.groupId?decode(settings.get(key('group',c.groupId))):null;
        const schedule=own.schedule??group?.schedule??DEFAULT_SCHEDULE;
        const active=configured&&own.manualMode!=='off'&&(own.manualMode==='on'||withinNoticePeriod(schedule,now));
        return {cameraId:c.id,configured,active,manualMode:own.manualMode,schedule,source:own.schedule?'camera':c.groupId?'group':'default',groupId:c.groupId,groupName:c.group?.name??null,
          reason:!configured?'not-configured':own.manualMode==='off'?'paused':own.manualMode==='on'?'manual-on':active?'active':'outside-period'};
      } catch {
        return {cameraId:c.id,configured,active:false,manualMode:'off' as const,schedule:DEFAULT_SCHEDULE,source:'default',groupId:c.groupId,groupName:c.group?.name??null,reason:'invalid-policy'};
      }
    });
  }

  async filterFeed<Item extends {cameraId:string;occurredAt:Date|string}>(ids:string[],feed:{items:Item[];cursor:string}) {
    const states=await this.snapshot(ids,new Date(feed.cursor));
    const byId=new Map(states.map(s=>[s.cameraId,s]));
    return {...feed,states,items:feed.items.filter(item=>{
      const state=byId.get(item.cameraId);
      return state?.active&&(state.manualMode==='on'||withinNoticePeriod(state.schedule,new Date(item.occurredAt)));
    })};
  }

  async get(scope:'camera'|'group',id:string) {
    const entity:{id:string;name:string;groupId?:string|null;group?:{name:string}|null}|null=scope==='camera'?await this.prisma.camera.findUnique({where:{id},select:{id:true,name:true,groupId:true,group:{select:{name:true}}}})
      :await this.prisma.cameraGroup.findUnique({where:{id},select:{id:true,name:true}});
    if(!entity)throw new NotFoundException('Câmera ou grupo não encontrado.');
    const row=await this.prisma.systemSetting.findUnique({where:{key:key(scope,id)}});
    let policy:NoticePolicy;
    try {policy=decode(row?.value);}catch{policy={manualMode:'off',schedule:null};}
    const groupId=entity.groupId??null;
    const groupRow=groupId?await this.prisma.systemSetting.findUnique({where:{key:key('group',groupId)}}):null;
    let inheritedSchedule=DEFAULT_SCHEDULE;
    try {inheritedSchedule=decode(groupRow?.value).schedule??DEFAULT_SCHEDULE;}catch{inheritedSchedule={...DEFAULT_SCHEDULE,mode:'off'};}
    return {scope,id,name:entity.name,policy,version:row?.updatedAt.toISOString()??'0',groupId,groupName:entity.group?.name??null,inheritedSchedule};
  }

  async save(scope:'camera'|'group',id:string,input:unknown,userId:string) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new BadRequestException('Configuração inválida.');
    const body=input as Record<string,unknown>;
    if(Object.keys(body).some(k=>!['manualMode','schedule','expectedVersion'].includes(k))||typeof body.expectedVersion!=='string'||body.expectedVersion.length>40)throw new BadRequestException('Reabra a configuração antes de salvar.');
    if(body.manualMode!==undefined&&(typeof body.manualMode!=='string'||!['auto','on','off'].includes(body.manualMode)||scope==='group'))throw new BadRequestException('Controle manual inválido.');
    let schedule:NoticeSchedule|null|undefined;
    try {schedule=body.schedule===undefined?undefined:body.schedule===null?null:validSchedule(body.schedule);}catch(e){throw new BadRequestException((e as Error).message);}
    if(scope==='group'&&schedule===null)throw new BadRequestException('O grupo deve ter uma programação própria.');
    await this.get(scope,id);
    try {
      await this.prisma.$transaction(async tx=>{
        const current=await tx.systemSetting.findUnique({where:{key:key(scope,id)}});
        if((current?.updatedAt.toISOString()??'0')!==body.expectedVersion)throw new ConflictException('Configuração alterada por outra pessoa. Reabra e tente novamente.');
        let old:NoticePolicy;try{old=decode(current?.value);}catch{old={manualMode:'off',schedule:null};}
        const policy={manualMode:(body.manualMode??old.manualMode) as NoticePolicy['manualMode'],schedule:schedule===undefined?old.schedule:schedule};
        const data={value:JSON.stringify(policy),updatedByUserId:userId};
        if(current)await tx.systemSetting.update({where:{key:current.key},data});
        else await tx.systemSetting.create({data:{key:key(scope,id),...data}});
        await tx.auditLog.create({data:{userId,action:`${scope}.notice_policy.update`,entityType:scope==='camera'?'Camera':'CameraGroup',entityId:id,metadata:{before:old,after:policy}}});
      },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    }catch(e){if(['P2002','P2034'].includes(String((e as any)?.code)))throw new ConflictException('Configuração alterada por outra pessoa. Reabra e tente novamente.');throw e;}
    return this.get(scope,id);
  }
}
