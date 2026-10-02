# Movimento e objetos — Vibe, IB Telecom e Dguardian

Pedido de 02/10/2026: movimento em 7 imagens/s nas instalações e objeto
liberado na Vibe somente para pessoa, carro, moto e bicicleta. Usuário depois
excluiu a demo; nenhuma alteração aplicada às demos.

## Aplicado e verificado

| Instalação | Perfil de movimento carregado | Alteração |
|---|---|---|
| Vibe | 7.0 FPS | `.env` e override persistente `infra/docker-compose.pipeline-vibe.yml`; recriado somente ai-service |
| IB Telecom | 7.0 FPS | Já estava em 7; `.env` confirmado; sem restart |
| Dguardian | 7.0 FPS | `.env` com backup protegido; recriado somente ai-service |

Vibe `/health` do ai-service: ready=true; processadores com `process_fps=7`,
taxas observadas aproximadamente 6.8–7.0 imagens/s. Dguardian sem câmeras e
IB sem processadores ativos na consulta anterior: confirmar o perfil carregado
não equivale a medir taxa efetiva nessas duas instalações.
Readiness público Vibe/Dguardian pronto, seis checks aprovados.
Não reiniciados vídeo/MediaMTX, gravação, banco, frontend ou API nesta alteração.

## Objetos Vibe

Alterada pela rota autenticada real da Central:
PATCH `/api/admin/installations/vibe/ai-policy`.

```json
{"aiPolicy":{"motion":true,"object":true,"face":false,"objectClasses":["person","car","motorcycle","bicycle"]}}
```

Central confirmou HTTP 200, desiredRevision=7, appliedRevision=7, APPLIED.
Endpoint usado pelo perímetro, GET HTTPS `/api/ai/simulation-capabilities`,
validado com autorização administrativa temporária em memória, expiração de
60 segundos, respeitando authVersion e role; resposta HTTP 200:

```json
{"classes":["person","car","motorcycle","bicycle"],"motionAllowed":true}
```

Tokens/chaves não exibidos ou persistidos. Nenhuma alteração de configuração
por câmera, modo de gravação, áreas ou sensibilidade. Antes da liberação,
zero câmeras elegíveis para objeto permanente segundo linhas/modo de objeto;
depois, ai-service confirmou zero processadores permanentes de objeto.
Modelos OpenVINO instalados disponíveis; não iniciado teste de objeto em uma
câmera por nossa conta. Operador escolhe o modo na simulação ou na câmera.
Página já aberta pode precisar ser recarregada: hook de capacidade tem cache
de sessão de tela e não acompanha sozinho a aplicação da política pela Central.

## Movimento distante — diagnóstico, não promessa de alcance

VIBE NOBRE FRENTE: modo de gravação motion, objectMode auto, zona include sem
sensibilidade explícita (padrão média). Detector ativo reduz a análise para
320×180, `motion_min_component_ratio=0.0012`; código impõe componente mínimo
de `int(320*180*0.0012)=69` pixels antes de filtros adicionais. Alta usa fator
0.5, média 1.0 e baixa 3.0; o FPS não altera esses fatores ou a resolução.

**Hipótese:** pessoas/veículos distantes ficam pequenos após redução e podem
ser eliminados por tamanho/morfologia/filtros de ruído ou contraste. Isso não
foi reproduzido com distância física medida, nem uma causa única comprovada.
Não existe limite de metros garantido a partir do FPS. A mudança para 7 ajuda
a amostragem temporal, mas não demonstra que passou a detectar a 10/30 m.
Não alterados limiares globais ou área/sensibilidade da câmera por suposição.

## Fonte e testes

Padrão futuro no código, exemplo de ambiente e compose alterado de 5 para 7;
guard no teste do instalador evita divergência dos três padrões. Isso não
promove uma release global da frota nem substitui o deploy de cada host.
Testes do instalador e `git diff --check` aprovados. Em container isolado,
MOTION_DETECTION_FPS=7.0, quatro testes `test_motion_startup.py` aprovados,
sem acesso à rede ou às câmeras de produção.
