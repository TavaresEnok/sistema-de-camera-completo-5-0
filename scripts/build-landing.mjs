import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Conserva o artefato original entregue pelo design em docs/.
const source = new URL('../docs/S2Cam Landing.html', import.meta.url);
const output = new URL('../infra/gateway/landing/dist/', import.meta.url);
let html = await readFile(source, 'utf8');
const templatePattern = /(<script type="__bundler\/template">\s*)([\s\S]*?)(\s*<\/script>)/;
const match = html.match(templatePattern);
if (!match) throw new Error('Template da landing não encontrado.');
let template = JSON.parse(match[2]);
const metadata = '<title>S2Cam — Videomonitoramento inteligente</title><meta name="description" content="Conheça a plataforma S2Cam de videomonitoramento, gravações e alertas."><link rel="canonical" href="https://s2cam.com.br/">';
template = template.replace('<html>', '<html lang="pt-BR">').replace('<head>', '<head>' + metadata);
// A marca anterior era só uma barra azul solta ao lado do nome. O cabeçalho é
// o primeiro contato com o produto: usamos um símbolo compacto de câmera,
// contraste correto e uma área de toque/clique mais confortável.
const headerBrand = `<a href="#topo" aria-label="S2Cam — início" style="display:flex;align-items:center;gap:11px;margin-right:auto;color:#EDF1F6;min-width:max-content" style-hover="color:#EDF1F6">
      <span aria-hidden="true" style="width:34px;height:34px;display:grid;place-items:center;background:linear-gradient(145deg,#3D8BFF,#2169D6);border-radius:10px;box-shadow:0 8px 22px rgba(61,139,255,.24)">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#06080B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="13" height="10" rx="2"></rect><path d="m16 10 5-3v10l-5-3z"></path></svg>
      </span>
      <span style="font-size:22px;font-weight:700;letter-spacing:-.035em;line-height:1">S2<span style="color:#3D8BFF">Cam</span></span>
    </a>`;
template = template.replace(
  /<a href="#topo" style="display:flex;align-items:center;gap:12px;margin-right:auto;color:#EDF1F6" style-hover="color:#EDF1F6">\s*<span style="width:9px;height:22px;background:#3D8BFF;display:block;border-radius:2px"><\/span>\s*<span style="font-size:21px;font-weight:700;letter-spacing:-\.025em;line-height:1">S2<span style="color:#3D8BFF">Cam<\/span><\/span>\s*<\/a>/,
  headerBrand,
);
template = template.replace(/<a href="#contato"([^>]*)>Acessar sistema<\/a>/g,
  '<a href="https://central.s2cam.com.br/"$1>Acessar Central</a>');
html = html.replace(templatePattern, (_, start, _template, end) => start + JSON.stringify(template).replace(/<\//g, '<\\/') + end);
html = html.replace('<html>', '<html lang="pt-BR">')
  .replace('<title>Bundled Page</title>', metadata + '<meta name="viewport" content="width=device-width, initial-scale=1">');
await mkdir(output, { recursive: true });
await writeFile(new URL('index.html', output), html);
console.log(fileURLToPath(new URL('index.html', output)));
await import('./build-sgp-api-docs.mjs');
