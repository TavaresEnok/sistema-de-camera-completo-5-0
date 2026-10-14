import { useEffect, useRef, useState } from 'react';
import { BrandImageEditor } from '../../../central/public/logo-image-editor.mjs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';

export function BrandLogoEditor({ source, onApply, onClose }: { source: string | null; onApply: (image: string) => void; onClose: () => void }) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const editor = useRef<BrandImageEditor | null>(null);
  const [zoom, setZoom] = useState(1), [ready, setReady] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!source || !canvas) return;
    let cancelled = false; setReady(false); setError('');
    const instance = new BrandImageEditor(canvas, setZoom); editor.current = instance;
    void instance.load(source).then(loaded => { if (!cancelled) setReady(loaded); }).catch(() => { if (!cancelled) setError('Não foi possível abrir a imagem. Escolha outro arquivo.'); });
    return () => { cancelled = true; instance.destroy(); editor.current = null; };
  }, [source, canvas]);
  const apply = () => { try { const image = editor.current?.exportDataUrl(); if (image) onApply(image); } catch { setError('Não foi possível preparar a imagem. Tente outra imagem.'); } };
  return <Dialog open={Boolean(source)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-24px)] max-w-lg flex-col overflow-hidden">
      <DialogHeader className="shrink-0 pr-6"><DialogTitle>Ajustar logo</DialogTitle><DialogDescription>Arraste a imagem e ajuste o zoom até ficar como você quer.</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 p-2">
          <canvas ref={setCanvas} width="768" height="768" tabIndex={0} aria-label="Logo: arraste para reposicionar. Use as setas ou ajuste o zoom." className="max-h-[35dvh] max-w-full cursor-grab touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" style={{ width: 'auto', height: 'auto', background: 'repeating-conic-gradient(#d5d5d5 0% 25%, #fff 0% 50%) 50% / 16px 16px' }} />
        </div>
        {!ready && !error && <p className="text-sm text-muted-foreground">Carregando imagem…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <label className="flex items-center gap-3 text-sm">Zoom<input aria-label="Zoom da logo" type="range" min="0.1" max="6" step="0.01" value={zoom} disabled={!ready} onChange={e => editor.current?.setZoom(Number(e.target.value))} className="min-w-0 flex-1" /><span>{Math.round(zoom * 100)}%</span></label>
        <div className="flex flex-wrap items-center gap-3 text-sm"><label>Formato <select aria-label="Formato da logo" defaultValue="original" disabled={!ready} onChange={e => editor.current?.setShape(e.target.value as 'original' | 'square')} className="rounded border bg-background p-2"><option value="original">Original</option><option value="square">Quadrado</option></select></label><Button type="button" variant="outline" disabled={!ready} onClick={() => editor.current?.reset()}>Centralizar</Button></div>
      </div>
      <div className="flex shrink-0 justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="button" disabled={!ready} onClick={apply}>Aplicar imagem</Button></div>
    </DialogContent>
  </Dialog>;
}
