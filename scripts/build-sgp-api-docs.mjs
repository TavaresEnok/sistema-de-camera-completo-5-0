import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Generate the official portal from the actual published API contract, rather
// than maintaining a second implementation of its schemas and endpoints.
const contractIndex = process.argv.indexOf('--contract');
if (contractIndex >= 0 && !process.argv[contractIndex + 1]) throw new Error('Use --contract PATH_TO_EXPORTED_OPENAPI_JSON');
const contractPath = contractIndex >= 0 ? process.argv[contractIndex + 1] : new URL('../docs/integrations/sgp.openapi.json', import.meta.url);
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
if (contract.openapi !== '3.0.3' || !/^1\.\d+\.\d+$/.test(contract.info?.version ?? '')
    || !contract.paths?.['/integrations/v1/sgp/webhook']?.post
    || !contract.paths?.['/integrations/v1/sgp/customers/{externalId}']?.delete
    || !contract.paths?.['/integrations/v1/sgp/operations/{id}']?.get) {
  throw new Error('The exported contract does not match a supported S2Cam SGP API v1 contract');
}
// The API itself exports the configurable server and central documentation URL.
// Preserve its contract byte-for-byte apart from JSON formatting.
if (contract.servers?.[0]?.url !== 'https://{installationDomain}/api'
    || contract.externalDocs?.url !== 'https://s2cam.com.br/developers/sgp') throw new Error('Invalid installation server or documentation URL');
const output = new URL('../infra/gateway/landing/dist/developers/sgp/', import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL('../docs/integrations/sgp.html', import.meta.url), new URL('index.html', output));
await writeFile(new URL('openapi.json', output), JSON.stringify(contract, null, 2) + '\n');
console.log(fileURLToPath(output));
