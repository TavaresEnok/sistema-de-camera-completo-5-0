import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDesktopNotices, showDesktopDetection } from '../src/lib/desktop-notices.ts';

test('notificações respeitam permissão e visibilidade; clique abre a câmera sem navegar', () => {
  const created: FakeNotification[] = [];
  let focused = 0;
  class FakeNotification {
    static permission = 'granted';
    onclick: (()=>void) | null = null;
    onclose: (()=>void) | null = null;
    closed = false;
    title:string;
    options:Record<string,unknown>;
    constructor(title:string, options:Record<string,unknown>) { this.title=title;this.options=options;created.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const old = {window:Object.getOwnPropertyDescriptor(globalThis,'window'),document:Object.getOwnPropertyDescriptor(globalThis,'document'),Notification:Object.getOwnPropertyDescriptor(globalThis,'Notification')};
  const doc = {hidden:true};
  const win = {isSecureContext:true,Notification:FakeNotification,focus:()=>focused++,location:{href:'https://camera.example/live?display=aux-1'}};
  for(const [key,value] of Object.entries({window:win,document:doc,Notification:FakeNotification})) Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  try {
    const item={id:'event',cameraId:'camera1',cameraName:'Portaria',occurredAt:new Date().toISOString()};
    let opened:string|null=null;
    FakeNotification.permission='denied';
    assert.equal(showDesktopDetection(item,'user',()=>{},'Pessoa detectada'),false);
    FakeNotification.permission='granted';doc.hidden=false;
    assert.equal(showDesktopDetection(item,'user',()=>{},'Pessoa detectada'),false);
    doc.hidden=true;
    assert.equal(showDesktopDetection(item,'user',e=>{opened=e.cameraId;},'Pessoa detectada'),true);
    assert.equal(created[0].options.silent,true);
    assert.equal(created[0].options.requireInteraction,true);
    created[0].onclick?.();
    assert.equal(opened,'camera1');assert.equal(focused,1);
    assert.equal(win.location.href,'https://camera.example/live?display=aux-1');
    showDesktopDetection(item,'user',()=>{},'Pessoa detectada');
    showDesktopDetection({...item,id:'new-event'},'user',()=>{},'Pessoa detectada');
    assert.equal(created[1].closed,true,'a câmera atualiza a notificação anterior');
    closeDesktopNotices();
    assert.equal(created[2].closed,true,'sair da conta fecha os avisos pendentes');
  } finally {
    closeDesktopNotices();
    for(const [key,value] of Object.entries(old)) { if(value) Object.defineProperty(globalThis,key,value); else Reflect.deleteProperty(globalThis,key); }
  }
});
