import { Switch } from './ui/switch';
import { CLASSES_DE_GRAVACAO, alternarClasse } from '../lib/classes-de-gravacao';

/** Same editor in General and Recording: notices never change recording. */
export function CameraDetectionNotices({ motion, object, classes, allowed, motionAllowed, loading, onChange }: {
  motion: boolean; object: boolean; classes: string[]; allowed: string[]; motionAllowed: boolean; loading: boolean;
  onChange: (value: { motionNoticeEnabled: boolean; objectNoticeEnabled: boolean; objectNoticeClasses: string[] }) => void;
}) {
  const enabled = motion || object;
  const mode = motion && object ? 'both' : object ? 'object' : 'motion';
  const changeMode = (value: string) => onChange({
    motionNoticeEnabled: value !== 'object', objectNoticeEnabled: value !== 'motion', objectNoticeClasses: classes,
  });
  return <section className="space-y-3 rounded-lg border border-border p-3" aria-label="Avisos na tela">
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-[13px] font-medium">Avisar na tela</p>
        <p className="text-xs text-muted-foreground">Funciona mesmo sem gravação. Não inicia gravação nem envia mensagens.</p></div>
      <Switch aria-label="Avisar na tela" checked={enabled} disabled={!enabled && (loading || (!motionAllowed && !allowed.length))}
        onCheckedChange={value => onChange({ motionNoticeEnabled: value && motionAllowed, objectNoticeEnabled: value && !motionAllowed && !!allowed.length, objectNoticeClasses: classes })} />
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
            onClick={() => onChange({ motionNoticeEnabled: motion, objectNoticeEnabled: object, objectNoticeClasses: alternarClasse(classes, c.valor) })}
            className={`min-h-10 rounded-md border px-3 text-xs ${classes.includes(c.valor) ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent'}`}>{c.rotulo}</button>)}</div>
      </div>}
    </>}
    {!loading && !allowed.length && <p className="text-xs text-muted-foreground">Detecção de pessoas e veículos não disponível neste plano.</p>}
  </section>;
}
