import { Buffer } from 'buffer';
import NetInfo from '@react-native-community/netinfo';
import TcpSocket from 'react-native-tcp-socket';
import dgram from 'react-native-udp';
import Zeroconf from 'react-native-zeroconf';
import {
  localScanHosts, mergeDiscoveredCameras, parseOnvifDiscoveryResponse,
  parseSsdpDiscoveryResponse, type DiscoveredCamera,
} from './camera-discovery-core';

const ONVIF_ADDRESS = '239.255.255.250';
const ONVIF_PORT = 3702;
const DISCOVERY_MS = 6_000;
const SCAN_PORTS = [554, 5540, 8554, 10554, 5544, 80, 443, 8080, 8000, 8899, 37777] as const;
const SCAN_SOCKET_MS = 600;
const SCAN_WORKERS = 6;

function uuid() {
  return `urn:uuid:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function onvifProbe() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header><w:MessageID>${uuid()}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

function discoverOnvif(timeoutMs: number): Promise<DiscoveredCamera[]> {
  return new Promise((resolve, reject) => {
    const found: DiscoveredCamera[] = [];
    const socket = dgram.createSocket({ type: 'udp4', reusePort: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* socket may already be closed */ }
      if (error && found.length === 0) reject(error);
      else resolve(mergeDiscoveredCameras(found));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('message', (message: Buffer) => {
      found.push(...parseOnvifDiscoveryResponse(message.toString('utf8')));
    });
    socket.on('error', (error: Error) => {
      clearTimeout(timer);
      finish(error);
    });
    socket.bind(0, () => {
      const payload = Buffer.from(onvifProbe(), 'utf8');
      socket.send(payload, 0, payload.length, ONVIF_PORT, ONVIF_ADDRESS, (error?: Error) => {
        if (error) {
          clearTimeout(timer);
          finish(error);
        }
      });
    });
  });
}

function discoverSsdp(timeoutMs: number): Promise<DiscoveredCamera[]> {
  return new Promise((resolve, reject) => {
    const found: DiscoveredCamera[] = [];
    const socket = dgram.createSocket({ type: 'udp4', reusePort: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* noop */ }
      if (error && found.length === 0) reject(error);
      else resolve(mergeDiscoveredCameras(found));
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('message', (message: Buffer) => found.push(...parseSsdpDiscoveryResponse(message.toString('utf8'))));
    socket.on('error', (error: Error) => { clearTimeout(timer); finish(error); });
    socket.bind(0, () => {
      const payload = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n', 'utf8');
      socket.send(payload, 0, payload.length, 1900, '239.255.255.250', (error?: Error) => {
        if (error) { clearTimeout(timer); finish(error); }
      });
    });
  });
}

interface ZeroService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  fullName?: string;
}

function discoverMdns(type: 'rtsp' | 'http' | 'onvif', timeoutMs: number): Promise<DiscoveredCamera[]> {
  return new Promise((resolve) => {
    const zeroconf = new Zeroconf();
    const found: DiscoveredCamera[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { zeroconf.stop(); } catch { /* noop */ }
      zeroconf.removeDeviceListeners();
      resolve(found);
    };
    zeroconf.on('resolved', (service: ZeroService) => {
      const ip = service.addresses?.find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
      if (!ip) return;
      found.push({
        id: `mdns:${type}:${ip}`,
        name: service.name?.trim() || `Câmera ${ip}`,
        ip,
        port: typeof service.port === 'number' ? service.port : null,
        rtspPort: type === 'rtsp' ? service.port : undefined,
        httpPort: type === 'http' ? service.port : undefined,
        onvifPort: type === 'onvif' ? service.port : undefined,
        sources: ['mdns'],
        serviceUrl: service.fullName,
      });
    });
    zeroconf.on('error', finish);
    zeroconf.scan(type, 'tcp', 'local.');
    timer = setTimeout(finish, timeoutMs);
  });
}

async function discoverMdnsServices(timeoutMs: number) {
  const slice = Math.max(1_200, Math.floor(timeoutMs / 3));
  const found: DiscoveredCamera[] = [];
  // NSD/Bonjour mantém uma única busca nativa por vez; buscas concorrentes se
  // cancelam em alguns Androids. Sequencial é mais previsível e cabe no mesmo prazo.
  for (const type of ['rtsp', 'http', 'onvif'] as const) {
    found.push(...await discoverMdns(type, slice));
  }
  return found;
}

export interface DiscoveryResult {
  devices: DiscoveredCamera[];
  warnings: string[];
}

function probeTcp(host: string, port: number, timeoutMs = SCAN_SOCKET_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: ReturnType<typeof TcpSocket.createConnection> | null = null;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* conexão já encerrada */ }
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = TcpSocket.createConnection({ host, port }, () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export interface ScanProgress {
  checked: number;
  total: number;
  found: number;
}

/**
 * Fallback explícito para equipamentos que não anunciam ONVIF/mDNS/SSDP.
 * Limita-se ao /24 privado do telefone e só verifica portas conhecidas.
 * Porta aberta é tratada como candidato, nunca como câmera autenticada.
 */
export async function scanLocalNetwork(
  onProgress?: (progress: ScanProgress) => void,
): Promise<DiscoveryResult> {
  const state = await NetInfo.fetch();
  const details = state.details as { ipAddress?: string | null; subnet?: string | null } | null;
  const phoneIp = details?.ipAddress?.trim();
  if (!state.isConnected || (state.type !== 'wifi' && state.type !== 'ethernet') || !phoneIp) {
    return { devices: [], warnings: ['Conecte o telefone ao Wi-Fi da câmera para fazer a busca completa.'] };
  }
  const hosts = localScanHosts(phoneIp, details?.subnet);
  if (!hosts.length) {
    return { devices: [], warnings: ['A busca completa só funciona em uma rede local privada.'] };
  }

  const found: DiscoveredCamera[] = [];
  let cursor = 0;
  let checked = 0;
  const worker = async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++];
      const results = await Promise.all(SCAN_PORTS.map(async (port) => ({ port, open: await probeTcp(host, port) })));
      const openPorts = results.filter((result) => result.open).map((result) => result.port);
      if (openPorts.length) {
        const preferredPort = openPorts.includes(554) ? 554 : openPorts.includes(8554) ? 8554 : openPorts[0];
        found.push({
          id: `scan:${host}`,
          name: `Possível câmera ${host}`,
          ip: host,
          port: preferredPort,
          sources: ['scan'],
          openPorts,
        });
      }
      checked += 1;
      onProgress?.({ checked, total: hosts.length, found: found.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_WORKERS, hosts.length) }, () => worker()));
  return { devices: mergeDiscoveredCameras(found), warnings: [] };
}

/** Busca no telefone, dentro da mesma rede Wi-Fi. Nunca envia credenciais. */
export async function discoverCameras(timeoutMs = DISCOVERY_MS): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const tasks = [
    discoverOnvif(timeoutMs).catch((error) => {
      warnings.push(`ONVIF: ${error instanceof Error ? error.message : 'busca indisponível'}`);
      return [];
    }),
    discoverSsdp(timeoutMs).catch((error) => {
      warnings.push(`SSDP: ${error instanceof Error ? error.message : 'busca indisponível'}`);
      return [];
    }),
    discoverMdnsServices(timeoutMs).catch((error) => {
      warnings.push(`mDNS: ${error instanceof Error ? error.message : 'busca indisponível'}`);
      return [];
    }),
  ];
  const batches = await Promise.all(tasks);
  return { devices: mergeDiscoveredCameras(batches.flat()), warnings };
}
