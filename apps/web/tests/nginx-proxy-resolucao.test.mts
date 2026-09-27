import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const conf = readFileSync('nginx.conf', 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// TODO `proxy_pass` PARA UM SERVIÇO DO COMPOSE USA VARIÁVEL, NUNCA NOME LITERAL.
//
// Com nome literal o nginx resolve o host UMA VEZ, na inicialização, e guarda o
// IP para sempre. Num compose, container recriado ganha IP novo — e o web passa
// a apontar para um endereço morto até alguém reiniciar o web.
//
// Já custou duas vezes:
//   · a API caiu junto com a GPU e o web entrou em CRASH-LOOP (312 reinícios),
//     porque com nome literal o nginx se RECUSA a subir se o host não existir;
//   · 13/08/2026 no D-GUARDIAN: a API foi RECRIADA (não caiu — saída 0, zero
//     reinícios), ganhou IP novo, e o cliente viu "Sem comunicação com o
//     servidor". 502 em tudo, enquanto de dentro do próprio container do web um
//     `wget http://api:3000` respondia normalmente — porque o wget resolve na
//     hora e o nginx não.
//
// O `resolver` sozinho NÃO resolve o problema: ele só é consultado quando o
// endereço vem de uma VARIÁVEL. É esta a parte que passa despercebida numa
// revisão — e foi assim que o /api/ foi corrigido e o /hls/ ficou para trás.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICOS = ['api', 'mediamtx', 'drac-central'];

test('nenhum proxy_pass aponta para nome de serviço literal', () => {
  for (const servico of SERVICOS) {
    const literal = new RegExp(`proxy_pass\\s+https?://${servico.replace('-', '\\-')}[:/]`);
    assert.doesNotMatch(
      conf,
      literal,
      `proxy_pass literal para "${servico}": o IP congela no arranque e a rota morre quando o container é recriado`,
    );
  }
});

test('cada rota proxiada declara resolver E usa variável', () => {
  const rotas = conf.split(/location\s+/).filter((bloco) => bloco.includes('proxy_pass'));
  assert.ok(rotas.length >= 4, `esperava ao menos 4 rotas proxiadas, achei ${rotas.length}`);
  for (const bloco of rotas) {
    const nome = bloco.split('\n')[0].trim();
    assert.match(bloco, /resolver\s+127\.0\.0\.11/, `${nome}: sem resolver do Docker`);
    assert.match(bloco, /proxy_pass\s+\$/, `${nome}: proxy_pass não usa variável — o resolver acima é decorativo`);
    assert.match(bloco, /set\s+\$\w+\s+https?:\/\//, `${nome}: não define a variável de destino`);
  }
});

test('o resolver tem validade curta — IP novo precisa ser notado rápido', () => {
  const validades = [...conf.matchAll(/resolver\s+127\.0\.0\.11\s+valid=(\d+)s/g)].map((m) => Number(m[1]));
  assert.ok(validades.length >= 4, `nem toda rota declara validade: achei ${validades.length}`);
  for (const v of validades) {
    assert.ok(v <= 30, `valid=${v}s é longo demais: o cliente fica no 502 por até ${v}s depois de um deploy`);
  }
});

test('ipv6 desligado no resolver', () => {
  // Sem isto o nginx pede AAAA primeiro numa rede Docker que só tem IPv4, e
  // paga a espera do DNS em toda requisição.
  const resolvers = [...conf.matchAll(/resolver\s+127\.0\.0\.11[^;]*;/g)];
  assert.ok(resolvers.length >= 4, 'faltam declarações de resolver');
  for (const [linha] of resolvers) {
    assert.match(linha, /ipv6=off/, `resolver sem ipv6=off: ${linha}`);
  }
});

test('o arquivo lido não está vazio (guarda contra teste falso-verde)', () => {
  // Um nginx.conf vazio faria TODAS as asserções acima passarem por vacuidade.
  assert.ok(conf.length > 500, `nginx.conf tem ${conf.length} caracteres — leitura suspeita`);
  assert.match(conf, /location\s+\/api\//, 'a rota /api/ sumiu do arquivo');
});

test('servidor HTTP interno não força recursos para HTTPS', () => {
  assert.doesNotMatch(
    conf,
    /add_header\s+Content-Security-Policy[^;]*upgrade-insecure-requests/i,
    'a porta 5173 também atende por HTTP; este CSP faria o navegador buscar os assets em HTTPS e quebraria a tela',
  );
  assert.doesNotMatch(
    conf,
    /add_header\s+Strict-Transport-Security/i,
    'HSTS deve ser emitido apenas pelo proxy TLS externo, nunca pelo servidor HTTP interno',
  );
});

test('redirecionamentos absolutos do MediaMTX permanecem na origem HTTPS do cliente', () => {
  for (const prefixo of ['webrtc', 'hls']) {
    const bloco = conf.split(`location /${prefixo}/ {`)[1]?.split('\n    }')[0] ?? '';
    assert.match(
      bloco,
      new RegExp(`proxy_redirect\\s+~\\^https\\?://\\[\\^/\\]\\+/\\(cam_\\.\\*\\)\\$\\s+/${prefixo}/\\$1;`),
      `${prefixo}: Location absoluto em http:// escaparia do HTTPS e seria bloqueado pelo Android`,
    );
  }
});

test('HLS aceita o token do app na query sem quebrar o Bearer do navegador', () => {
  assert.match(conf, /map\s+\$arg_token\s+\$media_query_authorization/);
  assert.match(conf, /map\s+\$http_authorization\s+\$media_header_or_query/);
  assert.match(conf, /map\s+\$media_header_or_query\s+\$media_authorization/);
  assert.match(conf, /Bearer \$cookie_s2cam_stream_token/);
  const hls = conf.split('location /hls/ {')[1]?.split('\n    }')[0] ?? '';
  assert.match(hls, /proxy_set_header\s+Authorization\s+\$media_authorization;/);
  assert.match(hls, /add_header\s+Set-Cookie\s+\$media_token_cookie\s+always;/);
  assert.match(conf, /map \$uri \$media_cookie_path/);
  assert.match(conf, /Path=\$media_cookie_path; Max-Age=300; HttpOnly; Secure; SameSite=Strict/);
});
