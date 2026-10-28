import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTICE_SOUNDS, tocarSomDeAlerta } from '../src/lib/alert-sound.ts';

test('five short audio patterns, current attention preserved, mute and explicit preview respected',async()=>{
  let muted=false;
  const records:{stops:number[];volumes:number[];types:string[]}[]=[];
  class AudioContext {
    currentTime=0; destination={};
    record={stops:[] as number[],volumes:[] as number[],types:[] as string[]};
    constructor(){records.push(this.record)}
    resume(){return Promise.resolve()}
    close(){return Promise.resolve()}
    createOscillator(){const record=this.record;return {type:'sine',frequency:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){},start(){},stop(t:number){record.stops.push(t);record.types.push(this.type)}}}
    createGain(){const record=this.record;return {gain:{setValueAtTime(){},linearRampToValueAtTime(v:number){record.volumes.push(v)},exponentialRampToValueAtTime(){}},connect(){}}}
  }
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioContext,localStorage:{getItem(){return muted?'1':null}},setTimeout(){return 0}}});
  try{
    for(const sound of NOTICE_SOUNDS){
      assert.equal(await tocarSomDeAlerta(sound.value),true);
      const record=records.at(-1)!;
      assert.ok(record.stops.length>=2);
      assert.ok(Math.max(...record.stops)<=1);
    }
    assert.equal(records[0].stops.length,4);
    assert.equal(Math.max(...records[0].volumes),0.12);
    assert.ok(records.slice(1).every(r=>Math.max(...r.volumes)>0.12));
    muted=true;
    const before=records.length;
    assert.equal(await tocarSomDeAlerta('siren'),false);
    assert.equal(records.length,before);
    assert.equal(await tocarSomDeAlerta('siren',true),true);
  }finally{Reflect.deleteProperty(globalThis,'window')}
});
