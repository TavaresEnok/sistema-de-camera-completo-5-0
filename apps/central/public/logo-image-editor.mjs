export function imagePlacement(imageWidth, imageHeight, width, height, zoom = 1, offsetX = 0, offsetY = 0) {
  const fit = Math.min(width / imageWidth, height / imageHeight);
  const scale = fit * Math.max(0.1, Math.min(6, zoom));
  return { width: imageWidth * scale, height: imageHeight * scale, x: (width - imageWidth * scale) / 2 + offsetX, y: (height - imageHeight * scale) / 2 + offsetY };
}

/** Browser-local only. No uploads, saves or build requests. */
export class BrandImageEditor {
  constructor(canvas, onChange = () => {}) {
    this.canvas = canvas; this.onChange = onChange; this.image = null; this.zoom = 1;
    this.offsetX = 0; this.offsetY = 0; this.shape = 'original'; this.generation = 0; this.pointer = null;
    this.handlers = {
      pointerdown: e => { if (!this.image) return; e.preventDefault(); canvas.setPointerCapture(e.pointerId); this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY }; },
      pointermove: e => {
        if (!this.pointer || this.pointer.id !== e.pointerId) return;
        const rect = canvas.getBoundingClientRect();
        this.offsetX += (e.clientX - this.pointer.x) * canvas.width / Math.max(1, rect.width);
        this.offsetY += (e.clientY - this.pointer.y) * canvas.height / Math.max(1, rect.height);
        this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.draw();
      },
      pointerup: () => { this.pointer = null; }, pointercancel: () => { this.pointer = null; },
      wheel: e => { if (!this.image) return; e.preventDefault(); this.setZoom(this.zoom * (e.deltaY > 0 ? 0.94 : 1.06)); },
      keydown: e => {
        if (!this.image) return;
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(e.key)) return;
        e.preventDefault();
        if (e.key === 'Home') { this.reset(); return; }
        if (e.key === '+' || e.key === '=') { this.setZoom(this.zoom * 1.1); return; }
        if (e.key === '-') { this.setZoom(this.zoom / 1.1); return; }
        this.offsetX += e.key === 'ArrowLeft' ? -10 : e.key === 'ArrowRight' ? 10 : 0;
        this.offsetY += e.key === 'ArrowUp' ? -10 : e.key === 'ArrowDown' ? 10 : 0; this.draw();
      },
    };
    for (const [name, fn] of Object.entries(this.handlers)) canvas.addEventListener(name, fn, { passive: false });
  }
  async load(source) {
    if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/i.test(source)) throw Error('Escolha uma imagem PNG, JPG, WebP ou SVG.');
    const generation = ++this.generation, image = new Image();
    image.src = source; await image.decode();
    if (generation !== this.generation) return false;
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_000_000) throw Error('Escolha uma imagem com resolução menor.');
    this.image = image; this.resize(); this.reset(); return true;
  }
  resize() {
    if (!this.image) return;
    const fit = 768 / Math.max(this.image.naturalWidth, this.image.naturalHeight);
    this.canvas.width = this.shape === 'square' ? 768 : Math.max(1, Math.round(this.image.naturalWidth * fit));
    this.canvas.height = this.shape === 'square' ? 768 : Math.max(1, Math.round(this.image.naturalHeight * fit));
  }
  setShape(shape) { this.shape = shape === 'square' ? 'square' : 'original'; this.resize(); this.reset(); }
  setZoom(zoom) { this.zoom = Math.max(0.1, Math.min(6, Number(zoom) || 1)); this.draw(); }
  reset() { this.zoom = 1; this.offsetX = 0; this.offsetY = 0; this.draw(); }
  draw() {
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.image) {
      const p = imagePlacement(this.image.naturalWidth, this.image.naturalHeight, this.canvas.width, this.canvas.height, this.zoom, this.offsetX, this.offsetY);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high'; context.drawImage(this.image, p.x, p.y, p.width, p.height);
    }
    this.onChange(this.zoom);
  }
  exportDataUrl() {
    if (!this.image) throw Error('Aguarde a imagem carregar.');
    // PNG preserves transparency; reduce resolution rather than change format.
    for (const maximum of [768, 512, 384, 256, 128]) {
      const result = document.createElement('canvas'), scale = Math.min(1, maximum / Math.max(this.canvas.width, this.canvas.height));
      result.width = Math.max(1, Math.round(this.canvas.width * scale)); result.height = Math.max(1, Math.round(this.canvas.height * scale));
      result.getContext('2d').drawImage(this.canvas, 0, 0, result.width, result.height);
      const data = result.toDataURL('image/png');
      if (atob(data.split(',')[1]).length <= 400 * 1024) return data;
    }
    throw Error('Escolha uma imagem menor.');
  }
  destroy() { this.generation++; this.image = null; this.pointer = null; for (const [name, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(name, fn); }
}
