import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validSchedule, withinNoticePeriod, DEFAULT_SCHEDULE } from '../src/notice-policies/notice-period.helper';
import { NoticePoliciesService } from '../src/notice-policies/notice-policies.service';
import { NoticePoliciesController } from '../src/notice-policies/notice-policies.controller';

const night=validSchedule({mode:'periods',timezone:'America/Fortaleza',periods:[{days:[1],start:'22:00',end:'06:00'}]});
test('overnight uses start weekday and inclusive/exclusive boundaries in the selected timezone',()=>{
  for(const [at,expected] of [
    ['2026-11-03T00:59:59Z',false],['2026-11-03T01:00:00Z',true],
    ['2026-11-03T08:59:59Z',true],['2026-11-03T09:00:00Z',false],
    ['2026-11-04T01:00:00Z',false],
  ] as const) assert.equal(withinNoticePeriod(night,new Date(at)),expected,at);
});
test('daytime, weekends, always, off and invalid timestamps',()=>{
  const s=validSchedule({mode:'periods',timezone:'UTC',periods:[{days:[0,6],start:'08:00',end:'18:00'}]});
  assert.equal(withinNoticePeriod(s,new Date('2026-11-01T08:00Z')),true);
  assert.equal(withinNoticePeriod(s,new Date('2026-11-02T08:00Z')),false);
  assert.equal(withinNoticePeriod(DEFAULT_SCHEDULE,new Date()),true);
  assert.equal(withinNoticePeriod({...DEFAULT_SCHEDULE,mode:'off'},new Date()),false);
  assert.equal(withinNoticePeriod(DEFAULT_SCHEDULE,new Date('bad')),false);
});
test('rejects malformed windows, zones, days and unknown fields',()=>{
  for(const patch of [{timezone:'bad'},{periods:[]},{mode:'x'},{mode:['always']},{extra:true},
    {periods:[{days:[1,1],start:'22:00',end:'06:00'}]},
    {periods:[{days:[7],start:'22:00',end:'06:00'}]},
    {periods:[{days:[1],start:'24:00',end:'06:00'}]},
    {periods:[{days:[1],start:'06:00',end:'06:00'}]}])
    assert.throws(()=>validSchedule({...night,...patch}));
});
function service(){
  const rows=new Map<string,any>();
  const cameras=['inherit','own','paused','forced','disabled'].map(id=>({id,enabled:true,motionNoticeEnabled:false,objectNoticeEnabled:id!=='disabled',groupId:'g',group:{name:'Grupo'}}));
  const put=(scope:string,id:string,policy:any)=>rows.set(`detection.notice-policy.v1.${scope}.${id}`,{value:JSON.stringify(policy)});
  put('group','g',{manualMode:'auto',schedule:night});
  put('camera','own',{manualMode:'auto',schedule:DEFAULT_SCHEDULE});
  put('camera','paused',{manualMode:'off',schedule:null});
  put('camera','forced',{manualMode:'on',schedule:null});
  const prisma:any={camera:{findMany:async()=>cameras,findUnique:async()=>cameras[0]},systemSetting:{
    findMany:async()=>[...rows].map(([key,row])=>({key,...row})),
    findUnique:async({where}:any)=>rows.get(where.key)??null,
  }};
  return {svc:new NoticePoliciesService(prisma),prisma,put};
}
test('individual override does not change group or other cameras; manual pause/on still respect configured notices',async()=>{
  const {svc}=service();
  const states=await svc.snapshot([],new Date('2026-11-03T15:00Z'));
  assert.deepEqual(states.map(s=>[s.cameraId,s.active]),[['inherit',false],['own',true],['paused',false],['forced',true],['disabled',false]]);
  assert.equal(states[0].source,'group');assert.equal(states[1].source,'camera');
});
test('feed enforces event and current schedule, never replays outside-hours events',async()=>{
  const {svc}=service();
  const feed=await svc.filterFeed([],{cursor:'2026-11-03T02:00Z',items:[
    {cameraId:'inherit',occurredAt:'2026-11-03T00:59Z'},
    {cameraId:'inherit',occurredAt:'2026-11-03T01:59Z'},
    {cameraId:'paused',occurredAt:'2026-11-03T01:59Z'},
  ]});
  assert.equal(feed.items.length,1);
  const closed=await svc.filterFeed([],{cursor:'2026-11-03T09:00Z',items:[{cameraId:'inherit',occurredAt:'2026-11-03T08:59Z'}]});
  assert.equal(closed.items.length,0);
});
test('corrupt stored policy fails closed',async()=>{
  const {svc,put}=service();put('camera','own',{manualMode:'invalid',schedule:null});
  const states=await svc.snapshot([]);assert.equal(states.find(s=>s.cameraId==='own')?.reason,'invalid-policy');
});
test('save rejects stale versions before any write and validates fields',async()=>{
  const {svc,prisma}=service();
  prisma.$transaction=async(fn:any)=>fn(prisma);
  await assert.rejects(svc.save('camera','inherit',{manualMode:'off',expectedVersion:'stale'},'u'),/outra pessoa/);
  await assert.rejects(svc.save('camera','inherit',{recordingEnabled:false,expectedVersion:'0'},'u'));
  await assert.rejects(svc.save('group','g',{manualMode:'on',expectedVersion:'0'},'u'));
  await assert.rejects(svc.save('camera','inherit',{manualMode:['on'],expectedVersion:'0'},'u'));
});
test('camera endpoints check access before loading or writing policy',async()=>{
  const denied=async()=>{throw Error('denied')};
  const controller=new NoticePoliciesController({get:()=>{throw Error('policy accessed')},save:()=>{throw Error('policy written')}} as any,{assertCanViewCamera:denied,assertCanAdminCamera:denied} as any);
  await assert.rejects(controller.camera({id:'u'} as any,'c'),/denied/);
  await assert.rejects(controller.saveCamera({id:'u'} as any,'c',{}),/denied/);
});
test('saving a camera override persists only its namespaced policy and an audit entry',async()=>{
  const {svc,prisma}=service();let saved:any;let audit:any;let serializable=false;
  const find=prisma.systemSetting.findUnique;
  prisma.systemSetting.findUnique=async(q:any)=>q.where.key===saved?.key?saved:find(q);
  prisma.systemSetting.create=async({data}:any)=>{saved={...data,updatedAt:new Date('2026-11-03T18:00Z')};return saved;};
  prisma.auditLog={create:async({data}:any)=>{audit=data;}};
  prisma.$transaction=async(fn:any,options:any)=>{serializable=options.isolationLevel==='Serializable';return fn(prisma);};
  const result=await svc.save('camera','inherit',{expectedVersion:'0',schedule:DEFAULT_SCHEDULE},'operator');
  assert.equal(saved.key,'detection.notice-policy.v1.camera.inherit');
  assert.equal(result.policy.schedule?.mode,'always');
  assert.equal(audit.userId,'operator');assert.equal(audit.entityId,'inherit');
  assert.equal(audit.action,'camera.notice_policy.update');assert.ok(serializable);
});
