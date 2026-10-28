import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCameraDto } from '../src/cameras/dto/create-camera.dto';
import { UpdateCameraDto } from '../src/cameras/dto/update-camera.dto';
import { noticeWithinPerimeter } from '../src/cameras/helpers/notice-perimeter.helper';
import { CamerasService } from '../src/cameras/cameras.service';
import { advanceNoticeQueue, noticeDuration } from '../../web/src/lib/motion-notices';

const include = {id:'yard',kind:'include',points:[[0.2,0.2],[0.8,0.2],[0.8,0.8],[0.2,0.8]]};
const exclude = {id:'tree',kind:'exclude',points:[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]};
const frame = (bbox: number[]) => ({bbox,frameWidth:100,frameHeight:100,label:'pessoa'});

test('area notices use the feet and honor exclusions and boundaries across resolutions',()=>{
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([25,10,35,50]),[include]),true);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([25,10,35,90]),[include]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([45,20,55,50]),[include,exclude]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([25,20,35,20.1]),[include]),true);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',{...frame([250,100,350,500]),frameWidth:1000,frameHeight:1000},[include]),true);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([45,20,55,50]),[exclude]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([5,5,15,15]),[exclude]),true);
});

test('outside, missing coordinates and stale/wrong-direction line events do not create toasts',()=>{
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([0,0,10,10]),[include]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',{label:'pessoa'},[include]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([0,0,101,101]),[include]),false);
  const line={id:'gate',kind:'line',points:[[0.5,0],[0.5,1]],sentido:'ab'};
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',frame([30,30,50,50]),[line]),false);
  assert.equal(noticeWithinPerimeter('LINE_CROSSED',{linhaId:'gate',sentido:'ab'},[line]),true);
  assert.equal(noticeWithinPerimeter('LINE_CROSSED',{linhaId:'gate',sentido:'ba'},[line]),false);
  assert.equal(noticeWithinPerimeter('LINE_CROSSED',{linhaId:'removed',sentido:'ab'},[line]),false);
  assert.equal(noticeWithinPerimeter('OBJECT_DETECTED',{label:'pessoa'},[]),true);
});

test('motion uses monitored components, including multiple disconnected boxes',()=>{
  assert.equal(noticeWithinPerimeter('MOTION_DETECTED',frame([25,25,35,85]),[include]),true);
  assert.equal(noticeWithinPerimeter('MOTION_DETECTED',frame([45,45,55,55]),[include,exclude]),false);
  assert.equal(noticeWithinPerimeter('MOTION_DETECTED',{...frame([0,0,10,10]),motionBoxes:[[0,0,10,10],[25,25,35,35]]},[include]),true);
});

test('feed filters object perimeter events on the server and returns current camera preferences',async()=>{
  const svc:any=Object.create(CamerasService.prototype);
  svc.moduleRef={get:()=>({getPolicy:async()=>({aiObjectClasses:['person']}),isAllowed:async()=>true})};
  const camera={name:'Portaria',objectNoticeClasses:['person'],detectionZones:[include],noticeSound:'siren',noticeDurationSeconds:20,noticeSoundEnabled:true};
  svc.prisma={cameraEvent:{findMany:async()=>[
    {id:'outside',cameraId:'a',type:'OBJECT_DETECTED',occurredAt:new Date(),metadata:frame([0,0,10,10]),camera},
    {id:'inside',cameraId:'a',type:'OBJECT_DETECTED',occurredAt:new Date(),metadata:frame([25,25,35,50]),camera},
  ]}};
  const result=await svc.listDetectionNotices(['a'],new Date().toISOString());
  assert.deepEqual(result.items.map((item:any)=>item.id),['inside']);
  assert.equal(result.items[0].noticeSound,'siren');
  assert.equal(result.items[0].noticeDurationSeconds,20);
});

test('duration defaults to ten; independent timers survive new notices and queued items get their full duration',()=>{
  assert.equal(noticeDuration(undefined),10);
  assert.equal(noticeDuration(0),10);
  assert.equal(noticeDuration(121),10);
  assert.equal(noticeDuration(15),15);
  const now=100000;
  const notice=(id:string,seconds=10)=>({id,cameraId:id,cameraName:id,occurredAt:new Date(now).toISOString(),noticeDurationSeconds:seconds,queuedAt:now,expiresAt:null});
  let queue=advanceNoticeQueue([notice('a'),notice('b',20)],now);
  queue=advanceNoticeQueue([...queue,notice('c'),notice('d')],now+1000);
  assert.equal(queue[0].expiresAt,now+10000);
  assert.equal(queue[3].expiresAt,null);
  assert.equal(advanceNoticeQueue(queue,now+9999).length,4);
  queue=advanceNoticeQueue(queue,now+10000);
  assert.deepEqual(queue.map(item=>item.id),['b','c','d']);
  assert.equal(queue[2].expiresAt,now+20000);
});

test('both DTOs reject unknown sounds and durations outside 1..120',async()=>{
  for(const C of [CreateCameraDto,UpdateCameraDto])for(const [field,value] of [['noticeSound','evil'],['noticeDurationSeconds',0],['noticeDurationSeconds',121],['noticeDurationSeconds',2.5]]){
    const errors=await validate(plainToInstance(C,{[field]:value}));
    assert.ok(errors.some(error=>error.property===field));
  }
});
