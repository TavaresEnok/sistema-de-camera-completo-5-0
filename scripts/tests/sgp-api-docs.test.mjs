import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-sgp-api-docs.mjs', root))]);
const source = JSON.parse(readFileSync(new URL('docs/integrations/sgp.openapi.json', root)));
const contract = JSON.parse(readFileSync(new URL('infra/gateway/landing/dist/developers/sgp/openapi.json', root)));
const html = readFileSync(new URL('infra/gateway/landing/dist/developers/sgp/index.html', root), 'utf8');

test('official contract preserves the real API schemas and endpoints', () => {
  assert.deepEqual(contract.paths, source.paths);
  assert.deepEqual(contract.components, source.components);
  assert.deepEqual(contract.security, source.security);
  assert.equal(contract.info.version, source.info.version);
});
test('one connector uses a configurable installation hostname and central documentation', () => {
  assert.equal(contract.servers[0].url, 'https://{installationDomain}/api');
  assert.ok(contract.servers[0].variables.installationDomain);
  assert.equal(contract.externalDocs.url, 'https://s2cam.com.br/developers/sgp');
  assert.match(html, /uma única vez/);
  assert.match(html, /não é um gateway central de eventos/);
  assert.match(html, /https:\/\/ibtelecom.s2cam.com.br\/api\/integrations\/v1\/sgp/);
});
test('public documentation has canonical URL, mobile viewport and no real integration key', () => {
  assert.match(html, /rel="canonical" href="https:\/\/s2cam.com.br\/developers\/sgp"/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /\/developers\/sgp\/openapi.json/);
  assert.doesNotMatch(html, /s2sgp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);
  assert.equal(html, readFileSync(new URL('docs/integrations/sgp.html', root), 'utf8'));
});
