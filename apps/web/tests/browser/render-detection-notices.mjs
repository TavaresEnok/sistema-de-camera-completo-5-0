import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } });
try {
  const { CameraDetectionNotices } = await server.ssrLoadModule('/src/components/CameraDetectionNotices.tsx');
  const render = value => renderToStaticMarkup(React.createElement(CameraDetectionNotices, {
    motion: false, object: false, classes: [], allowed: [], motionAllowed: true, loading: false, onChange() {}, ...value,
  }));
  const off = render({});
  assert.ok(off.includes('Avisar na tela') && !off.includes('<select'));
  const motion = render({ motion: true });
  assert.ok(motion.includes('value="object" disabled=""'));
  const person = render({ object: true, allowed: ['person'], classes: ['person'] });
  assert.ok(person.includes('Pessoas') && person.includes('aria-pressed="true"'));
  assert.ok(!person.includes('>Carro</button>') && !person.includes('>Moto</button>'));
  const vehicles = render({ object: true, allowed: ['person', 'car', 'motorcycle', 'bicycle'] });
  for (const label of ['Pessoa', 'Carro', 'Moto', 'Bicicleta']) assert.ok(vehicles.includes(`>${label}</button>`));
  assert.ok(!vehicles.includes('>Caminhão</button>'));
  assert.ok(vehicles.includes('Funciona mesmo sem gravação'));
  const preferences = render({object:true,sound:true,allowed:['person'],duration:20,soundType:'siren'});
  assert.ok(preferences.includes('Tempo do aviso na tela'));
  assert.ok(preferences.includes('value="20" selected=""'));
  assert.ok(preferences.includes('value="siren" selected=""'));
  assert.ok(preferences.includes('Ouvir som'));
  for (const label of ['Atenção (atual)', 'Sirene de emergência', 'Sirene de invasão', 'Alarme de evacuação', 'Alarme pulsante']) assert.ok(preferences.includes(label));
  assert.ok(person.includes('value="10" selected=""'));
  console.log(JSON.stringify({ realReactRender: true, defaultOff: true, motionOnlyPlan: true, personOnlyPlan: true, vehiclePlan: true, licensedClassesOnly: true }));
} finally { await server.close(); }
