/** Sanitiza o cache sem proprietário; só chamar após confirmação explícita. */
export function recoverLegacyLayoutData(raw: string, allowedCameraIds: Set<string>) {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Formato de layouts inválido');
  return parsed.slice(0, 100).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const layout = item as Record<string, unknown>;
    if (typeof layout.name !== 'string' || !layout.name.trim()
      || typeof layout.gridSize !== 'string' || !/^[1-8]x[1-8]$/.test(layout.gridSize)
      || !Array.isArray(layout.cameraIds)) return [];
    const [rows, columns] = layout.gridSize.split('x').map(Number);
    return [{ name: layout.name.trim().slice(0, 80), gridSize: layout.gridSize,
      cameraIds: layout.cameraIds.slice(0, rows * columns).map((id: unknown) =>
        typeof id === 'string' && allowedCameraIds.has(id) ? id : '') }];
  });
}
