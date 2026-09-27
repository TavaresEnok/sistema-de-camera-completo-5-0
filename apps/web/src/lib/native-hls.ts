/** Native HLS cannot send Authorization on its child playlists/segments. */
export function nativeHlsUrl(url: string, pageUrl: string): URL {
  const page = new URL(pageUrl);
  const target = new URL(url, page);
  if (target.origin !== page.origin || !/^\/hls\/cam_[a-zA-Z0-9_-]+\//.test(target.pathname)
    || (page.protocol !== 'https:' && page.hostname !== 'localhost')) {
    throw new Error('Para reproduzir neste navegador, abra o endereço seguro da instalação.');
  }
  target.searchParams.delete('token');
  return target;
}

export async function prepareNativeHls(url: string, token: string, pageUrl: string, signal: AbortSignal): Promise<string> {
  const target = nativeHlsUrl(url, pageUrl);
  const authenticated = new URL(target);
  authenticated.searchParams.set('token', token);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 8000);
  try {
    const response = await fetch(authenticated, {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error('Não foi possível autorizar a reprodução. Tente novamente.');
    if (response.headers.get('x-s2cam-hls-session') !== 'camera') {
      await response.body?.cancel();
      throw new Error('A reprodução neste navegador precisa de uma atualização da instalação.');
    }
    // O proxy grava um cookie HttpOnly limitado ao caminho DESTA câmera.
    await response.body?.cancel();
    return target.toString();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
