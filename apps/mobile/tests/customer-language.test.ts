import assert from 'node:assert/strict';
import test from 'node:test';
import { userFacingError } from '../src/services/user-facing-error';

test('mensagens de falha do aplicativo preservam orientação sem expor detalhes internos', () => {
  assert.equal(
    userFacingError(Object.assign(new Error('connection refused by redis:6379'), { status: 500 }), 'Não foi possível atualizar agora.'),
    'Não foi possível atualizar agora.',
  );
  assert.equal(
    userFacingError(Object.assign(new Error('forbidden'), { status: 403 }), 'Não foi possível atualizar agora.'),
    'Seu usuário não tem permissão para realizar esta ação.',
  );
  assert.equal(
    userFacingError(new Error('Tempo esgotado. Verifique a conexão.'), 'Não foi possível atualizar agora.'),
    'Tempo esgotado. Verifique a conexão.',
  );
});
