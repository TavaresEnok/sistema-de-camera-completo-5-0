'use strict';

// Durable, installation-scoped notices. Internal monitoring stays unchanged;
// only customer delivery waits for confirmation and uses a safe vocabulary.
const crypto = require('node:crypto');
const alerts = require('./alertas');
const MAX_JOBS = 1000;
const MAX_INCIDENTS = 1000;
const FRESH_MS = 180000;
const LEASE_MS = 60000;
const text = value => String(value || '').replace(/[\r\n\x00-\x1f]/g,' ').slice(0,120);

function state(item) {
  if (!item.notifications || item.notifications.v !== 1) item.notifications = {v:1,incidents:{},jobs:[],history:[]};
  return item.notifications;
}

function channels(config) {
  return ['telegram','email'].filter(c => c === 'telegram' ? config.telegramEnabled : config.emailEnabled);
}

function destination(config, channel) {
  // Snapshot identity only, not plaintext bot credentials. Changing a group
  // cancels its old queue instead of sending another customer's notices there.
  const source = channel === 'telegram'
    ? [config.telegramChatId,config.botSource,config.botSource === 'central' ? process.env.CENTRAL_TELEGRAM_BOT_TOKEN : config.telegramBotTokenEncrypted]
    : config.emails;
  return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function queue(item, incident, kind, channel, config, now) {
  const s=state(item);
  const target=destination(config,channel),severity=incident.alert.level==='critical'?2:1;
  const delivered=incident.deliveries?.[channel];
  if(kind==='problem'&&delivered?.destination===target&&delivered.severity>=severity)return;
  if(kind==='recovery'&&delivered?.destination!==target)return;
  if (s.jobs.length >= MAX_JOBS) {s.queueError='Há avisos aguardando envio além do limite. Solicite suporte.';return;}
  if (s.jobs.some(j=>j.incident===incident.key && j.generation===incident.generation && j.kind===kind && j.channel===channel && j.destination===target && j.severity===severity && j.status!=='cancelled')) return;
  for(const job of s.jobs)if(kind==='problem'&&job.incident===incident.key&&job.channel===channel&&job.status==='pending'&&job.severity<severity)job.status='cancelled';
  const message=alerts.montarMensagem({instalacao:item,alertas:[incident.alert],recuperado:kind==='recovery'});
  s.jobs.push({id:crypto.randomUUID(),incident:incident.key,generation:incident.generation,kind,channel,
    destination:target,severity,status:'pending',attempts:0,dueAt:now,createdAt:now,message,alert:structuredClone(incident.alert)});
}

function observe(item, rawCameras, now=Date.now()) {
  const config=alerts.normalizarAlertas(item.alertChannels),s=state(item);
  const age=now-new Date(item.lastHeartbeatAt || 0).getTime();
  if (!item.lastHeartbeatAt || !Number.isFinite(age)) return;
  const fresh=age<=FRESH_MS;
  const candidates=new Map(),unknown=new Set();
  for(const [key,incident] of Object.entries(s.incidents)) {
    if(key.startsWith('camera:')&&now-(incident.lastObserved||incident.since)>7*86400000&&!s.jobs.some(j=>j.incident===key&&['pending','sending'].includes(j.status)))delete s.incidents[key];
  }
  let observationLimit=false;
  const put=(key,category,alert,delay=0)=>{
    if (config.audience==='technical' || config.categories.includes(category)) candidates.set(key,{key,category,alert,delay});
  };
  if (age>=config.serverDelayMinutes*60000) put('server','server',{
    code:'installation_offline',level:'critical',message:`O servidor está sem comunicação com a Central há ${Math.floor(age/60000)} minutos. Verifique a internet e a energia do local. Isso não confirma que as gravações pararam.`},0);
  else if (!fresh) unknown.add('server');

  if (fresh) {
    const current=Array.isArray(item.alerts)?item.alerts:[];
    const diskUsage=item.metrics?.diskUsagePercent??item.metrics?.disk?.usagePercent;
    if(!current.some(a=>String(a.code||'').startsWith('disk_usage'))&&(diskUsage===undefined||diskUsage===null||!Number.isFinite(Number(diskUsage))))unknown.add('disk');
    if (config.audience==='technical') {
      for (const a of current) {
        const normalized=alerts.normalizarAlertaOperacional(a);
        if (a.code==='installation_offline') continue;
        put('technical:'+normalized.key,'technical',normalized,['cameras_unavailable','no_online_cameras'].includes(a.code)?config.cameraDelayMinutes*60000:0);
      }
    } else {
      for (const a of current) {
        const code=String(a.code || '');
        if (code.startsWith('disk_usage')) put('disk','disk',alerts.normalizarAlertaOperacional(a));
        else if (['recording_storage_capacity_insufficient','recording_storage_capacity_attention','recording_disabled_all','camera_recording_expected_inactive','cameras_stalled','motion_detection_failsafe','cloud_recordings_missing','cloud_upload_delayed'].includes(code)) {
          put(code,'recording',alerts.normalizarAlertaOperacional(a),code==='cameras_stalled'?config.cameraDelayMinutes*60000:0);
        }
        // Unknown/internal alerts never leak service names into client chats.
      }
      const hasList=Array.isArray(rawCameras) || Array.isArray(rawCameras?.items) || Array.isArray(rawCameras?.cameras);
      if (hasList) {
        if(current.some(a=>['no_online_cameras','cameras_unavailable'].includes(a.code)))unknown.add('cameras-summary');
        const list=Array.isArray(rawCameras)?rawCameras:(rawCameras.items || rawCameras.cameras);
        const seen=new Set();
        for (const camera of list.slice(0,1000)) {
          const id=text(camera.cameraId || camera.id);if(!id)continue;
          const key='camera:'+id;seen.add(key);
          if(camera.enabled===false){cancelIncident(item,key);continue;}
          const status=String(camera.status || '').toUpperCase();
          if (['OFFLINE','ERROR'].includes(status)) put(key,'camera',{
            code:'camera_offline',level:'warning',message:`A câmera “${text(camera.name) || id}” está sem comunicação há pelo menos ${config.cameraDelayMinutes} minutos.`,
            recoveryMessage:`A câmera “${text(camera.name) || id}” voltou a se comunicar.`},config.cameraDelayMinutes*60000);
          else if(status!=='ONLINE')unknown.add(key);
        }
        // A missing row is not proof of recovery/removal. Truncated and
        // partial reports must not invent that a camera came back online.
        for(const key of Object.keys(s.incidents))if(key.startsWith('camera:')&&!seen.has(key))unknown.add(key);
      } else {
        for(const key of Object.keys(s.incidents))if(key.startsWith('camera:'))unknown.add(key);
        const a=current.find(a=>['no_online_cameras','cameras_unavailable'].includes(a.code));
        if(a)put('cameras-summary','camera',alerts.normalizarAlertaOperacional(a),config.cameraDelayMinutes*60000);
      }
    }
  } else {
    for(const key of Object.keys(s.incidents))if(key!=='server')unknown.add(key);
  }

  for(const [key,candidate] of candidates) {
    let incident=s.incidents[key];
    if(!incident&&Object.keys(s.incidents).length>=MAX_INCIDENTS){observationLimit=true;continue;}
    if(!incident||!incident.active){
      for(const job of s.jobs)if(job.incident===key&&job.kind==='recovery'&&job.status==='pending')job.status='cancelled';
      incident=s.incidents[key]={key,generation:crypto.randomUUID(),since:now,active:true,delivered:[]};
    }
    incident.active=true;incident.alert=candidate.alert;incident.category=candidate.category;
    // Do not count time when the installation/observation was unavailable.
    if(candidate.delay && incident.lastObserved && now-incident.lastObserved>FRESH_MS && !incident.delivered.length)incident.since=now;
    incident.lastObserved=key==='server'?now:new Date(item.lastHeartbeatAt).getTime();
    if(now-incident.since>=candidate.delay)for(const c of channels(config))queue(item,incident,'problem',c,config,now);
  }
  for(const [key,incident] of Object.entries(s.incidents)) {
    if(candidates.has(key)||unknown.has(key))continue;
    for(const job of s.jobs)if(job.incident===key&&job.kind==='problem'&&job.status==='pending')job.status='cancelled';
    incident.active=false;
    if(config.avisarRecuperacao)for(const c of incident.delivered)if(channels(config).includes(c))queue(item,incident,'recovery',c,config,now);
    // Keep resolved incidents until any in-flight send acknowledges, allowing
    // a positive recovery after a message delivered during the transition.
    if(!s.jobs.some(j=>j.incident===key&&['sending','pending'].includes(j.status)))delete s.incidents[key];
  }
  s.jobs=s.jobs.filter(j=>['pending','sending'].includes(j.status)||(j.status==='failed'&&s.incidents[j.incident]?.active&&s.incidents[j.incident]?.generation===j.generation&&j.destination===destination(config,j.channel))||now-(j.finishedAt||j.createdAt)<86400000).slice(-MAX_JOBS);
  if(observationLimit)s.queueError='O limite de avisos acompanhados foi atingido. Solicite suporte.';
  else if(s.jobs.length<MAX_JOBS)s.queueError=null;
  s.history=s.history.slice(-100);
}

function cancelIncident(item,key) {
  const s=state(item);
  for(const job of s.jobs)if(job.incident===key&&['pending','sending'].includes(job.status))job.status='cancelled';
  delete s.incidents[key];
}

function claim(item,now=Date.now(),filter=null) {
  const s=state(item),config=alerts.normalizarAlertas(item.alertChannels);
  for(const job of s.jobs) {
    if(!channels(config).includes(job.channel)||destination(config,job.channel)!==job.destination){if(['pending','sending'].includes(job.status))job.status='cancelled';continue;}
    if(job.status==='sending'&&job.leaseUntil<=now)job.status='pending';
    if(job.status!=='pending'||job.dueAt>now)continue;
    if(filter&&(job.channel!==filter.channel||job.kind!==filter.kind))continue;
    if(job.kind==='problem'&&!s.incidents[job.incident]?.active){job.status='cancelled';continue;}
    job.status='sending';job.lease=crypto.randomUUID();job.leaseUntil=now+LEASE_MS;job.attempts++;
    return {installationId:item.id,job:structuredClone(job),config:structuredClone(config)};
  }
  return null;
}

function claimBatch(item,now=Date.now()) {
  const first=claim(item,now);if(!first)return null;
  const jobs=[first.job];
  while(jobs.length<8){const next=claim(item,now,first.job);if(!next)break;jobs.push(next.job);}
  return {...first,jobs,message:alerts.montarMensagem({instalacao:item,alertas:jobs.map(j=>j.alert || {message:j.message.texto}),recuperado:first.job.kind==='recovery'})};
}

function finish(item,claimed,result,now=Date.now()) {
  const s=state(item),job=s.jobs.find(j=>j.id===claimed.id);
  if(!job||job.status!=='sending'||job.lease!==claimed.lease)return;
  if(destination(alerts.normalizarAlertas(item.alertChannels),job.channel)!==job.destination){job.status='cancelled';return;}
  job.lastError=result.ok?null:String(result.erro||'Não foi possível confirmar o envio.').slice(0,240);
  if(result.ok) {
    job.status='sent';job.finishedAt=now;
    const incident=s.incidents[job.incident];
    if(incident&&incident.generation===job.generation&&job.kind==='problem') {
      if(!incident.delivered.includes(job.channel))incident.delivered.push(job.channel);
      incident.deliveries ||= {};
      incident.deliveries[job.channel]={destination:job.destination,severity:job.severity};
      const config=alerts.normalizarAlertas(item.alertChannels);
      if(!incident.active&&config.avisarRecuperacao)queue(item,incident,'recovery',job.channel,config,now);
    }
  } else if(result.permanent||job.attempts>=8) {job.status='failed';job.finishedAt=now;}
  else {job.status='pending';job.dueAt=now+Math.max(15000,Number(result.retryAfterSeconds||0)*1000,Math.min(3600000,15000*2**(job.attempts-1)));}
  s.history.push({at:now,channel:job.channel,kind:job.kind,status:job.status,attempts:job.attempts,error:job.lastError});s.history=s.history.slice(-100);
}

function publicStatus(item) {
  const s=item.notifications || {};
  const jobs=Array.isArray(s.jobs)?s.jobs:[];
  return {pending:jobs.filter(j=>['pending','sending'].includes(j.status)).length,
    failed:jobs.filter(j=>j.status==='failed').length,lastDelivery:(s.history || []).at(-1)||null,queueError:s.queueError||null};
}

function retryConfirmedChannel(item,channel,now=Date.now()) {
  const s=state(item),config=alerts.normalizarAlertas(item.alertChannels);
  for(const job of s.jobs) {
    if(job.status!=='failed'||job.channel!==channel||job.destination!==destination(config,channel))continue;
    const incident=s.incidents[job.incident];
    if(job.kind==='problem'&&(!incident?.active||incident.generation!==job.generation)){job.status='cancelled';continue;}
    job.status='pending';job.attempts=0;job.dueAt=now;job.finishedAt=null;job.lastError=null;
  }
}

module.exports={observe,claim,claimBatch,finish,publicStatus,destination,retryConfirmedChannel};
