import { useState } from 'react';
import axios from 'axios';
import { Button } from './ui/button';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { getRequestErrorMessage } from '../lib/request-error';
import { toast } from '../hooks/use-toast';
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from './ui/alert-dialog';

export function CameraRelayControl({ cameraId }: { cameraId: string }) {
  const token = useAuthStore(s => s.accessToken);
  const [busy, setBusy] = useState(false);
  const trigger = async () => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const { data } = await axios.post(`${getApiBaseUrl()}/ptz/${encodeURIComponent(cameraId)}/relays/trigger`, { durationMs: 1500 }, { headers: { Authorization: `Bearer ${token}` } });
      if (data.status !== 'ok') throw new Error('Não confirmado');
      toast({ title: 'Comando de alarme confirmado' });
    } catch (error) {
      toast({ title: 'Não foi possível acionar o alarme', description: getRequestErrorMessage(error, 'Confira se a câmera possui uma saída de alarme configurada.'), variant: 'destructive' });
    } finally { setBusy(false); }
  };
  return <AlertDialog>
    <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={busy}>{busy ? 'Acionando…' : 'Acionar saída de alarme'}</Button></AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Acionar a saída de alarme?</AlertDialogTitle><AlertDialogDescription>A saída será acionada por 1,5 segundo. Isso pode ligar uma sirene ou outro equipamento conectado à câmera.</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={() => void trigger()}>Acionar agora</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
