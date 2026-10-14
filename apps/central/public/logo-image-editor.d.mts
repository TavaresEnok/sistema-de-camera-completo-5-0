export function imagePlacement(imageWidth: number, imageHeight: number, width: number, height: number, zoom?: number, offsetX?: number, offsetY?: number): { width: number; height: number; x: number; y: number };
export class BrandImageEditor {
  constructor(canvas: HTMLCanvasElement, onChange?: (zoom: number) => void);
  zoom: number;
  load(source: string): Promise<boolean>;
  setZoom(zoom: number): void;
  setShape(shape: 'original' | 'square'): void;
  reset(): void;
  exportDataUrl(): string;
  destroy(): void;
}
