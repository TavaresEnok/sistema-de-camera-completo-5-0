// Compiled first-user bootstrap for source-free installations. Never resets an
// existing account and never accepts a password on the command line.
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { readSync } from 'node:fs';

export function parseInitialAdmin(input: string) {
  if (Buffer.byteLength(input) > 8192) throw new Error('initial_admin_input_invalid');
  const raw = JSON.parse(input);
  if (!raw || ['username','email','password','name'].some(k => typeof raw[k] !== 'string')) throw new Error('initial_admin_input_invalid');
  const username = raw.username.trim().toLowerCase();
  const email = raw.email.trim().toLowerCase() || null;
  const name = raw.name.trim();
  const password = raw.password;
  if (!/^[a-z0-9_.@+-]{3,128}$/.test(username) || !name || name.length > 128 || password.length < 10 || password.length > 256
    || ['admin123','operador123','viewer123','123456','password','changeme','change_me'].includes(password.toLowerCase())
    || (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254))) throw new Error('initial_admin_input_invalid');
  return {username,email,name,password};
}

async function main() {
  if (process.env.ADMIN_STDIN_JSON !== 'true') throw new Error('initial_admin_stdin_required');
  const buffer = Buffer.alloc(8193);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(0, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  const admin = parseInitialAdmin(buffer.subarray(0, length).toString('utf8'));
  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(admin.password, 10);
    const created = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('drac.bootstrap-admin'))`;
      if (await tx.user.count()) return false;
      await tx.user.create({data:{username:admin.username,email:admin.email,name:admin.name,passwordHash,role:UserRole.SUPER_ADMIN,isActive:true}});
      return true;
    });
    console.log(created ? 'Administrador inicial criado.' : 'Usuários existentes preservados.');
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) void main().catch(() => { console.error('Não foi possível criar o administrador inicial.'); process.exitCode = 1; });
