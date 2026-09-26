import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/auth.service';

test('token de reset tem exatamente um vencedor concorrente', async () => {
  let available = true;
  const user = { id: 'u1', resetTokenExpiresAt: new Date(Date.now() + 60_000) };
  const tx: any = {
    user: {
      updateMany: async () => {
        if (!available) return { count: 0 };
        available = false;
        return { count: 1 };
      },
    },
    authSession: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma: any = {
    user: { findFirst: async () => user },
    $transaction: async (fn: any) => fn(tx),
  };
  const settings: any = { isStrongPasswordRequired: async () => false };
  const service = new AuthService(prisma, {} as any, {} as any, settings);
  const settled = await Promise.allSettled([
    service.resetPassword('same-token', 'new-password-a'),
    service.resetPassword('same-token', 'new-password-b'),
  ]);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
});
