import { request } from './api';
import type { Camera, Session } from '../types';

export async function loadCameraList(session: Session): Promise<Camera[]> {
  const items = new Map<string, Camera>();
  let offset = 0;
  while (true) {
    const page = await request<Camera[] | { items: Camera[]; total: number }>(session.apiUrl, `/cameras?view=mobile&limit=100&offset=${offset}`, session.token);
    // Instalações anteriores ignoram os novos parâmetros e devolvem array.
    if (Array.isArray(page)) return page;
    for (const camera of page.items) items.set(camera.id, camera);
    offset += page.items.length;
    if (!page.items.length || offset >= page.total) return Array.from(items.values());
  }
}
