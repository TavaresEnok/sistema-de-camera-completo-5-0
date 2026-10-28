import { Switch } from './ui/switch';
import { CLASSES_DE_GRAVACAO, alternarClasse } from '../lib/classes-de-gravacao';
import { useState } from 'react';
import { Volume2 } from 'lucide-react';
import { NOTICE_SOUNDS, normalizeNoticeSound, tocarSomDeAlerta } from '../lib/alert-sound';

export type CameraNoticeSettings = {
  motionNoticeEnabled: boolean; objectNoticeEnabled: boolean; noticeSoundEnabled: boolean; objectNoticeClasses: string[];
  noticeSound: string; noticeDurationSeconds: number;
};

/** Same editor in General and Recording: notices never change recording. */
export function CameraDetectionNotices({ motion, object, sound, soundType = 'attention', duration = 10, classes, allowed, motionAllowed, loading, onChange }: {
  motion: boolean; object: boolean; sound: boolean; classes: string[]; allowed: string[]; motionAllowed: boolean; loading: boolean;
  soundType?: string; duration?: number;
  onChange: (value: CameraNoticeSettings) => void;
}) {
  const [previewError, setPreviewError] = useState(false);
  const update = (value: Partial<CameraNoticeSettings>) => onChange({ motionNoticeEnabled: motion, objectNoticeEnabled: object,
    noticeSoundEnabled: sound, objectNoticeClasses: classes, noticeSound: soundType, noticeDurationSeconds: duration, ...value });
  const enabled = motion || object;
  const mode = motion && object ? 'both' : object ? 'object' : 'motion';
  const changeMode = (value: string) => update({
    motionNoticeEnabled: value !== 'object', objectNoticeEnabled: value !== 'motion', noticeSoundEnabled: sound, objectNoticeClasses: classes,
  });
  return <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Avisos na tela">
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-[13px] font-medium">Avisar na tela</p>
        <p className="text-xs text-muted-foreground">Funciona mesmo sem gravação. Não inicia gravação nem envia mensagens.</p></div>
      <Switch aria-label="Avisar na tela" checked={enabled} disabled={!enabled && (loading || (!motionAllowed && !allowed.length))}
        onCheckedChange={value => update({ motionNoticeEnabled: value && motionAllowed, objectNoticeEnabled: value && !motionAllowed && !!allowed.length, noticeSoundEnabled: value ? sound : false, objectNoticeClasses: classes })} />
    </div>
    {enabled && <>
      <label className="block space-y-1 text-xs"><span>Avisar quando detectar</span>
        <select aria-label="Avisar quando detectar" value={mode} onChange={e => changeMode(e.target.value)}
          className="min-h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="motion" disabled={!motionAllowed}>Movimento</option>
          <option value="object" disabled={!allowed.length}>{allowed.length === 1 && allowed[0] === 'person' ? 'Pessoas' : 'Pessoas ou veículos'}</option>
          <option value="both" disabled={!motionAllowed || !allowed.length}>Movimento e pessoas/veículos</option>
        </select>
      </label>
      {object && <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{classes.length ? 'Avisar apenas sobre os tipos marcados.' : 'Nenhum marcado: avisa sobre todos os tipos disponíveis no plano.'}</p>
        <div className="flex flex-wrap gap-2">{CLASSES_DE_GRAVACAO.filter(c => allowed.includes(c.valor)).map(c =>
          <button key={c.valor} type="button" aria-pressed={classes.includes(c.valor)}
            onClick={() => update({ objectNoticeClasses: alternarClasse(classes, c.valor) })}
            className={`min-h-10 rounded-md border px-3 text-xs ${classes.includes(c.valor) ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>{c.rotulo}</button>)}</div>
      </div>}
      <label className="block space-y-1 text-xs"><span>Tempo do aviso na tela</span>
        <select aria-label="Tempo do aviso na tela" value={duration} onChange={e => update({ noticeDurationSeconds: Number(e.target.value) })}
          className="min-h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          {[5, 10, 15, 20, 30, 60, ...(![5, 10, 15, 20, 30, 60].includes(duration) ? [duration] : [])].sort((a,b)=>a-b).map(seconds => <option key={seconds} value={seconds}>{seconds} segundos{seconds === 10 ? ' (padrão)' : ''}</option>)}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <div><p className="text-[13px] font-medium">Tocar som junto do aviso</p>
          <p className="text-xs text-muted-foreground">Escolha um som para os avisos desta câmera.</p></div>
        <Switch aria-label="Tocar som junto do aviso" checked={sound}
          onCheckedChange={value => update({ noticeSoundEnabled: value })} />
      </div>
      {sound && <div className="space-y-2">
        <label className="block space-y-1 text-xs"><span>Som do alerta</span>
          <select aria-label="Som do alerta" value={normalizeNoticeSound(soundType)} onChange={e => { setPreviewError(false); update({ noticeSound: e.target.value }); }}
            className="min-h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            {NOTICE_SOUNDS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-md border border-input px-3 text-sm hover:bg-accent"
          onClick={() => { void tocarSomDeAlerta(soundType, true).then(ok => setPreviewError(!ok)); }}><Volume2 className="h-4 w-4" aria-hidden="true" />Ouvir som</button>
        <p className="text-xs text-muted-foreground">O som dura cerca de 1 segundo. Salve a câmera para aplicar sua escolha.</p>
        {previewError && <p role="status" className="text-xs text-destructive">Não foi possível tocar. Confira o som do navegador e tente novamente.</p>}
      </div>}
    </>}
    {!loading && !allowed.length && <p className="text-xs text-muted-foreground">Detecção de pessoas e veículos não disponível neste plano.</p>}
  </section>;
}
