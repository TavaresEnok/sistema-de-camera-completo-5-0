import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoveredCameraPorts, isPrivateIpv4, localScanHosts, mergeDiscoveredCameras, parseCameraQr,
  parseOnvifDiscoveryResponse, parseSsdpDiscoveryResponse,
} from '../src/services/camera-discovery-core';

test('interpreta QR RTSP sem perder credenciais e caminho', () => {
  const parsed = parseCameraQr('rtsp://admin:sen%40ha@192.168.1.44:8554/cam/realmonitor?channel=1&subtype=0');
  assert.equal(parsed.kind, 'camera');
  assert.equal(parsed.ip, '192.168.1.44');
  assert.equal(parsed.port, 8554);
  assert.equal(parsed.username, 'admin');
  assert.equal(parsed.password, 'sen@ha');
  assert.equal(parsed.rtspPath, '/cam/realmonitor?channel=1&subtype=0');
});

test('não confunde QR de Wi-Fi com QR da câmera', () => {
  const parsed = parseCameraQr('WIFI:T:WPA;S:Casa;P:segredo;;');
  assert.equal(parsed.kind, 'wifi');
  assert.equal(parsed.ssid, 'Casa');
  assert.match(parsed.message ?? '', /rede Wi-Fi/);
});

test('extrai dispositivos de uma resposta WS-Discovery ONVIF', () => {
  const xml = `
    <e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope">
      <e:Body><d:ProbeMatches><d:ProbeMatch>
        <d:Scopes>onvif://www.onvif.org/name/Portao onvif://www.onvif.org/hardware/Intelbras</d:Scopes>
        <d:XAddrs>http://192.168.0.18:8080/onvif/device_service</d:XAddrs>
      </d:ProbeMatch></d:ProbeMatches></e:Body>
    </e:Envelope>`;
  const devices = parseOnvifDiscoveryResponse(xml);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].ip, '192.168.0.18');
  assert.equal(devices[0].port, 8080);
  assert.equal(devices[0].onvifPort, 8080);
  assert.equal(devices[0].name, 'Portao');
  assert.equal(devices[0].manufacturerHint, 'Intelbras');
});

test('nonstandard mDNS RTSP port is not put in the HTTP field', () => {
  assert.deepEqual(discoveredCameraPorts({ id: 'x', name: 'Camera', ip: '192.168.1.8', port: 5540, rtspPort: 5540, sources: ['mdns'] }),
    { rtspPort: '5540', httpPort: '80', onvifPort: '', automatic: false });
});

test('ONVIF control port does not force manual RTSP 554; server discovers actual video port', () => {
  assert.deepEqual(discoveredCameraPorts({ id: 'x', name: 'Camera', ip: '192.168.1.8', port: 8000, onvifPort: 8000, sources: ['onvif'] }),
    { rtspPort: '554', httpPort: '8000', onvifPort: '8000', automatic: true });
});

test('merged announcements retain separate RTSP and ONVIF ports', () => {
  const device = mergeDiscoveredCameras([
    { id: 'o', name: 'Entrance', ip: '192.168.1.8', port: 8000, onvifPort: 8000, sources: ['onvif'] },
    { id: 'r', name: 'Camera', ip: '192.168.1.8', port: 12345, rtspPort: 12345, sources: ['mdns'] },
  ])[0];
  assert.deepEqual(discoveredCameraPorts(device), { rtspPort: '12345', httpPort: '8000', onvifPort: '8000', automatic: false });
});

test('scan TCP candidate requires protocol verification instead of guessing HTTP as RTSP', () => {
  assert.equal(discoveredCameraPorts({ id: 's', name: 'Candidate', ip: '192.168.1.8', port: 8000, openPorts: [8000], sources: ['scan'] }).automatic, true);
});

test('mescla ONVIF e mDNS da mesma câmera', () => {
  const devices = mergeDiscoveredCameras([
    { id: 'a', name: 'Câmera 10.0.0.2', ip: '10.0.0.2', port: 80, sources: ['onvif'] },
    { id: 'b', name: 'Entrada', ip: '10.0.0.2', port: 554, sources: ['mdns'] },
  ]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Entrada');
  assert.deepEqual(devices[0].sources, ['onvif', 'mdns']);
});

test('SSDP aceita câmera e ignora roteador genérico', () => {
  const camera = parseSsdpDiscoveryResponse('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.9:80/device.xml\r\nSERVER: Intelbras IP Camera\r\nST: upnp:rootdevice\r\n\r\n');
  const router = parseSsdpDiscoveryResponse('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1/root.xml\r\nSERVER: RouterOS UPnP\r\nST: upnp:rootdevice\r\n\r\n');
  assert.equal(camera[0]?.ip, '192.168.1.9');
  assert.equal(camera[0]?.manufacturerHint, 'Intelbras');
  assert.equal(router.length, 0);
});

test('busca ativa só enumera o /24 privado local e exclui o telefone', () => {
  const hosts = localScanHosts('192.168.50.24', '255.255.0.0');
  assert.equal(hosts.length, 253);
  assert.equal(hosts[0], '192.168.50.1');
  assert.equal(hosts.at(-1), '192.168.50.254');
  assert.equal(hosts.includes('192.168.50.24'), false);
  assert.equal(hosts.some((host) => host.startsWith('192.168.51.')), false);
});

test('busca ativa recusa IP público e respeita limite', () => {
  assert.equal(isPrivateIpv4('172.16.0.1'), true);
  assert.equal(isPrivateIpv4('172.32.0.1'), false);
  assert.deepEqual(localScanHosts('8.8.8.8', '255.255.255.0'), []);
  assert.equal(localScanHosts('10.0.0.7', null, 4).length, 4);
});

test('mescla candidato da varredura com descoberta ONVIF sem duplicar câmera', () => {
  const devices = mergeDiscoveredCameras([
    { id: 'scan:192.168.1.10', name: 'Possível câmera 192.168.1.10', ip: '192.168.1.10', port: 554, sources: ['scan'], openPorts: [80, 554] },
    { id: 'onvif:192.168.1.10', name: 'Entrada', ip: '192.168.1.10', port: 80, sources: ['onvif'], manufacturerHint: 'Intelbras' },
  ]);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Entrada');
  assert.deepEqual(devices[0].sources, ['scan', 'onvif']);
  assert.deepEqual(devices[0].openPorts, [80, 554]);
});
