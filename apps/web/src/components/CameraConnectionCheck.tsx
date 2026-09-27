import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Button } from './ui/button';
import { getApiBaseUrl } from '../lib/api-base';
import { getRequestErrorMessage } from '../lib/request-error';
import { parsePreviewFrame, type PreviewFrame } from '../lib/camera-preview-frame';
import { parseDiagnosticsReport } from '../lib/camera-diagnostics';
import { useAuthStore } from '../store/authStore';
import { descreverCredencial } from '../lib/senha-da-camera';

export function CameraConnectionCheck({ cameraId, draft, discoveryDraft, onDiscover, push }: {
  cameraId: string; draft: Record<string, unknown>; discoveryDraft: Record<string, unknown>;
  onDiscover: (values: Record<string, string>) => void; push: boolean;
}) {
  const token = useAuthStore(s => s.accessToken);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, string> | null>(null);
  const generation = useRef(0);
  const draftKey = JSON.stringify([draft, discoveryDraft]);
  useEffect(() => { generation.current++; setMessage(''); setFrame(null); setDiscovered(null); setBusy(false); return () => { generation.current++; }; }, [cameraId, token, push, draftKey]);
  const check = async (kind: 'image' | 'connection' | 'diagnostics' | 'discover') => {
    if (busy || !token) return;
    const run = generation.current;
    setBusy(true); setMessage('Verificando a câmera…'); setFrame(null); setDiscovered(null);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    try {
      const url = `${getApiBaseUrl()}/cameras/${encodeURIComponent(cameraId)}`;
      if (kind === 'discover') {
        // Reuse the stored credential without displaying it or persisting it in state.
        let password = discoveryDraft.password;
        if (!password) {
          const { data } = await axios.get(`${url}/credential`, auth);
          if (run !== generation.current) return;
          const credential = descreverCredencial(data);
          if (!data || data.ilegivel) { setMessage('Informe a senha da câmera para detectar os ajustes.'); return; }
          password = credential.valor;
        }
        const { data } = await axios.post(`${getApiBaseUrl()}/cameras/test-connection-draft`, { ...discoveryDraft, password }, auth);
        if (run !== generation.current) return;
        if (data.rtspAuthOk !== true && data.selectedRtspPortAuthOk !== true) {
          setMessage('Não foi possível confirmar o acesso ao vídeo. Confira os dados de conexão.'); return;
        }
        const values: Record<string, string> = {};
        for (const [remote, field] of [['detectedRtspPath', 'rtspPath'], ['detectedOnvifPath', 'onvifPath'], ['detectedOnvifProfileToken', 'onvifProfileToken']]) {
          if (typeof data[remote] === 'string' && data[remote]) values[field] = data[remote];
        }
        if (Number.isInteger(data.detectedOnvifPort) && data.detectedOnvifPort > 0 && data.detectedOnvifPort <= 65535) values.onvifPort = String(data.detectedOnvifPort);
        setDiscovered(Object.keys(values).length ? values : null);
        setMessage(Object.keys(values).length ? 'Conexão confirmada. Você pode aplicar os ajustes encontrados ao formulário e conferir antes de salvar.' : 'Conexão confirmada. Não foram encontrados novos ajustes para aplicar.');
      } else if (kind === 'image') {
        const { data } = await axios.post(`${url}/preview-frame`, push ? {} : draft, auth);
        if (run !== generation.current) return;
        const preview = parsePreviewFrame(data);
        setFrame(preview);
        setMessage(preview.ok ? 'Imagem capturada agora. As alterações ainda não foram salvas.' : 'Não foi possível obter uma imagem. Confira a conexão e tente novamente.');
      } else if (kind === 'connection') {
        const { data } = await axios.post(`${url}/test-connection`, {}, auth);
        if (run !== generation.current) return;
        setMessage(data.rtspReachable && data.selectedRtspPortAuthOk !== false && data.rtspAuthOk !== false
          ? 'A câmera respondeu ao teste de conexão.' : 'Não foi possível confirmar o acesso ao vídeo. Confira o endereço, usuário e senha.');
      } else {
        const { data } = await axios.get(`${url}/live-diagnostics`, auth);
        if (run !== generation.current) return;
        const report = parseDiagnosticsReport(data);
        // Do not expose raw URLs, infrastructure reports or credentials to clients.
        setMessage(!report ? 'A verificação não retornou informações suficientes.' : report.state === 'diverged'
          ? 'A imagem recebida difere da configuração salva. Peça ao responsável pela instalação para revisar os perfis.'
          : report.reachable ? 'A câmera respondeu à verificação. Confira a imagem antes de encerrar.' : 'A câmera não respondeu. Verifique se está ligada e conectada.');
      }
    } catch (error) {
      if (run === generation.current) setMessage(getRequestErrorMessage(error, 'Não foi possível verificar a câmera. Tente novamente.'));
    } finally { if (run === generation.current) setBusy(false); }
  };
  return <section className="space-y-3 rounded-lg border border-border p-3">
    <h3 className="text-sm font-medium">Conferir câmera</h3>
    <p className="text-xs text-muted-foreground">A imagem e a detecção usam os dados preenchidos. O teste e a verificação usam a configuração já salva. Nenhuma dessas ações salva este formulário.</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void check('image')}>Conferir imagem</Button>
      {!push && <Button size="sm" variant="outline" disabled={busy} onClick={() => void check('connection')}>Testar conexão salva</Button>}
      {!push && <Button size="sm" variant="outline" disabled={busy} onClick={() => void check('discover')}>Detectar ajustes</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void check('diagnostics')}>Verificar vídeo salvo</Button>
    </div>
    <p role="status" aria-live="polite" className="text-xs">{message}</p>
    {discovered && <Button size="sm" variant="outline" onClick={() => onDiscover(discovered)}>Aplicar ajustes encontrados</Button>}
    {frame?.imageDataUrl && <img src={frame.imageDataUrl} alt="Imagem capturada para conferir a câmera" className="w-full rounded" />}
  </section>;
}
