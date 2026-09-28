import { create } from 'zustand';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';

type Request = { title: string; description: string; confirmLabel?: string; destructive?: boolean; resolve: (accepted: boolean) => void };
const useConfirmation = create<{ request: Request | null }>(() => ({ request: null }));
export function confirmAction(options: Omit<Request, 'resolve'>): Promise<boolean> {
  // Uma ação pendente não pode ser substituída por outro clique.
  if (useConfirmation.getState().request) return Promise.resolve(false);
  return new Promise((resolve) => useConfirmation.setState({ request: { ...options, resolve } }));
}
export function ActionConfirmation() {
  const request = useConfirmation((s) => s.request);
  const finish = (accepted: boolean) => {
    const pending = useConfirmation.getState().request;
    useConfirmation.setState({ request: null });
    pending?.resolve(accepted);
  };
  return <AlertDialog open={!!request} onOpenChange={(open) => !open && finish(false)}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{request?.title}</AlertDialogTitle><AlertDialogDescription>{request?.description}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel onClick={() => finish(false)}>Cancelar</AlertDialogCancel><AlertDialogAction className={request?.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''} onClick={() => finish(true)}>{request?.confirmLabel ?? 'Confirmar'}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
