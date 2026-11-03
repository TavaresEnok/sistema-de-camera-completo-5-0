import { useId } from 'react';

export function AiConfidenceControl({ value, onChange, sharedWithRecording = false, label = 'Confiança mínima para confirmar o alerta' }: {
  value: number; onChange: (value: number) => void; sharedWithRecording?: boolean; label?: string;
}) {
  const id = useId();
  const confidence = Number.isFinite(value) ? Math.max(55, Math.min(90, Math.round(value))) : 70;
  return <div className="space-y-2 rounded-md border border-border bg-background/50 p-3">
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="text-xs font-medium leading-relaxed">{label}</label>
      <output htmlFor={id} className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-sm font-semibold tabular-nums text-primary">{confidence}%</output>
    </div>
    <input id={id} type="range" min={55} max={90} step={1} value={confidence}
      aria-valuetext={`${confidence}% de confiança mínima`}
      aria-describedby={`${id}-help${sharedWithRecording ? ` ${id}-shared` : ''}`}
      onChange={event => onChange(Number(event.target.value))}
      className="h-9 w-full cursor-pointer accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
    <div className="flex justify-between text-[11px] text-muted-foreground"><span>55% · Menos exigente</span><span>90% · Mais exigente</span></div>
    <p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">
      Valores menores aceitam mais detecções; valores maiores exigem mais confiança. A porcentagem não é uma taxa de acerto nem aumenta a potência da IA.
    </p>
    {sharedWithRecording && <p id={`${id}-shared`} role="note" className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
      Esta câmera grava por pessoas/objetos. O mesmo limite de confiança também é usado para confirmar essas gravações.
    </p>}
  </div>;
}
