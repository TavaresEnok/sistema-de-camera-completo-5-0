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

Publicação prevista por imagens assinadas API/web, com backup, mesma estrutura de banco e sem reiniciar AI, MediaMTX ou ingestão RTMP. Evidências de reprodução e saúde pós-publicação ficam separadas dos testes de layout. Não se afirma certificação WCAG completa nem teste físico em todos os aparelhos.

Referências: [WCAG Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [tamanho mínimo de alvos](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [Playwright Docker](https://playwright.dev/docs/docker).
