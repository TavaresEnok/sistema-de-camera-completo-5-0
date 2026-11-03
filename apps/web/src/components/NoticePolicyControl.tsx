import {useEffect,useState} from 'react';
import axios from 'axios';
import {Bell,BellOff,Clock,Plus,Trash2} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {useAuthStore} from '../store/authStore';
import {useNoticePolicyStore} from '../store/noticePolicyStore';
import {getApiBaseUrl} from '../lib/api-base';
import {noticeStateLabel,type NoticePolicyDocument,type NoticePolicy,type NoticeSchedule} from '../lib/notice-policy';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {Button} from './ui/button';

const empty:NoticeSchedule={mode:'always',timezone:'America/Fortaleza',periods:[]};
const days=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
export function NoticePolicyControl({scope='camera',id,name,compact=false,canManage=true}:{scope?:'camera'|'group';id:string;name?:string;compact?:boolean;canManage?:boolean}) {
  const state=useNoticePolicyStore(s=>s.states[id]);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [doc,setDoc]=useState<NoticePolicyDocument|null>(null);
  const [manual,setManual]=useState<NoticePolicy['manualMode']>('auto');
  const [inherit,setInherit]=useState(scope==='camera');
  const [schedule,setSchedule]=useState<NoticeSchedule>(empty);
  const url=`${getApiBaseUrl()}/notice-policies/${scope}/${encodeURIComponent(id)}`;
  const headers=()=>({Authorization:`Bearer ${useAuthStore.getState().accessToken}`});
  const load=async()=>{
    const {data}=await axios.get<NoticePolicyDocument>(url,{headers:headers()});
    setDoc(data);setManual(data.policy.manualMode);setInherit(scope==='camera'&&data.policy.schedule===null);
    setSchedule(data.policy.schedule??data.inheritedSchedule??empty);return data;
  };
  useEffect(()=>{setOpen(false);setDoc(null);setError('');},[id,scope]);
  useEffect(()=>{if(open){setError('');void load().catch(()=>setError('Não foi possível carregar a programação.'));}},[open,id,scope]);
  const update=async(body:Record<string,unknown>,version:string)=>{
    const {data}=await axios.patch<NoticePolicyDocument>(url,{...body,expectedVersion:version},{headers:headers()});
    setDoc(data);await useNoticePolicyStore.getState().refresh().catch(()=>undefined);return data;
  };
  const quick=async(mode:NoticePolicy['manualMode'])=>{
    if(busy)return;setBusy(true);setError('');
    try{const current=await load();await update({manualMode:mode},current.version);}
    catch(e:any){setError(e?.response?.data?.message??'Não foi possível alterar os avisos.');setOpen(true);}
    finally{setBusy(false);}
  };
  const save=async()=>{
    if(!doc)return;setBusy(true);setError('');
    try{await update({...(scope==='camera'?{manualMode:manual}:{}),schedule:inherit?null:schedule},doc.version);setOpen(false);}
    catch(e:any){setError(e?.response?.data?.message??'Não foi possível salvar. Reabra e tente novamente.');}
    finally{setBusy(false);}
  };
  const status=noticeStateLabel(state);
  const portal=typeof document==='undefined'?undefined:document.fullscreenElement as HTMLElement??document.body;
  const icon=state?.active?<Bell className="h-3.5 w-3.5"/>:state?.reason==='outside-period'?<Clock className="h-3.5 w-3.5"/>:<BellOff className="h-3.5 w-3.5"/>;
  return <>
    {compact?<DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild><button type="button" disabled={!canManage||busy} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}
        aria-label={`${status} — ${name??'câmera'}`} title={`${status}${canManage?' · controlar avisos':''}`}
        className={`pointer-events-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-white/15 ${state?.active?'text-emerald-300':state?.reason==='outside-period'?'text-amber-300':'text-white/60'}`}>{icon}</button></DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portal}><DropdownMenu.Content className="z-[160] min-w-52 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md" align="end" sideOffset={6} onClick={e=>e.stopPropagation()}>
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{status}</div>
        {(['auto','on','off'] as const).map((mode,i)=><DropdownMenu.Item key={mode} className="cursor-pointer rounded px-2 py-2 outline-none focus:bg-accent" onSelect={()=>void quick(mode)}>{['Seguir programação','Ativar agora','Pausar avisos'][i]}</DropdownMenu.Item>)}
        <DropdownMenu.Separator className="my-1 h-px bg-border"/>
        <DropdownMenu.Item className="cursor-pointer rounded px-2 py-2 outline-none focus:bg-accent" onSelect={()=>setOpen(true)}>Programar horários...</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>:<Button type="button" variant="outline" disabled={!canManage} onClick={()=>setOpen(true)} className="gap-2"><Clock className="h-4 w-4"/>{scope==='group'?'Horários dos avisos':'Avisos e horários desta câmera'}</Button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent portalContainer={portal} className="max-h-[90dvh] max-w-xl overflow-y-auto" onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
      <DialogHeader><DialogTitle>Avisos — {name??doc?.name??'Programação'}</DialogTitle>
        <DialogDescription>Controle os avisos em tela, o som e as notificações no computador. A detecção e a gravação continuam com suas próprias configurações.</DialogDescription></DialogHeader>
      {doc&&<div className="space-y-4">
        {scope==='camera'&&<label className="block text-sm">Controle dos avisos<select className="mt-1 block w-full rounded border bg-background p-2" value={manual} onChange={e=>setManual(e.target.value as NoticePolicy['manualMode'])}>
          <option value="auto">Automático — seguir os horários</option><option value="on">Ativar manualmente até voltar ao automático</option><option value="off">Pausar até reativar manualmente</option>
        </select></label>}
        <label className="block text-sm">Programação<select aria-label="Programação" className="mt-1 block w-full rounded border bg-background p-2" value={inherit?'inherit':schedule.mode} onChange={e=>{
          const mode=e.target.value;setInherit(mode==='inherit');
          if(mode!=='inherit')setSchedule(s=>({...s,mode:mode as NoticeSchedule['mode'],periods:mode==='periods'?(s.periods.length?s.periods:[{days:[0,1,2,3,4,5,6],start:'22:00',end:'06:00'}]):[]}));
        }}>
          {scope==='camera'&&<option value="inherit">Seguir grupo principal{doc.groupName?` — ${doc.groupName}`:' (sem grupo: sempre)'}</option>}
          <option value="always">Sempre — 24 horas</option><option value="periods">Somente nos períodos definidos</option><option value="off">Sem avisos automáticos</option>
        </select></label>
        {scope==='group'&&<p className="text-xs text-muted-foreground">Vale para câmeras que têm este grupo como principal e seguem seus horários. Câmeras com programação própria não serão alteradas.</p>}
        {inherit&&<p className="text-xs text-muted-foreground">A câmera acompanha futuras mudanças do grupo principal. Para usar horários diferentes, escolha uma programação própria.</p>}
        {!inherit&&schedule.mode==='periods'&&<>
          <label className="block text-sm">Fuso horário<select className="mt-1 block w-full rounded border bg-background p-2" value={schedule.timezone} onChange={e=>setSchedule(s=>({...s,timezone:e.target.value}))}>
            {[...new Set(['America/Fortaleza','America/Sao_Paulo','America/Manaus','America/Rio_Branco','UTC',schedule.timezone])].map(t=><option key={t} value={t}>{t}</option>)}
          </select></label>
          {schedule.periods.map((period,index)=><div className="space-y-2 rounded border p-3" key={index}>
            <div className="flex flex-wrap gap-2">{days.map((day,d)=><label key={day} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={period.days.includes(d)} onChange={e=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,days:e.target.checked?[...p.days,d]:p.days.filter(x=>x!==d)}:p)}))}/>{day}</label>)}</div>
            <div className="flex items-end gap-3"><label className="text-xs">Das<input aria-label={`Início do período ${index+1}`} className="mt-1 block rounded border bg-background p-2" type="time" value={period.start} onChange={e=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,start:e.target.value}:p)}))}/></label>
              <label className="text-xs">Até<input aria-label={`Fim do período ${index+1}`} className="mt-1 block rounded border bg-background p-2" type="time" value={period.end} onChange={e=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,end:e.target.value}:p)}))}/></label>
              <Button size="icon" variant="ghost" aria-label={`Remover período ${index+1}`} onClick={()=>setSchedule(s=>({...s,periods:s.periods.filter((_,i)=>i!==index)}))}><Trash2 className="h-4 w-4"/></Button>
            </div>
          </div>)}
          <Button variant="outline" disabled={schedule.periods.length>=14} onClick={()=>setSchedule(s=>({...s,periods:[...s.periods,{days:[0,1,2,3,4,5,6],start:'22:00',end:'06:00'}]}))}><Plus className="mr-2 h-4 w-4"/>Adicionar período</Button>
          <p className="text-xs text-muted-foreground">Se o fim for antes do início, o período termina no dia seguinte. Os dias marcados indicam o início: segunda, 22h–6h, termina na terça às 6h.</p>
        </>}
        {scope==='camera'&&manual!=='auto'&&<p role="status" className="text-sm text-amber-600">O controle manual tem prioridade sobre os horários até você escolher Automático.</p>}
        {scope==='camera'&&!state?.configured&&<p className="text-xs text-muted-foreground">A programação só controla avisos já habilitados. Na edição da câmera, configure “Avisar na tela” para movimento ou objetos.</p>}
      </div>}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setOpen(false)}>Cancelar</Button><Button disabled={!doc||busy||!canManage} onClick={()=>void save()}>{busy?'Salvando...':'Salvar programação'}</Button></div>
    </DialogContent></Dialog>
  </>;
}
