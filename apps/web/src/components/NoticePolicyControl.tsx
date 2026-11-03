import {useEffect,useState} from 'react';
import axios from 'axios';
import {Bell,BellOff,Clock,Plus,Trash2,ChevronDown} from 'lucide-react';
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
  useEffect(()=>{if(open){setDoc(null);setError('');void load().catch(()=>setError('Não foi possível carregar os horários.'));}},[open,id,scope]);
  const update=async(body:Record<string,unknown>,version:string)=>{
    const {data}=await axios.patch<NoticePolicyDocument>(url,{...body,expectedVersion:version},{headers:headers()});
    setDoc(data);await useNoticePolicyStore.getState().refresh().catch(()=>undefined);return data;
  };
  const quick=async(mode:NoticePolicy['manualMode'])=>{
    if(busy)return;setBusy(true);setError('');
    try{const current=await load();await update({manualMode:mode},current.version);}
    catch(e:any){setError(e?.response?.data?.message??'Não foi possível alterar os avisos.');}
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
        <DropdownMenu.Item className="cursor-pointer rounded px-2 py-2 outline-none focus:bg-accent" onSelect={()=>setOpen(true)}>Horários...</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>:<Button type="button" variant="outline" disabled={!canManage} onClick={()=>setOpen(true)} className="gap-2"><Clock className="h-4 w-4"/>Horários dos avisos</Button>}
    {!open&&error&&<span role="alert" className="text-xs text-destructive">{error}</span>}
    <Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent portalContainer={portal} className="max-h-[90dvh] max-w-md overflow-y-auto" onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
      <DialogHeader><DialogTitle>Horários dos avisos</DialogTitle>
        <DialogDescription className="truncate">{name??doc?.name??(scope==='camera'?'Câmera':'Grupo')}</DialogDescription></DialogHeader>
      {!doc&&!error&&<p role="status" className="text-sm text-muted-foreground">Carregando...</p>}
      {doc&&<fieldset disabled={busy} className="min-w-0 space-y-4">
        {scope==='camera'&&manual!=='auto'&&<div role="status" className="flex items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
          <span>{manual==='off'?'Avisos pausados manualmente':'Avisos ligados manualmente'}</span>
          <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={()=>setManual('auto')}>Usar horários</button>
        </div>}
        <label className="block text-sm font-medium">Quando avisar?<select aria-label="Programação" className="mt-2 block h-10 w-full rounded-md border bg-background px-3 text-sm font-normal" value={inherit?'inherit':schedule.mode} onChange={e=>{
          const mode=e.target.value;setInherit(mode==='inherit');
          if(mode!=='inherit')setSchedule(s=>({...s,mode:mode as NoticeSchedule['mode'],periods:mode==='periods'?(s.periods.length?s.periods:[{days:[0,1,2,3,4,5,6],start:'22:00',end:'06:00'}]):[]}));
        }}>
          {scope==='camera'&&<option value="inherit">Seguir o grupo{doc.groupName?` — ${doc.groupName}`:' (24 horas)'}</option>}
          <option value="always">24 horas</option><option value="periods">Escolher dias e horários</option><option value="off">Desligado</option>
        </select></label>
        {!inherit&&schedule.mode==='periods'&&<>
          {schedule.periods.map((period,index)=><div className="space-y-3 rounded-lg border p-3" key={index}>
            <div className="grid grid-cols-7 gap-1">{days.map((day,d)=><button key={day} type="button" aria-label={`${day} do período ${index+1}`} aria-pressed={period.days.includes(d)}
              className={`flex h-9 min-w-0 items-center justify-center rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${period.days.includes(d)?'border-primary bg-primary text-primary-foreground':'border-border text-muted-foreground hover:bg-accent'}`}
              onClick={()=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,days:p.days.includes(d)?p.days.filter(x=>x!==d):[...p.days,d]}:p)}))}>{day}</button>)}</div>
            <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs text-muted-foreground">Das<input aria-label={`Início do período ${index+1}`} className="mt-1 block h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm text-foreground" type="time" value={period.start} onChange={e=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,start:e.target.value}:p)}))}/></label>
              <label className="min-w-0 flex-1 text-xs text-muted-foreground">Até<input aria-label={`Fim do período ${index+1}`} className="mt-1 block h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm text-foreground" type="time" value={period.end} onChange={e=>setSchedule(s=>({...s,periods:s.periods.map((p,i)=>i===index?{...p,end:e.target.value}:p)}))}/></label>
              <Button type="button" size="icon" variant="ghost" aria-label={`Remover período ${index+1}`} disabled={schedule.periods.length===1} onClick={()=>setSchedule(s=>({...s,periods:s.periods.filter((_,i)=>i!==index)}))}><Trash2 className="h-4 w-4"/></Button>
            </div>
            {period.end<period.start&&<p className="text-xs text-muted-foreground">Termina no dia seguinte.</p>}
          </div>)}
          <Button type="button" variant="ghost" size="sm" disabled={schedule.periods.length>=14} onClick={()=>setSchedule(s=>({...s,periods:[...s.periods,{days:[0,1,2,3,4,5,6],start:'22:00',end:'06:00'}]}))}><Plus className="mr-1.5 h-3.5 w-3.5"/>Outro horário</Button>
        </>}
        <details className="group border-t pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs text-muted-foreground">Mais opções<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180"/></summary>
          <div className="space-y-3 pt-3">
            {!inherit&&schedule.mode==='periods'&&<label className="block text-xs text-muted-foreground">Fuso horário<select aria-label="Fuso horário" className="mt-1 block h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={schedule.timezone} onChange={e=>setSchedule(s=>({...s,timezone:e.target.value}))}>
              {[...new Set(['America/Fortaleza','America/Sao_Paulo','America/Manaus','America/Rio_Branco','UTC',schedule.timezone])].map(t=><option key={t} value={t}>{({'America/Fortaleza':'Brasília (Fortaleza)','America/Sao_Paulo':'Brasília (São Paulo)','America/Manaus':'Manaus','America/Rio_Branco':'Rio Branco','UTC':'UTC'} as Record<string,string>)[t]??t}</option>)}
            </select></label>}
            {scope==='camera'&&<label className="block text-xs text-muted-foreground">Controle manual<select aria-label="Controle manual" className="mt-1 block h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={manual} onChange={e=>setManual(e.target.value as NoticePolicy['manualMode'])}>
              <option value="auto">Seguir horários</option><option value="on">Sempre ligado</option><option value="off">Pausado</option>
            </select></label>}
            <p className="text-xs text-muted-foreground">Só altera pop-up, som e notificações. Não altera gravações.</p>
            {scope==='group'&&<p className="text-xs text-muted-foreground">Vale para câmeras que seguem este grupo principal. Horários individuais são mantidos.</p>}
            {scope==='camera'&&<p className="text-xs text-muted-foreground">O controle manual prevalece até voltar a “Seguir horários”.</p>}
          </div>
        </details>
        {scope==='camera'&&state?.configured===false&&<p className="text-xs text-amber-600">Ative “Avisar na tela” na edição da câmera.</p>}
      </fieldset>}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="outline" disabled={busy} onClick={()=>setOpen(false)}>Cancelar</Button><Button type="button" disabled={!doc||busy||!canManage} onClick={()=>void save()}>{busy?'Salvando...':'Salvar'}</Button></div>
    </DialogContent></Dialog>
  </>;
}
