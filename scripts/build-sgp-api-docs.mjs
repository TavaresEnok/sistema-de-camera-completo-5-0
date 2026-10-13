import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Generate the official portal from the actual published API contract, rather
// than maintaining a second implementation of its schemas and endpoints.
const contractIndex = process.argv.indexOf('--contract');
if (contractIndex >= 0 && !process.argv[contractIndex + 1]) throw new Error('Use --contract PATH_TO_EXPORTED_OPENAPI_JSON');
const contractPath = contractIndex >= 0 ? process.argv[contractIndex + 1] : new URL('../docs/integrations/sgp.openapi.json', import.meta.url);
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
if (contract.openapi !== '3.0.3' || contract.info?.version !== '1.0.0'
    || !contract.paths?.['/integrations/v1/sgp/webhook']?.post
    || !contract.paths?.['/integrations/v1/sgp/customers/{externalId}']?.delete
    || !contract.paths?.['/integrations/v1/sgp/operations/{id}']?.get) {
  throw new Error('The exported contract does not match S2Cam SGP API v1.0.0');
}
contract.info.description = 'Contrato único do conector S2Cam para o SGP, reutilizável por todos os provedores. Configure o domínio da instalação e uma chave exclusiva de integração, sem desenvolver um conector por provedor. ' + contract.info.description;
contract.externalDocs = { description: 'Documentação oficial para desenvolvimento do conector S2Cam no SGP', url: 'https://s2cam.com.br/developers/sgp' };
contract.servers = [{ url: 'https://{installationDomain}/api', description: 'Domínio S2Cam fornecido na ativação do provedor. s2cam.com.br hospeda a documentação, não recebe os eventos.', variables: { installationDomain: { default: 'vibe.s2cam.com.br', description: 'Somente o hostname da instalação, sem protocolo, caminho ou barra final. Exemplo: ibtelecom.s2cam.com.br.' } } }];
const output = new URL('../infra/gateway/landing/dist/developers/sgp/', import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(new URL('../docs/integrations/sgp.html', import.meta.url), new URL('index.html', output));
await writeFile(new URL('openapi.json', output), JSON.stringify(contract, null, 2) + '\n');
console.log(fileURLToPath(output));
