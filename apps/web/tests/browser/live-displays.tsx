// Harness isolado: usa o hook real, sem autenticar ou acessar câmeras de produção.
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLiveDisplays } from '../../src/hooks/use-live-displays';
import { useAuthStore } from '../../src/store/authStore';
import type { LiveDisplayId } from '../../src/store/gridStore';

const params = new URLSearchParams(location.search);
useAuthStore.setState({ user: { id: params.get('user') ?? 'test', name: 'Teste' } as any });
function Harness() {
  const [cameraIds, setCameras] = useState<string[]>([]);
  const [result, setResult] = useState('');
  const remove = useCallback((id: string) => setCameras(ids => ids.filter(value => value !== id)), []);
  const coordination = useLiveDisplays((params.get('display') ?? 'main') as LiveDisplayId, cameraIds, remove);
  (window as any).testLive = {
    add: (id: string) => setCameras(ids => [...new Set([...ids, id])]),
    move: async (from: LiveDisplayId, id: string) => {
      const ok = await coordination.moveFromOtherDisplay(from, id);
      if (ok) setCameras(ids => [...new Set([...ids, id])]);
      setResult(ok ? 'moved' : 'failed');
      return ok;
    },
    snapshot: () => ({ cameraIds, result, superseded: coordination.isSuperseded, displays: coordination.displays }),
  };
  return <pre>{JSON.stringify({ cameraIds, result, superseded: coordination.isSuperseded })}</pre>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
