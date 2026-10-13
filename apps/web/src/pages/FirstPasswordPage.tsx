import { useState } from 'react';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';

export default function FirstPasswordPage() {
  const { user, accessToken, login, logout } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmation) { setError('As novas senhas precisam ser iguais.'); return; }
    if (password.length < 8 || password === user?.username || password === currentPassword) { setError('Escolha uma senha diferente do CPF, com pelo menos 8 caracteres.'); return; }
    setBusy(true); setError('');
    let saved = false;
    try {
      await axios.patch(`${getApiBaseUrl()}/users/me/password`, { currentPassword, newPassword: password }, { headers: { Authorization: `Bearer ${accessToken}` } });
      setChanged(true);
      saved = true;
      await login(user?.username ?? '', password);
    } catch (failure) {
      const response = axios.isAxiosError(failure) ? failure.response?.data : null;
      const message = response?.message;
      setError(saved ? 'Senha salva. Entre novamente usando sua nova senha.' : typeof message === 'string' ? message : Array.isArray(message) ? message.join(' ') : 'Não foi possível trocar a senha agora. Confira sua senha atual e tente novamente.');
    } finally { setBusy(false); }
  }
  return <main className="min-h-[100dvh] flex items-center justify-center bg-background p-5 text-foreground">
    <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg">
      <h1 className="text-xl font-semibold">Escolha sua nova senha</h1>
      <p className="mt-3 text-sm text-muted-foreground">Seu primeiro acesso usa o CPF como senha. Crie uma senha só sua para continuar e acessar suas câmeras.</p>
      <form onSubmit={submit} className="mt-5 grid gap-4">
        <label className="grid gap-2 text-sm">Senha atual<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} className="min-h-11 rounded-lg border border-border bg-background px-3" /></label>
        <label className="grid gap-2 text-sm">Nova senha<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} className="min-h-11 rounded-lg border border-border bg-background px-3" /></label>
        <label className="grid gap-2 text-sm">Repita a nova senha<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} className="min-h-11 rounded-lg border border-border bg-background px-3" /></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button disabled={busy || changed} className="min-h-11 rounded-lg bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50">{busy ? 'Salvando…' : 'Salvar e continuar'}</button>
      </form>
      <button onClick={() => void logout()} className="mt-4 min-h-11 w-full rounded-lg border border-border px-4 text-sm">Sair</button>
    </section>
  </main>;
}
