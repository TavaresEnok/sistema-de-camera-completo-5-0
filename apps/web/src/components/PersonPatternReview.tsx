import axios, { type AxiosInstance } from 'axios';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { usePermissionsStore } from '../store/permissionsStore';

type Example = {id:string; at:string; score:number; reported:boolean; suspect:boolean};
type Preview = {checked:number; matched:number; items:{id:string;at:string;box:number[];hasVideo:boolean}[]};
const when = (at:string) => new Date(at).toLocaleString('pt-BR');
function SampleFrame({id,box,client}:{id:string;box:number[];client:AxiosInstance}) {
  const [url,setUrl] = useState('');
  const [failed,setFailed] = useState(false);
  useEffect(()=>{
    const controller = new AbortController();
    let url = '';
    client.get('/review/'+id+'/thumbnail',{responseType:'blob',signal:controller.signal}).then(({data})=>{
      if (controller.signal.aborted) return;
      url=URL.createObjectURL(data); setUrl(url);
    }).catch(()=>{if (!controller.signal.aborted) setFailed(true);});
    return ()=>{controller.abort(); if (url) URL.revokeObjectURL(url);};
  },[id,client]);
  if (!url) return <p role="status">{failed?'Prévia indisponível. Abra a gravação.':'Carregando quadro…'}</p>;
  return <div className="relative w-fit max-w-full">
    <img src={url} className="block max-h-64 max-w-full" alt="Quadro gravado no instante da ocorrência"/>
    <span aria-label="Caixa de pessoa registrada" className="pointer-events-none absolute border-2 border-amber-400"
      style={{left:100*box[0]+'%',top:100*box[1]+'%',width:100*(box[2]-box[0])+'%',height:100*(box[3]-box[1])+'%'}}/>
  </div>;
}

export function PersonPatternReview({camera,client}:{camera:string;client:AxiosInstance}) {
  const [events,setEvents] = useState<Example[]>([]);
  const [rules,setRules] = useState<string[]>([]);
  const [selected,setSelected] = useState('');
  const [preview,setPreview] = useState<Preview|null>(null);
  const [sample,setSample] = useState('');
  const [checked,setChecked] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [revision,setRevision] = useState(0);
  const user = useAuthStore(s=>s.user);
  const admin = usePermissionsStore(s => user?.role==='admin' && (s.role==='SUPER_ADMIN' || s.permissions.cameraConfig===true));
  const base = '/review/cameras/'+encodeURIComponent(camera)+'/person-patterns';
  const row = events.find(e=>e.id===selected);
  useEffect(()=>{
    const controller = new AbortController();
    client.get(base,{signal:controller.signal}).then(({data})=>{
      setEvents(data.events);setRules(data.rules);
    }).catch(()=>{if (!controller.signal.aborted) setMessage('Falha ao carregar as ocorrências.');});
    return ()=>controller.abort();
  },[base,client,revision]);
  useEffect(()=>{
    setPreview(null);setChecked(false);setSample('');
    if (!selected) return;
    const controller = new AbortController();
    client.get<Preview>(base+'/'+selected+'/preview',{signal:controller.signal}).then(({data})=>setPreview(data))
      .catch(()=>{if (!controller.signal.aborted) setMessage('Falha ao consultar o histórico.');});
    return ()=>controller.abort();
  },[base,selected,client,revision]);
  async function action(id:string, op:'report'|'enable'|'remove') {
    setBusy(true);
    try {
      if (op==='remove') await client.delete(base+'/'+id);
      else await client.post(base+'/'+id+'/'+op);
      setMessage(op==='report'?'Exemplo marcado.':op==='enable'?'Regra salva. A IA sincroniza em até 20 segundos.':'Regra removida.');
      setRevision(v=>v+1);
    } catch(err) { setMessage(axios.isAxiosError(err) && typeof err.response?.data?.message==='string'?err.response.data.message:'Falha ao salvar.'); }
    finally {setBusy(false);}
  }
  const displayed = preview?.items.find(e=>e.id===sample);
  return <section aria-label="Revisão de falsos positivos" className="space-y-2 border-b border-border p-4 text-sm">
    <h3 className="font-semibold">Falsos positivos de pessoa</h3>
    <select className="w-full max-w-lg rounded border border-border bg-background p-2" value={selected} onChange={e=>{setSelected(e.target.value);setMessage('');}}>
      <option value="">Selecione uma ocorrência recente</option>
      {events.map(e=><option key={e.id} value={e.id}>{when(e.at)} · {Math.round(e.score*100)}%{e.reported?' · Marcada':e.suspect?' · Revisar':''}</option>)}
    </select>
    {row && <div className="space-y-2">
      {!row.reported && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>void action(row.id,'report')}>Marcar como falso positivo</button>}
      {preview && <><p>{preview.matched} de {preview.checked} ocorrências recentes com posição, tamanho e confiança compatíveis.</p>
        <div className="flex flex-wrap gap-2">{preview.items.map(e=>e.hasVideo?
          <button key={e.id} type="button" className="underline" onClick={()=>setSample(e.id)}>{when(e.at)}</button>:
          <span key={e.id} className="text-muted-foreground">{when(e.at)} · sem vídeo</span>)}</div>
        {displayed && <><SampleFrame key={displayed.id} id={displayed.id} box={displayed.box} client={client}/>
          <a className="underline" target="_blank" rel="noreferrer" href={'/playback?cameraId='+encodeURIComponent(camera)+'&at='+encodeURIComponent(displayed.at)}>Abrir gravação</a></>}
        {admin && row.reported && !rules.includes(row.id) && row.score<=.65 && preview.items.some(e=>e.hasVideo) &&
          <><p>Até 65% de confiança, a regra exige duas verificações sem confirmação.</p><label className="block"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> Conferi as gravações deste padrão.</label>
          <button className="btn btn-primary btn-sm" disabled={!checked||!displayed||busy} onClick={()=>void action(row.id,'enable')}>Filtrar nesta câmera</button></>}
      </>}
    </div>}
    {rules.map(id=><div className="flex items-center gap-2" key={id}>Regra ativa · {events.find(e=>e.id===id)?when(events.find(e=>e.id===id)!.at):id.slice(0,8)}
      {admin && <button disabled={busy} className="btn btn-secondary btn-sm" onClick={()=>void action(id,'remove')}>Remover</button>}</div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
