export type DiscoverySource = 'onvif' | 'mdns' | 'ssdp' | 'scan';

export interface DiscoveredCamera {
  id: string;
  name: string;
  ip: string;
  port: number | null;
  rtspPort?: number;
  httpPort?: number;
  onvifPort?: number;
  sources: DiscoverySource[];
  serviceUrl?: string;
  manufacturerHint?: string;
  /** Portas que responderam durante a busca completa; ainda exige validação RTSP. */
  openPorts?: number[];
}

function ipv4Octets(value: string): number[] | null {
  const parts = value.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function isPrivateIpv4(value: string): boolean {
  const parts = ipv4Octets(value);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Gera no máximo um /24 ao redor do telefone. Mesmo que a rede anuncie /16,
 * o app nunca varre milhares de endereços nem sai da rede privada local.
 */
export function localScanHosts(phoneIp: string, subnet?: string | null, maxHosts = 253): string[] {
  const ip = ipv4Octets(phoneIp);
  if (!ip || !isPrivateIpv4(phoneIp)) return [];
  const mask = subnet ? ipv4Octets(subnet) : null;
  const prefix = ip.map((part, index) => part & (mask?.[index] ?? (index < 3 ? 255 : 0)));
  // Redes mais amplas são deliberadamente reduzidas ao /24 atual.
  prefix[0] = ip[0]; prefix[1] = ip[1]; prefix[2] = ip[2]; prefix[3] = 0;
  const result: string[] = [];
  for (let host = 1; host <= 254 && result.length < Math.max(0, Math.min(maxHosts, 253)); host += 1) {
    const candidate = `${prefix[0]}.${prefix[1]}.${prefix[2]}.${host}`;
    if (candidate !== phoneIp) result.push(candidate);
  }
  return result;
}

export interface CameraQrData {
  kind: 'camera' | 'wifi' | 'unknown';
  ip?: string;
  port?: number;
  username?: string;
  password?: string;
  rtspPath?: string;
  name?: string;
  ssid?: string;
  raw: string;
  message?: string;
}

const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/;

function decoded(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parsePort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function cameraFromObject(raw: string, value: Record<string, unknown>): CameraQrData | null {
  const address = String(value.ip ?? value.host ?? value.address ?? '').trim();
  const match = address.match(IPV4);
  if (!match) return null;
  return {
    kind: 'camera',
    raw,
    ip: match[0],
    port: parsePort(value.rtspPort ?? value.port),
    username: typeof value.username === 'string' ? value.username : undefined,
    password: typeof value.password === 'string' ? value.password : undefined,
    rtspPath: typeof value.rtspPath === 'string' ? value.rtspPath : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
  };
}

/** Interpreta somente formatos seguros e conhecidos; QR proprietário não é "adivinhado". */
export function parseCameraQr(rawValue: string): CameraQrData {
  const raw = rawValue.trim();
  if (!raw) return { kind: 'unknown', raw, message: 'O QR Code está vazio.' };

  if (/^WIFI:/i.test(raw)) {
    const ssid = raw.match(/(?:^|;)S:((?:\\.|[^;])*)/i)?.[1]?.replace(/\\;/g, ';');
    return {
      kind: 'wifi',
      raw,
      ssid,
      message: 'Este é o QR da rede Wi-Fi, não o identificador da câmera. Leia o QR da etiqueta do equipamento.',
    };
  }

  if (raw.startsWith('{')) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      const parsed = cameraFromObject(raw, value);
      if (parsed) return parsed;
    } catch {
      // Continua para os formatos textuais.
    }
  }

  if (/^rtsp:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const ip = url.hostname.match(IPV4)?.[0];
      if (ip) {
        return {
          kind: 'camera', raw, ip,
          port: parsePort(url.port) ?? 554,
          username: url.username ? decoded(url.username) : undefined,
          password: url.password ? decoded(url.password) : undefined,
          rtspPath: `${url.pathname || ''}${url.search || ''}` || undefined,
        };
      }
    } catch {
      // URL inválida cai no retorno desconhecido.
    }
  }

  const ip = raw.match(IPV4)?.[0];
  if (ip) {
    const suffix = raw.slice((raw.indexOf(ip) + ip.length));
    const port = suffix.match(/^:(\d{1,5})/)?.[1];
    return { kind: 'camera', raw, ip, port: parsePort(port) };
  }

  return {
    kind: 'unknown', raw,
    message: 'QR proprietário identificado. Este modelo precisa de um driver compatível ou do primeiro pareamento no app do fabricante.',
  };
}

function xmlValues(xml: string, localName: string): string[] {
  const expression = new RegExp(`<(?:[\\w-]+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localName}>`, 'gi');
  return Array.from(xml.matchAll(expression), (match) => match[1].trim()).filter(Boolean);
}

function manufacturerFromText(value: string): string | undefined {
  const lower = value.toLowerCase();
  if (lower.includes('intelbras')) return 'Intelbras';
  if (lower.includes('dahua')) return 'Dahua';
  if (lower.includes('hikvision')) return 'Hikvision';
  if (lower.includes('xmeye') || lower.includes('xiongmai')) return 'Xiongmai';
  if (lower.includes('vivotek')) return 'Vivotek';
  if (lower.includes('axis')) return 'Axis';
  return undefined;
}

export function parseOnvifDiscoveryResponse(xml: string): DiscoveredCamera[] {
  const urls = xmlValues(xml, 'XAddrs').flatMap((line) => line.split(/\s+/));
  const scopes = xmlValues(xml, 'Scopes').join(' ');
  const nameScope = scopes.match(/(?:name|hardware)\/([^\s/]+)/i)?.[1];
  const manufacturerHint = manufacturerFromText(`${scopes} ${urls.join(' ')}`);
  const byIp = new Map<string, DiscoveredCamera>();

  for (const serviceUrl of urls) {
    const ip = serviceUrl.match(IPV4)?.[0];
    if (!ip) continue;
    let port: number | null = null;
    try { port = parsePort(new URL(serviceUrl).port) ?? (serviceUrl.startsWith('https:') ? 443 : 80); } catch { /* noop */ }
    byIp.set(ip, {
      id: `onvif:${ip}`,
      ip,
      port,
      onvifPort: port ?? undefined,
      sources: ['onvif'],
      serviceUrl,
      manufacturerHint,
      name: decoded(nameScope ?? manufacturerHint ?? `Câmera ${ip}`),
    });
  }
  return Array.from(byIp.values());
}

export function parseSsdpDiscoveryResponse(response: string): DiscoveredCamera[] {
  const headers = new Map<string, string>();
  for (const line of response.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const location = headers.get('location') ?? '';
  const fingerprint = `${headers.get('server') ?? ''} ${headers.get('st') ?? ''} ${headers.get('usn') ?? ''} ${location}`;
  // ssdp:all também devolve TV, roteador e impressora. Só promove respostas
  // com indício de vídeo/segurança para não oferecer um dispositivo errado.
  if (!/(camera|ipcam|onvif|networkvideo|dvr|nvr|hikvision|dahua|intelbras|xmeye|xiongmai)/i.test(fingerprint)) return [];
  const ip = location.match(IPV4)?.[0] ?? response.match(IPV4)?.[0];
  if (!ip) return [];
  let port: number | null = null;
  try { port = parsePort(new URL(location).port) ?? (location.startsWith('https:') ? 443 : 80); } catch { /* noop */ }
  const manufacturerHint = manufacturerFromText(fingerprint);
  return [{
    id: `ssdp:${ip}`, ip, port, httpPort: port ?? undefined, sources: ['ssdp'], serviceUrl: location || undefined,
    manufacturerHint, name: manufacturerHint ? `${manufacturerHint} ${ip}` : `Câmera ${ip}`,
  }];
}

export function mergeDiscoveredCameras(devices: DiscoveredCamera[]): DiscoveredCamera[] {
  const merged = new Map<string, DiscoveredCamera>();
  for (const item of devices) {
    const current = merged.get(item.ip);
    if (!current) {
      merged.set(item.ip, { ...item, sources: [...item.sources] });
      continue;
    }
    merged.set(item.ip, {
      ...current,
      ...item,
      id: current.id,
      name: /^(Câmera|Possível câmera) /.test(current.name) ? item.name : current.name,
      port: current.port ?? item.port,
      rtspPort: current.rtspPort ?? item.rtspPort,
      httpPort: current.httpPort ?? item.httpPort,
      onvifPort: current.onvifPort ?? item.onvifPort,
      serviceUrl: current.serviceUrl ?? item.serviceUrl,
      manufacturerHint: current.manufacturerHint ?? item.manufacturerHint,
      openPorts: Array.from(new Set([...(current.openPorts ?? []), ...(item.openPorts ?? [])])).sort((a, b) => a - b),
      sources: Array.from(new Set([...current.sources, ...item.sources])),
    });
  }
  return Array.from(merged.values()).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/** Discovery reports service types; TCP scan alone cannot identify a video port. */
export function discoveredCameraPorts(device: DiscoveredCamera) {
  const knownRtsp = device.rtspPort ?? (/^rtsp:\/\//i.test(device.serviceUrl ?? '') ? device.port : undefined);
  const control = device.onvifPort ?? device.httpPort
    ?? (/^https?:\/\//i.test(device.serviceUrl ?? '') || device.sources.includes('onvif') || device.sources.includes('ssdp') ? device.port : undefined);
  return {
    rtspPort: String(knownRtsp || 554),
    httpPort: String(device.httpPort || control || 80),
    onvifPort: device.onvifPort ? String(device.onvifPort) : '',
    automatic: !knownRtsp,
  };
}
