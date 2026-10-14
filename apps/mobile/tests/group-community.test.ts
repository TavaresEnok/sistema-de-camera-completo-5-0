import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { URL } from 'node:url';
import { addCommunityMessage, communityPollingAllowed, eligibleCommunityGroups, panicFeedback } from '../src/services/group-community';

test('zero ou um usuário não mostra funções; offline continua sendo membro', () => {
  assert.deepEqual(eligibleCommunityGroups(null), []);
  assert.deepEqual(eligibleCommunityGroups([{ id: 'g', name: 'Um', memberCount: 1 }]), []);
  assert.equal(eligibleCommunityGroups([{ id: 'g', name: 'Dois', memberCount: 2, onlineCount: 0 }]).length, 1);
  assert.equal(eligibleCommunityGroups([{ id: 'g', name: 'Dois', memberCount: 2 }, { id: 'g', name: 'Dois', memberCount: 2 }]).length, 1);
});
test('não promete entrega nem confirmação de leitura do pânico', () => {
  assert.match(panicFeedback({ pushStatus: 'accepted' }), /não confirma/);
  assert.match(panicFeedback({ pushStatus: 'failed' }), /não foi possível/);
  assert.match(panicFeedback({ pushStatus: 'no_devices' }), /Não há aparelhos/);
  assert.match(panicFeedback({ pushStatus: 'cooldown' }), /não foram repetidas/);
});
test('chat não consulta servidor fora da tela ou em segundo plano', () => {
  assert.equal(communityPollingAllowed(true, 'active'), true);
  for (const state of ['background', 'inactive', null]) assert.equal(communityPollingAllowed(true, state), false);
  assert.equal(communityPollingAllowed(false, 'active'), false);
});
test('mensagem confirmada deduplica pelo id e mantém ordem de conversa', () => {
  const message = { id: '1', body: 'Teste', kind: 'TEXT' as const, createdAt: '2026-10-14T12:00:00Z', user: { id: 'u1', name: 'Um' } };
  assert.equal(addCommunityMessage([message], message).length, 1);
  assert.equal(addCommunityMessage([message], { ...message, id: '2', createdAt: '2026-10-14T12:01:00Z' })[0].id, '2');
});
test('app usa grupos do servidor, confirmação de pânico e aborta consultas ao sair', () => {
  const panel = fs.readFileSync(new URL('../src/components/GroupCommunityPanel.tsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(panel, /\/group-community/); assert.match(panel, /controller\.abort\(\)/);
  assert.match(panel, /Pedir ajuda ao grupo\?/); assert.match(panel, /serviços de emergência/);
  assert.match(panel, /5_000/); assert.match(panel, /30_000/); assert.match(panel, /maxLength=\{500\}/);
  assert.match(app, /<GroupCommunityPanel/); assert.match(app, /data\.tipo === 'alerta-de-grupo'/);
  assert.doesNotMatch(panel, /generate-app|\/builds|AsyncStorage/);
});
