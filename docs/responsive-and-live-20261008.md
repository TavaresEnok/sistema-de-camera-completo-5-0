# Revisão de celular/tablet e abertura de vídeo — 08/10/2026

## Escopo e evidências

Interface web compartilhada por Vibe, Dguardian e IB Telecom. Demo e APK fora do escopo. Diagnóstico inicial em produção; implementação e testes em worktree isolado na Management. Credenciais, licença, modos de gravação e chaves de publicação não fazem parte das alterações.

Na interface anterior, em 360 CSS pixels, ações da grade estavam fora da tela: Layouts em x=316/largura=57, Telas em x=380/largura=57 e tela cheia em x=451. Filtros e ações de câmeras também ultrapassavam a largura. Evidências: `baseline-chromium.json` e capturas correspondentes no relatório protegido de publicação.

Na Vibe, uma amostra de dois segundos mostrou CPU ocupada em 68,9%, afinidade de 10 CPUs, carga de um minuto de 11,38 e aproximadamente 6 GB de memória disponível. O código recusava novas conversões tanto por CPU >=75% quanto por carga/CPUs >=0,75. O segundo critério não mede CPU ocupada no instante: inclui espera por disco e atividade anterior. O bloqueio existia também no comando executado pelo MediaMTX.

Várias câmeras RTMP da Vibe enviam um único fluxo H.264 1920×1080/20 FPS. Não existe substream separado nessa publicação. O perfil leve opcional reduz imagens quando há orçamento; se não houver, a API usa vídeo direto em vez de interromper uma câmera compatível. Não é correto prometer que Instantâneo sempre reduz a resolução, nem forçar novas conversões em toda a frota.

## Mudanças

- Menu completo em painel sobreposto abaixo de 1200 pixels; barra lateral de desktop preservada.
- Celular começa em 1×1 sem abrir a grade grande salva no desktop. Preencher limitado a quatro câmeras no celular; desktop mantém limite de 36.
- Painéis de seleção/detalhes e formulários adaptados ao viewport, com rolagem e áreas seguras. Mesma árvore de conteúdo, sem duplicar o player por abrir um menu.
- Filtros, ações e cadastros ajustados; campos com 16px em telas compactas; ações principais com áreas de toque maiores.
- Reprodução com Pointer Events, identificação do ponteiro e encerramento em pointercancel. Captura da régua só após iniciar arraste, preservando o clique no segmento.
- Editor de perímetro mantém coordenadas normalizadas; área de toque dos vértices aumentada, sem alterar o desenho salvo.
- Investigação em coluna com rolagem no celular/tablet; filtros quebram linha também no desktop.
- Retirado o selo “Qualidade original”. Resolução mostrada continua sendo a recebida pelo vídeo. Ajuda de Instantâneo explica a preferência por menor atraso sem prometer um substream inexistente.
- Admissão de conversões considera CPU medida, memória, orçamento ponderado e quantidade de processos; carga acumulada fica apenas como diagnóstico. Guarda do MediaMTX mede CPU em 300ms e preserva limites de memória/locks.
- Diagnóstico de redução H.264 não diz mais que o navegador está convertendo H.265.
- Desligamento da API finaliza segmentos sem desarmar gravação. A publicação trata também o comportamento da versão antiga, sem sobrescrever ações do operador ou reativar temporizador manual vencido.

## Verificação e limites

Frontend: checagem de tipos e 564 testes aprovados. API: 1.730 aprovados, dois testes opcionais ignorados, zero falhas. Regressões novas cobrem carga alta com CPU livre, CPU ocupada, memória insuficiente, reservas compartilhadas, cancelamento de toque e preservação da gravação no desligamento.

Comparação visual em 320, 360, 390, 768, 1024 e 1440 pixels. Foram inspecionadas 132 combinações de rota/largura e repetidas as telas que exigiram ajustes; auditoria usa a rota real `/audit-logs`. Testes de navegador verificam interface e metadados reais; não são prova de desempenho de transmissão, pois a mídia é bloqueada nessa etapa.

Teste de interação Chromium: grade de desktop de 16 câmeras não abre 16 players no celular; Preencher abre quatro; seleção ampliada volta a quatro mantendo fullscreen; toque nativo move a linha do tempo e cancelamento encerra arraste; troca de orientação não cria rolagem horizontal da página.

Publicação concluída em Vibe, Dguardian e IB Telecom por imagens assinadas API/web, com backup e mesma estrutura de banco. AI, MediaMTX e ingestão RTMP mantiveram suas imagens e horários de início. Build servido nas três: `3fdd3d3-responsive-live`. Não se afirma certificação WCAG completa nem teste físico em todos os aparelhos.

WebKit: 24 combinações de rota/largura com navegação SPA, sem controles cortados nem erros JavaScript. A navegação real foi usada para não confundir cancelamento de requisições ao recarregar documentos com falha do aplicativo.

Após publicar, teste no navegador contra os domínios reais, com uma câmera por instalação e reprodução avançando. JWT de manutenção temporário apenas em memória; nenhum login/senha do cliente alterado; nenhuma gravação ou licença alterada para o teste.

| Instalação / câmera de amostra | Máxima resolução recebida | Instantâneo recebido | FPS decodificados na amostra de 3 segundos | Quadros descartados |
| --- | --- | --- | --- | --- |
| Vibe / VIBE NOBRE FRENTE | 1920×1080 | 640×360 | 20 | 0 |
| Dguardian / Camera Frente | 1920×1080 | 640×360 | 10 | 0 |
| IB Telecom / Grupo Flash Cam-06 | 640×480 | 640×480 | 30,3 | 0 |

Essas são amostras de entrega de vídeo, não FPS da detecção nem garantia para toda a frota. Instantâneo pode manter a resolução de origem quando não há imagem menor ou orçamento de conversão; não é forçada conversão adicional em todas as câmeras. Nos testes, as duas escolhas retornaram HTTP 200, o selo “Qualidade original” não apareceu e a página coube em 390 pixels.

O código compilado efetivamente instalado foi verificado: carga alta com CPU em 68% é admitida com orçamento/memória livres; CPU em 90% continua recusada com motivo `cpu`; comando de mídia mede `/proc/stat`, não `/proc/loadavg`. A recusa real por CPU/memória/orçamento permanece possível — a correção não remove proteção contra sobrecarga.

Na Vibe, contagem de 35 câmeras, modos (34 manual/1 objeto), digest das escolhas/configurações e digest das credenciais da instalação foram idênticos antes/depois. A inspeção do arquivo de imagens verificou 22 camadas e nenhum arquivo-fonte proibido. Backups e resultados por instalação em `infra/backups/viewing-updates/`; evidências de navegador protegidas na Management.

Referências: [WCAG Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [tamanho mínimo de alvos](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [Playwright Docker](https://playwright.dev/docs/docker).
