import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useDesktopNoticeStore } from '../store/desktopNoticeStore';
import { closeDesktopNotices, desktopNotificationsSupported } from '../lib/desktop-notices';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export function DesktopNoticeControl({ expanded }: { expanded: boolean }) {
  const userId = useAuthStore(s => s.user?.id ?? null);
  const preference = useDesktopNoticeStore();
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() => desktopNotificationsSupported() ? Notification.permission : 'default');
  const [message, setMessage] = useState('');
  const supported = desktopNotificationsSupported();
  const enabled = preference.userId === userId && preference.enabled && permission === 'granted';
  useEffect(() => { preference.loadForUser(userId); setOpen(false); setMessage(''); }, [userId]);
  useEffect(() => {
    const update = () => { if (supported) setPermission(Notification.permission); };
    window.addEventListener('focus', update);
    return () => window.removeEventListener('focus', update);
  }, [supported]);

  const enable = async () => {
    if (!supported) return;
    const owner = userId;
    try {
      const result = await Notification.requestPermission();
      if (useAuthStore.getState().user?.id !== owner) return;
      setPermission(result);
      preference.setEnabled(result === 'granted');
      setMessage(result === 'granted' ? 'Notificações ativadas neste computador.'
        : result === 'denied' ? 'O navegador bloqueou os avisos. Permita as notificações nas configurações deste site.'
        : 'A permissão não foi concedida. Você pode tentar novamente.');
    } catch { setMessage('Não foi possível pedir a permissão. Confira as configurações do navegador.'); }
  };
  const test = () => {
    try {
      const n = new Notification('S2Cam — Teste de notificação', {
        body: 'Os avisos aparecerão aqui quando o navegador estiver minimizado. Clique para voltar ao S2Cam.',
        tag: 's2cam:notification-test', silent: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
      setMessage('Teste enviado. Se não aparecer, confira as notificações e o modo Não perturbe do Windows.');
    } catch { setMessage('O navegador não conseguiu mostrar o teste. Confira as permissões do site e do Windows.'); }
  };
  if (!userId) return null;
  return <>
    <button type="button" onClick={() => setOpen(true)} title="Notificações no PC" aria-label="Configurar notificações no computador"
      className={`sidebar-footer-btn flex h-8 items-center gap-2 rounded-lg text-[hsl(var(--muted-foreground))] hover:text-sidebar-foreground ${expanded ? 'w-full px-3' : 'w-9 mx-auto justify-center'}`}>
      {enabled ? <Bell className="h-3.5 w-3.5 shrink-0 text-primary" /> : <BellOff className="h-3.5 w-3.5 shrink-0" />}
      {expanded && <span className="text-[11px]">Notificações no PC</span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Notificações no computador</DialogTitle>
          <DialogDescription>Receba avisos das câmeras mesmo com o navegador minimizado. Clique na notificação para voltar e abrir a câmera ao vivo.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Esta preferência vale para sua conta neste computador. O S2Cam deve permanecer aberto, com a sessão conectada. O navegador e o Windows precisam permitir as notificações.</p>
        {!supported && <p role="status" className="text-sm">Este navegador não oferece notificações nesta página. Use o Chrome ou o Edge atualizado, acessando por HTTPS.</p>}
        {permission === 'denied' && <p role="status" className="text-sm">Notificações bloqueadas. Abra as permissões deste site pelo ícone ao lado do endereço e permita as notificações.</p>}
        <p className="text-sm font-medium">{enabled ? 'Ativadas neste computador' : 'Desativadas neste computador'}</p>
        <div className="flex flex-wrap gap-2">
          {enabled ? <Button variant="outline" onClick={() => { preference.setEnabled(false); closeDesktopNotices(); setMessage('Notificações desativadas neste computador.'); }}>Desativar</Button>
            : <Button onClick={() => void enable()} disabled={!supported || permission === 'denied'}>Ativar notificações</Button>}
          {enabled && <Button variant="outline" onClick={test}>Enviar teste</Button>}
        </div>
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
