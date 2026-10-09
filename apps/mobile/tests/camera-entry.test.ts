import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync('src/components/AddCameraSheet.tsx', 'utf8');
const home = source.slice(source.indexOf('function HomeStep('), source.indexOf('function DetailsStep('));

test('entrada do cadastro apresenta cadastrar e gerar link como primeiras opções', () => {
  const first = home.indexOf('>Cadastrar câmera</Text>');
  const second = home.indexOf('title="Gerar link para câmera"');
  const search = home.indexOf('title="Procurar no meu Wi-Fi"');
  const qr = home.indexOf('title="Ler QR Code"');
  assert(first >= 0 && second > first && search > second && qr > search);
  assert(!home.includes('Tenho o endereço da câmera'));
  assert(!home.includes('Receber o envio da câmera'));
  assert(home.includes('onPress={onRemote}'));
  assert(source.includes("setSourceMode('rtmp_push')"));
});

test('guia de conexão Wi-Fi removido sem eliminar descoberta da rede', () => {
  assert(!source.includes('onProvision') && !source.includes("'provision'"));
  assert(!source.includes('Preciso conectar ao Wi-Fi'));
  assert(source.includes('discoverCameras') && source.includes('scanLocalNetwork'));
  assert(home.includes('onPress={onDiscover}'));
  assert(home.includes('onPress={onQr}'));
});

test('topo usa título curto, alinhamento central e ícones que não encolhem', () => {
  assert(home.includes('>Adicione sua câmera</Text>'));
  assert(home.includes('styles.homeTitle') && home.includes('styles.homeSubtitle'));
  assert(!home.includes('Vamos conectar sua câmera'));
  assert(source.includes("homeHero: { alignItems: 'center'"));
  assert(source.includes('numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}'));
  assert(source.includes('methodCopy: { flex: 1, minWidth: 0, flexShrink: 1 }'));
  assert(source.includes('headerBtn: { width: 44, height: 44, flexShrink: 0'));
});
