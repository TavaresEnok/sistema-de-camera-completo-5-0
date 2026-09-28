import { CalendarDays, CheckCircle2, Rocket, ShieldCheck, Sparkles } from 'lucide-react';
import { PRODUCT_UPDATES } from '../data/product-updates';

const kindStyle = {
  Novo: { icon: Rocket, cls: 'border-primary/30 bg-primary/10 text-primary' },
  Melhoria: { icon: Sparkles, cls: 'border-sky-500/30 bg-sky-500/10 text-sky-500' },
  Segurança: { icon: ShieldCheck, cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' },
};

export default function UpdatesPage() {
  return (
    <div className="h-full overflow-y-auto p-4 lg:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 rounded-2xl border border-border bg-card p-5 lg:p-7">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles className="h-5 w-5" /></div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">Novidades do sistema</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Uma visão clara do que mudou e do benefício operacional. Confira as melhorias descritas nesta lista; a disponibilidade depende dos recursos contratados.</p>
        </div>

        <div className="relative space-y-4 before:absolute before:bottom-6 before:left-5 before:top-6 before:w-px before:bg-border lg:before:left-7">
          {PRODUCT_UPDATES.map((update, index) => {
            const style = kindStyle[update.kind];
            const Icon = style.icon;
            return <article key={update.version} className="relative ml-10 rounded-xl border border-border bg-card p-4 shadow-sm lg:ml-14 lg:p-5">
              <span className={`absolute -left-[2.65rem] top-5 flex h-9 w-9 items-center justify-center rounded-full border bg-card lg:-left-[3.6rem] ${style.cls}`}><Icon className="h-4 w-4" /></span>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{update.title}</h3>{index === 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">Mais recente</span>}</div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{update.summary}</p></div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground"><CalendarDays className="h-3 w-3" />{new Date(`${update.date}T12:00:00`).toLocaleDateString('pt-BR')}<span className="font-mono">v{update.version}</span></div>
              </div>
              <div className="mt-4 grid gap-2 md:grid-cols-3">{update.items.map((item) => <div key={item} className="flex gap-2 rounded-lg border border-border/70 bg-background/50 p-2.5 text-[11px] leading-relaxed"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /><span>{item}</span></div>)}</div>
            </article>;
          })}
        </div>
      </div>
    </div>
  );
}
