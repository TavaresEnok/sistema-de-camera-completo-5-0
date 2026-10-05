// Compiled first-user bootstrap for source-free installations. Never resets an
// existing account and never accepts a password on the command line.
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

export async function readInitialAdminInput(input: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > 8192) throw new Error('initial_admin_input_invalid');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
  const admin = parseInitialAdmin(await readInitialAdminInput(process.stdin));
  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(admin.password, 10);
    const created = await prisma.$transaction(async tx => {
      // pg_advisory_xact_lock returns PostgreSQL void. Prisma $queryRaw cannot
      // deserialize that result; $executeRaw keeps the lock without decoding.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('drac.bootstrap-admin'))`;
      if (await tx.user.count()) return false;
      await tx.user.create({data:{username:admin.username,email:admin.email,name:admin.name,passwordHash,role:UserRole.SUPER_ADMIN,isActive:true}});
      return true;
    });
    console.log(created ? 'Administrador inicial criado.' : 'Usuários existentes preservados.');
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) void main().catch(() => { console.error('Não foi possível criar o administrador inicial.'); process.exitCode = 1; });
