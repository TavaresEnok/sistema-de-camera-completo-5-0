import { useEffect, useState } from 'react';
import axios from 'axios';
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Plus, RefreshCw, Server, Settings, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getApiBaseUrl } from '../lib/api-base';
import { getRequestErrorMessage } from '../lib/request-error';
import { useAuthStore } from '../store/authStore';
import { useBrandingStore } from '../store/brandingStore';
import { hasPermission, usePermissionsStore } from '../store/permissionsStore';
import { Camera, useVmsDataStore } from '../store/vmsDataStore';
import { CameraEditSheet } from '../components/CameraEditSheet';

type Recorder = { id: string; name: string; manufacturer: string; ip: string; rtspPort: number; httpPort: number; onvifPort?: number; username: string; groupId: string; group?: { name: string }; _count?: { channels: number } };
type Channel = { id: string; name: string; channel: number; status: string; enabled: boolean; recordingMode: string; isPrivate: boolean };
type Detail = Recorder & { channels: Channel[]; candidates?: Channel[] };
type DraftChannel = { channel: number; name: string; rtspPath: string; selected: boolean; verified: boolean };
type Result = { channel: number; name: string; status: string; message?: string };
const brands: Record<string, string> = { generic: 'Outro / ONVIF', intelbras: 'Intelbras', dahua: 'Dahua', hikvision: 'Hikvision' };
const emptyForm = { name: '', ip: '', username: '', password: '', groupId: '', manufacturer: 'intelbras', rtspPort: '554', httpPort: '80', onvifPort: '' };

export default function RecordersPage() {
  usePermissionsStore(s => s.permissions);
  const token = useAuthStore(s => s.accessToken);
  const enabled = useBrandingStore(s => s.recordersEnabled);
  const cameras = useVmsDataStore(s => s.cameras);
  const loadCameras = useVmsDataStore(s => s.load);
  const [rows, setRows] = useState<Recorder[]>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'channels' | 'connection'>('channels');
  const [form, setForm] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<DraftChannel[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [message, setMessage] = useState('');
  const [image, setImage] = useState('');
  const [editing, setEditing] = useState<Camera | null>(null);
  const [manual, setManual] = useState(false);
  const api = getApiBaseUrl();
  const config = { headers: { Authorization: `Bearer ${token}` } };
  const allowed = enabled && hasPermission('cameraConfig');

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError(getRequestErrorMessage(e, 'Não foi possível concluir a operação.')); }
    finally { setBusy(''); }
  }
  async function refresh(id?: string) {
    const { data } = await axios.get(`${api}/recorders`, config); setRows(data);
    if (id) setDetail((await axios.get(`${api}/recorders/${id}`, config)).data);
  }
  useEffect(() => {
    if (!allowed || !token) return;
    void run('loading', async () => {
      await refresh();
      const { data } = await axios.get(`${api}/camera-groups`, config); setGroups(data);
      await loadCameras();
    });
  }, [allowed, token]);

  function resetView() { setDrafts([]); setResults([]); setMessage(''); setImage(''); setManual(false); setTab('channels'); setError(''); }
  function addDraft() {
    const used = [...drafts.map(d => d.channel), ...(detail?.channels ?? []).map(d => d.channel)];
    let n = 1; while (used.includes(n)) n++;
    setDrafts(d => [...d, { channel: n, name: `Canal ${n}`, rtspPath: '', selected: true, verified: false }]); setManual(true);
  }
  function changeDraft(index: number, patch: Partial<DraftChannel>) {
    setDrafts(d => d.map((row, i) => i === index ? { ...row, ...patch, ...('selected' in patch ? {} : { verified: false }) } : row));
  }
  const selected = drafts.filter(d => d.selected);

  if (!allowed) return <div className="p-6 text-sm text-muted-foreground">DVR/NVR não está disponível para este acesso.</div>;

  return <div className="h-full overflow-auto p-4 md:p-6 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {detail && <Button variant="outline" size="icon" aria-label="Voltar aos gravadores" disabled={!!busy} onClick={() => { setDetail(null); resetView(); }}><ArrowLeft className="w-4 h-4" /></Button>}
        <div><h1 className="text-lg font-semibold">{detail ? detail.name : 'DVR/NVR'}</h1><p className="text-xs text-muted-foreground mt-1">{detail ? `${brands[detail.manufacturer]} · ${detail.ip}` : 'Gravadores e canais, organizados por cliente.'}</p></div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={!!busy} onClick={() => void run('loading', () => refresh(detail?.id))}><RefreshCw className="w-4 h-4 mr-2" />Atualizar</Button>
        {!detail && <Button onClick={() => { setForm(emptyForm); setAdding(true); setError(''); }}><Plus className="w-4 h-4 mr-2" />Adicionar gravador</Button>}
      </div>
    </div>

    {error && <div role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}
    {busy && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="w-4 h-4 animate-spin" />{busy === 'discover' ? 'Buscando canais ONVIF…' : busy === 'import' ? 'Confirmando e importando canais. Aguarde…' : busy === 'check' ? 'Verificando o vídeo…' : 'Carregando…'}</div>}

    {!detail ? <div className="rounded-lg border bg-card overflow-x-auto">
      <div className="md:hidden divide-y">{rows.map(row => <button key={row.id} className="w-full p-4 text-left flex items-center justify-between gap-3" disabled={!!busy} onClick={() => { resetView(); void run('loading', async () => setDetail((await axios.get(`${api}/recorders/${row.id}`, config)).data)); }}><div><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground mt-1">{row.group?.name} · {brands[row.manufacturer]}</p><p className="text-xs text-muted-foreground mt-1">{row.ip} · {row._count?.channels ?? 0} canais</p></div><ChevronRight className="h-4 w-4 shrink-0" /></button>)}</div>
      <table className="hidden md:table w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="p-4">Gravador</th><th className="p-4">Cliente / grupo</th><th className="p-4">Fabricante</th><th className="p-4">Canais importados</th><th /></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-b last:border-0"><td className="p-4"><span className="font-medium">{row.name}</span><div className="text-xs text-muted-foreground mt-1">{row.ip}</div></td><td className="p-4">{row.group?.name}</td><td className="p-4">{brands[row.manufacturer]}</td><td className="p-4">{row._count?.channels ?? 0}</td><td className="p-4"><Button variant="ghost" disabled={!!busy} onClick={() => { resetView(); void run('loading', async () => setDetail((await axios.get(`${api}/recorders/${row.id}`, config)).data)); }}>Abrir<ChevronRight className="w-4 h-4 ml-1" /></Button></td></tr>)}</tbody>
      </table>{!rows.length && !busy && <div className="p-12 text-center text-muted-foreground"><Server className="w-8 h-8 mx-auto mb-3" /><p>Nenhum gravador cadastrado.</p><p className="text-xs mt-2">Adicione o equipamento e escolha os canais que deseja monitorar.</p></div>}
    </div> : <>
      <div className="flex gap-2 border-b pb-2"><Button variant={tab === 'channels' ? 'secondary' : 'ghost'} onClick={() => setTab('channels')}>Canais</Button><Button variant={tab === 'connection' ? 'secondary' : 'ghost'} onClick={() => setTab('connection')}>Conexão</Button></div>
      {tab === 'connection' ? <div className="rounded-lg border bg-card p-5 space-y-4 max-w-xl">
        <dl className="grid grid-cols-2 gap-4 text-sm">{[['IP', detail.ip], ['RTSP', detail.rtspPort], ['HTTP', detail.httpPort], ['ONVIF', detail.onvifPort ?? detail.httpPort], ['Usuário', detail.username], ['Senha', '••••••••']].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono">{value}</dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">O cadastro não altera as configurações nem as gravações do equipamento.</p>
        <Button variant="outline" disabled={!!busy} onClick={() => { setForm({ name: detail.name, ip: detail.ip, rtspPort: String(detail.rtspPort), httpPort: String(detail.httpPort), onvifPort: detail.onvifPort ? String(detail.onvifPort) : '', username: detail.username, password: '', groupId: detail.groupId, manufacturer: detail.manufacturer }); setAdding(true); }}>Editar conexão</Button>
      </div> : <>
        <div className="md:hidden space-y-2">{detail.channels.map(c => <div key={c.id} className="rounded-lg border bg-card p-4"><div className="flex justify-between items-center gap-2"><p className="text-sm font-medium">{c.name}</p><Button variant="outline" size="sm" onClick={() => setEditing(cameras.find(cam => cam.id === c.id) ?? null)}>Configurar</Button></div><p className="text-xs text-muted-foreground mt-2">Canal {c.channel} · {!c.enabled ? 'Desativado' : c.status === 'ONLINE' ? 'Online' : 'Em verificação'} · {c.recordingMode === 'manual' ? 'Gravação manual' : c.recordingMode}</p></div>)}</div>
        <div className="rounded-lg border bg-card overflow-x-auto"><table className="hidden md:table w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="p-3">Canal</th><th className="p-3">Nome</th><th className="p-3">Conexão</th><th className="p-3">Gravação S2Cam</th><th /></tr></thead><tbody>
          {detail.channels.map(c => <tr key={c.id} className="border-b last:border-0"><td className="p-3">{c.channel}</td><td className="p-3">{c.name}</td><td className="p-3">{!c.enabled ? 'Desativado' : c.status === 'ONLINE' ? 'Online' : c.status === 'OFFLINE' ? 'Offline' : 'Em verificação'}</td><td className="p-3">{{ manual: 'Manual', continuous: 'Contínua', motion: 'Movimento', object: 'Objeto' }[c.recordingMode] ?? c.recordingMode}</td><td className="p-3"><Button variant="ghost" onClick={() => setEditing(cameras.find(cam => cam.id === c.id) ?? null)}><Settings className="w-4 h-4 mr-2" />Configurar</Button></td></tr>)}
        </tbody></table>{!detail.channels.length && <p className="p-5 text-sm text-muted-foreground">Nenhum canal importado.</p>}</div>

        {!!detail.candidates?.length && <div className="rounded-lg border p-4 space-y-2"><p className="text-sm font-medium">Canais já cadastrados individualmente</p>{detail.candidates.map(c => <div key={c.id} className="flex justify-between gap-3 text-sm"><span>{c.name} · canal {c.channel}</span><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void run('link', async () => { await axios.post(`${api}/recorders/${detail.id}/link`, { cameraId: c.id }, config); await refresh(detail.id); await loadCameras(); })}>Vincular mantendo histórico</Button></div>)}</div>}

        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="flex flex-wrap justify-between gap-3 items-center"><h2 className="text-sm font-semibold">Adicionar canais</h2><div className="flex gap-2"><Button variant="outline" disabled={!!busy} onClick={() => void run('discover', async () => { const { data } = await axios.post(`${api}/recorders/${detail.id}/discover`, {}, { ...config, timeout: 40000 }); setDrafts(data.channels.filter((c: DraftChannel) => !detail.channels.some(old => old.channel === c.channel)).map((c: DraftChannel) => ({ ...c, selected: false, verified: false }))); setMessage(data.message); setResults([]); setImage(''); })}>Buscar canais</Button><Button variant="outline" disabled={!!busy || drafts.length >= 64} onClick={addDraft}><Plus className="w-4 h-4 mr-1" />Manual</Button></div></div>
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
          {!!drafts.length && <div className="space-y-3">{drafts.map((d, i) => <div key={i} className="rounded border p-3 space-y-2">
            <div className="flex items-end flex-wrap gap-3"><input aria-label={`Selecionar canal ${d.channel}`} type="checkbox" checked={d.selected} disabled={!!busy} onChange={e => changeDraft(i, { selected: e.target.checked })} className="mb-3" /><div className="w-20"><Label className="text-xs">Canal</Label><Input type="number" min={1} max={256} value={d.channel} disabled={!!busy} onChange={e => changeDraft(i, { channel: Number(e.target.value) })} /></div><div className="min-w-40 flex-1"><Label className="text-xs">Nome</Label><Input value={d.name} disabled={!!busy} onChange={e => changeDraft(i, { name: e.target.value })} /></div>
              <Button variant="outline" disabled={!!busy || !d.name.trim() || d.channel < 1} onClick={() => void run('check', async () => { const { data } = await axios.post(`${api}/recorders/${detail.id}/check`, { channel: d.channel, name: d.name, rtspPath: d.rtspPath || undefined }, { ...config, timeout: 60000 }); setDrafts(rows => rows.map((row, idx) => idx === i ? { ...row, verified: data.ok } : row)); setImage(data.frame?.imageDataUrl ?? ''); setMessage(data.frame?.ok ? `Canal ${d.channel} confirmado. Confira a imagem.` : `Canal ${d.channel}: vídeo confirmado, mas a imagem de prévia não ficou disponível.`); })}>{d.verified ? <Check className="w-4 h-4 mr-2" /> : <Video className="w-4 h-4 mr-2" />}{d.verified ? 'Vídeo confirmado' : 'Verificar vídeo'}</Button>
            </div>
            {(manual || detail.manufacturer === 'generic' || d.rtspPath) && <div><Label className="text-xs">Caminho RTSP {detail.manufacturer !== 'generic' && '(opcional)'}</Label><Input placeholder="/cam/realmonitor?channel=1&subtype=0" value={d.rtspPath} disabled={!!busy} onChange={e => changeDraft(i, { rtspPath: e.target.value })} className="font-mono text-xs" /></div>}
          </div>)}</div>}
          {image && <img src={image} alt="Prévia do canal verificado" className="max-h-64 max-w-full rounded border bg-black" />}
          {!!drafts.length && <div className="flex flex-wrap justify-between gap-3 items-center border-t pt-4"><p className="text-xs text-muted-foreground">Gravação manual · retenção do grupo · IA e alertas desligados</p><Button disabled={!!busy || !selected.length || selected.some(d => !d.verified)} onClick={() => void run('import', async () => { const { data } = await axios.post(`${api}/recorders/${detail.id}/import`, { channels: selected.map(({ channel, name, rtspPath }) => ({ channel, name, rtspPath: rtspPath || undefined })) }, { ...config, timeout: 600000 }); setResults(data.results); setImage(''); setMessage(''); const done = new Set(data.results.filter((r: Result) => r.status !== 'error').map((r: Result) => r.channel)); setDrafts(ds => ds.filter(d => !done.has(d.channel))); await refresh(detail.id); await loadCameras(); })}>Importar {selected.length || ''} {selected.length === 1 ? 'canal' : 'canais'}</Button></div>}
          {!!results.length && <ul className="space-y-2 text-sm" aria-live="polite">{results.map(r => <li key={r.channel} className={r.status === 'error' ? 'text-destructive' : ''}>{r.name}: {r.status === 'created' ? 'importado' : r.status === 'existing' ? 'já importado' : r.message}</li>)}</ul>}
        </div>
      </>}
    </>}

    <Dialog open={adding} onOpenChange={value => { if (!busy) setAdding(value); }}><DialogContent className="max-w-lg max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>{detail ? 'Editar gravador' : 'Adicionar gravador'}</DialogTitle><DialogDescription>Informe o acesso ao equipamento e o grupo responsável.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void run('save', async () => {
        const payload = { ...form, rtspPort: Number(form.rtspPort), httpPort: Number(form.httpPort), onvifPort: form.onvifPort ? Number(form.onvifPort) : undefined, ...(detail && !form.password ? { password: undefined } : {}) };
        const { data } = detail ? await axios.patch(`${api}/recorders/${detail.id}`, payload, config) : await axios.post(`${api}/recorders`, payload, config);
        setAdding(false); resetView(); await refresh(); setDetail(data);
      }); }}>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div><Label htmlFor="recorder-name">Nome</Label><Input id="recorder-name" value={form.name} required maxLength={100} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Gravador da loja" /></div>
        <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="recorder-ip">IP do gravador</Label><Input id="recorder-ip" value={form.ip} required onChange={e => setForm({ ...form, ip: e.target.value })} autoComplete="off" /></div><div><Label>Fabricante</Label><Select value={form.manufacturer} onValueChange={manufacturer => setForm({ ...form, manufacturer })}><SelectTrigger aria-label="Fabricante"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(brands).map(([key, value]) => <SelectItem key={key} value={key}>{value}</SelectItem>)}</SelectContent></Select></div></div>
        <div className="grid grid-cols-2 gap-3"><div><Label htmlFor="recorder-user">Usuário</Label><Input id="recorder-user" value={form.username} required autoComplete="off" onChange={e => setForm({ ...form, username: e.target.value })} /></div><div><Label htmlFor="recorder-password">{detail ? 'Nova senha (opcional)' : 'Senha'}</Label><Input id="recorder-password" type="password" autoComplete="new-password" value={form.password} required={!detail} onChange={e => setForm({ ...form, password: e.target.value })} /></div></div>
        <div><Label>Cliente / grupo</Label><Select value={form.groupId} onValueChange={groupId => setForm({ ...form, groupId })}><SelectTrigger aria-label="Cliente / grupo"><SelectValue placeholder="Selecione" /></SelectTrigger><SelectContent>{groups.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent></Select></div>
        <details><summary className="cursor-pointer text-xs text-muted-foreground">Conexão avançada</summary><div className="grid grid-cols-3 gap-3 mt-3">{(['rtspPort', 'httpPort', 'onvifPort'] as const).map(key => <div key={key}><Label htmlFor={key}>{key === 'rtspPort' ? 'RTSP' : key === 'httpPort' ? 'HTTP' : 'ONVIF'}</Label><Input id={key} type="number" min={1} max={65535} required={key !== 'onvifPort'} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /></div>)}</div></details>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={!!busy} onClick={() => setAdding(false)}>Cancelar</Button><Button type="submit" disabled={!!busy || !form.groupId}>{busy === 'save' ? 'Salvando…' : detail ? 'Salvar' : 'Salvar e escolher canais'}</Button></div>
      </form>
    </DialogContent></Dialog>
    <CameraEditSheet camera={editing} open={!!editing} onClose={() => { setEditing(null); void run('loading', async () => { await refresh(detail?.id); if (token) await loadCameras(); }); }} />
  </div>;
}
