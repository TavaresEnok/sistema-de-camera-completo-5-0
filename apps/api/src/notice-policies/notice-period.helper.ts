export type NoticePeriod = { days: number[]; start: string; end: string };
export type NoticeSchedule = { mode: 'always' | 'periods' | 'off'; timezone: string; periods: NoticePeriod[] };
export type NoticePolicy = { manualMode: 'auto' | 'on' | 'off'; schedule: NoticeSchedule | null };
export const DEFAULT_SCHEDULE: NoticeSchedule = { mode: 'always', timezone: 'America/Fortaleza', periods: [] };

export function validSchedule(value: unknown): NoticeSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Programação inválida.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['mode','timezone','periods'].includes(k)) || typeof v.mode !== 'string' || !['always','periods','off'].includes(v.mode)) throw Error('Modo de programação inválido.');
  if (typeof v.timezone !== 'string' || v.timezone.length > 80) throw Error('Fuso horário inválido.');
  try { new Intl.DateTimeFormat('en-US', {timeZone:v.timezone}).format(); } catch { throw Error('Fuso horário inválido.'); }
  if (!Array.isArray(v.periods) || v.periods.length > 14 || (v.mode === 'periods' && !v.periods.length)) throw Error('Adicione de 1 a 14 períodos.');
  const periods = v.periods.map((p: any) => {
    if (!p || typeof p !== 'object' || Object.keys(p).some(k=>!['days','start','end'].includes(k))
      || !Array.isArray(p.days) || !p.days.length || p.days.length > 7 || p.days.some((d: unknown)=>!Number.isInteger(d) || Number(d)<0 || Number(d)>6)
      || new Set(p.days).size !== p.days.length || typeof p.start !== 'string' || typeof p.end !== 'string'
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.end) || p.start === p.end) throw Error('Confira os dias e os horários. Para 24 horas, escolha Sempre.');
    return { days:[...p.days].sort((a,b)=>a-b),start:p.start,end:p.end };
  });
  return { mode:v.mode as NoticeSchedule['mode'], timezone:v.timezone, periods:v.mode === 'periods' ? periods : [] };
}

const formats = new Map<string, Intl.DateTimeFormat>();
export function withinNoticePeriod(schedule: NoticeSchedule, at: Date): boolean {
  if (!Number.isFinite(at.getTime())) return false;
  if (schedule.mode === 'off') return false;
  if (schedule.mode === 'always') return true;
  let format = formats.get(schedule.timezone);
  if (!format) { format = new Intl.DateTimeFormat('en-US',{timeZone:schedule.timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}); if(formats.size>100)formats.clear(); formats.set(schedule.timezone,format); }
  const parts = Object.fromEntries(format.formatToParts(at).map(p=>[p.type,p.value]));
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
  const minute = Number(parts.hour)*60+Number(parts.minute);
  const minutes = (time:string) => Number(time.slice(0,2))*60+Number(time.slice(3));
  return schedule.periods.some(p=>{
    const start=minutes(p.start),end=minutes(p.end);
    // Overnight periods belong to the day on which they START.
    return start<end ? p.days.includes(day)&&minute>=start&&minute<end
      : (p.days.includes(day)&&minute>=start)||(p.days.includes((day+6)%7)&&minute<end);
  });
}
