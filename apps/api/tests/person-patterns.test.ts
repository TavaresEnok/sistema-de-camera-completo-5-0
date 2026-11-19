import { strict as assert } from 'node:assert';
import test from 'node:test';
import { personExample, PersonPatternsService } from '../src/review/person-patterns.service';

const event = {id:'test',type:'OBJECT_DETECTED', occurredAt:new Date(0),
  metadata:{label:'pessoa',bbox:[0,76,763,531],frameWidth:792,frameHeight:540,confidence:.55}};
test('normaliza no quadro da IA e rejeita caixas estimadas, incompletas ou degeneradas',()=>{
  assert.deepEqual(personExample(event)?.box,[0,76/540,763/792,531/540]);
  for (const invalid of [{estimated:true},{observedByModel:false},{frameWidth:0},{bbox:[0,76,0,531]},{label:'carro'}]) {
    assert.equal(personExample({...event,metadata:{...event.metadata,...invalid}}),null);
  }
});
test('revisão e alteração consultam as permissões antes dos dados', async()=>{
  const denied = async()=>{throw new Error('denied')};
  const user = {id:'u'} as any;
  const service = new PersonPatternsService({} as any,{assertCanPlaybackCamera:denied} as any);
  await assert.rejects(service.report(user,'other','event'),/denied/);
  await assert.rejects(service.preview(user,'other','event'),/denied/);
  const readonly = new PersonPatternsService({} as any,{assertCanPlaybackCamera:async()=>{},assertCanAdminCamera:denied} as any);
  await assert.rejects(readonly.change(user,'other','event',true),/denied/);
});
test('salvar um exemplo técnico não cria um evento de alarme',async()=>{
  let data:any;
  const s=new PersonPatternsService({cameraEvent:{create:async(input:any)=>{data=input.data;}}} as any,{} as any);
  await s.capture({camera:'c',...event.metadata});
  assert.equal(data.cameraId,'c');
  assert.equal(data.type,'PERSON_BOX_REVIEW');
});
