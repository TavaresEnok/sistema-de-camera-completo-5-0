'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
test('inventory shows green online, red offline and neutral pending without confusing license status', () => {
  const items = [
    { id: 'connected', status: 'ONLINE', licenseStatus: 'SUSPENDED' },
    { id: 'disconnected', status: 'OFFLINE', licenseStatus: 'ACTIVE' },
    { id: 'pending', status: 'PENDING_INSTALL' },
  ];
  let rows;
  const context = { state: { installations: items }, els: { inventoryRows: {} },
    displayName: item => item.id, monogram: () => '', escapeHtml: String,
    platformLabel: () => '', metric: () => 0, progress: () => '', dtf: { format: () => '' },
    reconciliarLinhas: (_, result) => { rows = result; } };
  vm.createContext(context);
  const labels = html.slice(html.indexOf('      function communicationLabel('), html.indexOf('      function platformLabel('));
  const inventory = html.slice(html.indexOf('      function renderInventory('), html.indexOf('      function renderContractBoard('));
  vm.runInContext(labels + inventory + '\nrenderInventory();', context);
  assert.equal(rows.length, 3);
  assert.match(rows[0].html, /class="badge ok"[^>]*>Online<\/span>/);
  assert.match(rows[0].html, /aria-label="Comunicação: Conectado"/);
  assert.match(rows[1].html, /class="badge bad"[^>]*>Offline<\/span>/);
  assert.match(rows[1].html, /aria-label="Comunicação: Sem comunicação"/);
  assert.match(rows[2].html, /class="badge neutral"[^>]*>Aguardando instalação<\/span>/);
  for (const row of rows) assert.equal((row.html.match(/<td /g) || []).length, 8);
});
test('Central inline script parses', () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
