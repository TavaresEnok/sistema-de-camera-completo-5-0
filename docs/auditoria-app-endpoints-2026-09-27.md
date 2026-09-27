# Auditoria aprofundada do aplicativo e seus endpoints

Data: 27/09/2026. Base analisada: `667b4fa`, com código de aplicação da entrega `7081265`.

## 1. Resultado e limites

O aplicativo tem proteções importantes, mas **não está funcionalmente alinhado com todos os contratos atuais da API**. Os principais riscos são isolamento de sessões, perda de clipes, informação incorreta sobre gravação/captura e recuperação após falhas de rede.

Esta entrega é uma análise, não uma correção. Não foram alterados APKs, serviços, permissões, câmeras ou gravações. A única consulta de diagnóstico à instalação foi GET sem autenticação para comparar duas rotas de status. Os demais ensaios novos usaram dados fictícios e serviços simulados em containers.

Não foi demonstrado P0 nesta rodada. Isso não certifica ausência de vulnerabilidades críticas. P1 indica possibilidade de exposição entre sessões, perda de evidência ou função principal indisponível; P2 indica falha funcional, de política ou recuperação; P3 indica melhoria estrutural/operacional.

O inventário possui 72 arquivos em `apps/mobile/src` (12.531 linhas), além de `App.tsx` (2.026 linhas) e 13 arquivos de teste. Esses números descrevem o tamanho da superfície, **não uma alegação de revisão exaustiva de cada linha**. Foram rastreados os fluxos abaixo até controllers e serviços relevantes. Não houve compilação de APK/IPA, typecheck nativo completo, instrumentação Android/iOS ou teste de todas as combinações de hardware.

## 2. Superfície e contratos examinados

Os caminhos abaixo são relativos à base da API, normalmente terminada em `/api`.

| Fluxo | Chamadas do app / contrato do servidor | Observação |
|---|---|---|
| Login | `POST /auth/login` | Token de acesso e refresh persistidos no SecureStore. |
| Renovação | `POST /auth/refresh` | Há coordenação global, mas sem identidade estável de sessão/origem. |
| Saída | `POST /auth/logout` | Revoga todas as sessões do usuário, não só o aparelho. |
| Recuperação de senha | `POST /auth/forgot-password` | Não exige token; mensagens de cliente tratadas no app. |
| Troca de senha | `PATCH /users/me/password` na tela redesign | Necessita regressão dos efeitos sobre sessões abertas. |
| Permissões | `GET /role-permissions/me` | Atualização com retries; não substitui autorização da API. |
| Personalização | `GET /settings/branding` | Cache por instalação, preservado em falhas. |
| Câmeras | `GET /cameras` | Lista completa; servidor filtra acessos e câmeras desativadas para viewers. |
| Cadastro privado | `GET /cameras/mine/quota`, `POST /cameras/mine` | Fluxo de descoberta, diagnóstico e confirmação. |
| Diagnóstico privado | `POST /cameras/mine/test-connection`, `/preview-frame` | Throttle, política comercial e validação de destino no backend. |
| Edição/exclusão privada | `PATCH/DELETE /cameras/mine/:id` | Verificação de proprietário no servidor. |
| Endereço RTMP | `GET /cameras/mine/:id/rtmp-ingest` | Restrito ao proprietário; contém informação sensível de publicação. |
| Ao vivo | `GET /camera-stream/:id/urls`, WHEP OPTIONS/POST/DELETE e HLS | Cache usa fetch próprio; diferenças entre player nativo e WebView H.265. |
| Prévias/foto | `POST /camera-stream/poster-tokens`, `GET /camera-stream/:id/poster` | Cache persistente com validade de três dias. |
| Gravação do sistema | App usa `/recordings/cameras/:id/recording/{status,start,stop}` | **Incorreto:** API publica `/cameras/:id/recording/...`. |
| Gravações históricas | `GET /recordings`, `POST /recordings/:id/play-token`, play/download | ACL de playback no servidor; app pagina a lista. |
| Miniaturas históricas | `POST /recordings/thumbnail-tokens` | Tokenização em lote; geração de requisição no app. |
| Clipe do celular | `POST /camera-stream/:id/clip/start`, `POST /camera-stream/clip/:id/stop`, `GET .../download` | Diferente da sessão manual persistente do NVR. |
| Detecções | `GET /ai/detections/latest-batch`, `POST /ai/live-view/{start,heartbeat,stop}/:id` | ACL por câmera; polling frequente no app. |
| Eventos | `GET /cameras/alarms`, `POST /cameras/alarms/:id/{ack,resolve}` | Lista limitada e filtragem adicional local. |
| Push | `POST/DELETE /notifications/devices` | Registro nativo FCM; APNs não implementado nesse caminho. |
| Silenciamento | `GET/POST /notifications/camera/:id/mute` | Estado por usuário; falta ACL explícita do alvo. |
| PTZ | `POST /ptz/:id/move` | API verifica `ptzControl` e autorização por câmera. |
| Rondas/layouts | `GET /rondas`, `GET /live-layouts` | Falhas são convertidas em listas vazias no app. |
| Arquivos locais | Galeria, favoritos, grupos, clipes e filas locais | Não dependem de endpoint, mas exigem isolamento por conta. |

Não confundir esses três controles: permissão global do papel, concessão individual/grupo da câmera e política comercial da instalação. Um controle correto não prova que os outros estão aplicados.

## 3. Evidências executadas

### Ensaios novos, isolados

| Ensaio | Resultado observado |
|---|---|
| Requisição antiga recebe token devolvido pelo handler atual | Token fictício da conta nova enviado novamente à origem antiga. |
| Refresh devolve null após 401 | Handler de desconexão chamado uma vez. O `catch` do app transforma também falha de rede em null. |
| 401 no cache de URLs de vídeo | Nenhuma chamada ao handler de refresh; status HTTP não preservado no objeto de erro. |
| Dois `savePoster` simultâneos, mesmo usuário, câmeras diferentes | Esperadas duas entradas no índice; restou uma. |
| Clipes legados sem proprietário + conta nova | Clipe legado importado para o escopo da conta nova, sem confirmação. |

Foram usados tokens fictícios, domínios `.invalid` e mocks em memória para armazenamento/arquivos. Não houve envio de token real a outra instalação.

### Contrato HTTP em execução

GET local sem credenciais na Vibe:

- `/recordings/cameras/audit-probe/recording/status`: **404**.
- `/cameras/audit-probe/recording/status`: **401**, coerente com rota existente protegida.

O código do controller confirma a rota canônica. Não foram chamados start/stop em produção.

### Testes existentes

- 61 testes passaram na execução dos demais arquivos da suíte.
- O arquivo `mobile-critical.test.ts` inicialmente não carregou por falta de AsyncStorage no container de API usado como laboratório; isso é limitação do ambiente, não falha comprovada do APK.
- Reexecutado separadamente com AsyncStorage simulado em memória: **44 testes aprovados**.
- Total dessas duas execuções: **105 testes aprovados**, sem equivaler a homologação nativa. Não se deve apresentar esse resultado como execução integral de um APK em aparelho.

## 4. Achados prioritários

### APP-01 — P1 — Controle da gravação usa rota inexistente

**Evidência:** `apps/mobile/App.tsx:1300` e `:1322`; `apps/api/src/recordings/recordings.controller.ts:35`, `:85`, `:102`, `:139`.

O controller não possui prefixo `recordings`; seus métodos registram `cameras/:cameraId/recording/...`. O app acrescenta `/recordings`. A leitura falha e o catch transforma indisponibilidade em `false`; start/stop também usam o caminho incompatível. Os controles aparecem na interface clássica, não devem ser atribuídos indiscriminadamente ao redesign.

**Correção proposta:** compartilhar contrato de rotas, corrigir os três caminhos e distinguir estado desconhecido de parado. **Aceite:** teste HTTP autenticado de status/start/stop, com viewer recusado, operador autorizado e câmera contínua protegida.

### APP-02 — P1 — Token da conta nova pode ser reutilizado em requisição da instalação antiga

**Evidência:** `App.tsx:369` e `src/services/api.ts:47`.

O handler retorna `sessionTokenRef.current` quando o token vencido difere do atual. O cliente HTTP repete a requisição usando esse token, mas mantém o `apiUrl` original. Uma resposta 401 atrasada da conta/instalação A, depois do login em B, pode receber o token de B. A coordenação global de refresh também não é indexada por sessão/origem. O mecanismo foi reproduzido com tokens fictícios.

**Correção proposta:** identidade imutável `{origin, userId, sessionGeneration}`, refresh por sessão e recusa de retry entre gerações/origens. **Aceite:** login A→B com 401 atrasado de A nunca envia token de B a A, nem mesmo no mesmo host com contas diferentes.

### APP-03 — P1 — Refresh em andamento pode restaurar sessão após logout

**Evidência:** `App.tsx:363–395`, especialmente publicação após `await saveStoredSession(renewed)`; logout em `:638`.

Não há conferência da geração da sessão depois da chamada de refresh e da persistência. Remover o handler não cancela a promessa que já está executando. Se logout/troca de conta ocorrer nesse intervalo, a continuação pode gravar e publicar novamente a sessão anterior.

**Correção proposta:** cancelar e invalidar a geração antes de limpar credenciais; conferir antes/depois de cada await; serializar gravações do SecureStore. **Aceite:** atrasar refresh, sair, liberar resposta: nenhuma sessão reaparece e o armazenamento permanece vazio/da nova conta.

### APP-04 — P1 — Falha transitória no refresh encerra sessão

**Evidência:** `App.tsx:390–393`; `src/services/api.ts:47–60`. Contrasta com `renewStoredSession`, que preserva a sessão em erros que não sejam 401.

Durante uso normal, qualquer erro no refresh vira null; o 401 original dispara logout. Assim, perder a rede no momento da renovação tem efeito de credencial revogada. O ensaio confirmou a desconexão quando o handler retorna null; o motivo transitório é perdido no catch do app.

**Correção proposta:** resultado tipado entre indisponível e revogado; manter credencial/identidade visual em indisponibilidade e oferecer retry. **Aceite:** timeout/503/offline no refresh não limpa SecureStore; refresh explicitamente revogado continua encerrando acesso.

### APP-05 — P1 — Alarmes atrasados podem aparecer após troca de usuário

**Evidência:** `src/hooks/useAlarms.ts:45–66` e efeito de sessão no mesmo arquivo.

`reload` publica `setAlarms` e `setErro` sem abort, geração ou comparação de sessão. Limpar a lista quando session fica null não impede que uma resposta anterior a repovoe depois. As ações ack/resolve também chamam o reload capturado da sessão antiga.

**Correção proposta:** request por geração/sessão, abort na desmontagem e limpeza de todos os estados ao trocar identidade. **Aceite:** resposta atrasada de A nunca publica nomes, eventos ou erros na sessão B.

### APP-06 — P1 — Migração automática atribui clipes antigos a outra conta

**Evidência:** `src/services/clips.ts:90–101`; comportamento semelhante para grupos/favoritos em `src/state/LibraryProvider.tsx:57–79`.

Na ausência de índice escopado, o primeiro usuário recebe `@drac:clips:v1`, que não informa proprietário. O legado é removido após copiar. O ensaio confirmou a importação para uma conta nova. Para clipes, isso inclui acesso ao arquivo local, não só nomes de câmeras.

**Correção proposta:** recuperação explícita com confirmação e critérios de origem; não atribuir automaticamente dados sem dono. **Aceite:** conta B não lista clipes legados de A; recuperação não apaga o original antes de conclusão verificável.

### APP-07 — P1 — Download interrompido apaga o clipe no servidor

**Evidência:** `apps/api/src/camera-stream/camera-stream.controller.ts:742–756`; `App.tsx:1092–1135`.

O backend associa `res.on('close')` à remoção do arquivo e do estado, incluindo fechamento por interrupção. O app apaga o arquivo local incompleto e mantém a fila prometendo nova tentativa. Na próxima tentativa o servidor já pode responder 404. Mesmo transferência HTTP concluída não prova que o app persistiu/registrou o arquivo.

**Correção proposta:** download não destrutivo, TTL após término e confirmação explícita/idempotente de recebimento; considerar Range. **Aceite:** interromper a transferência pela metade, repetir e conferir tamanho/hash antes de limpar o servidor.

### APP-08 — P1 — Fila local promete recuperação que o servidor não mantém

**Evidência:** `clip-capture.service.ts:41–46`, `:239–263`; `App.tsx:1140`.

Clipes do celular vivem em Map e diretório temporário, com expiração de 15 minutos desde o início. Reiniciar/recriar API perde o catálogo; um app que voltar depois do TTL não consegue recuperar a fila persistida. A nova `ManualRecordingSession` pertence à gravação do NVR e **não corrige este serviço de clipes**.

**Correção proposta:** catálogo durável com proprietário, estado e expiração, armazenamento persistente, resposta terminal 410/estado expirado e política de retry finita no app. **Aceite:** clipe finalizado sobrevive a restart; expirado sai da fila com explicação, sem retry infinito.

### APP-09 — P1 — “Foto atual” pode ser uma prévia de dias atrás

**Evidência:** `App.tsx:1507–1536`; `src/services/poster-cache.ts:5`.

A tela anuncia “Buscando a imagem mais recente”, mas usa `await refreshPoster(...) ?? streamPosters[camera.id]`. O fallback pode ser o cache de três dias. O sucesso informa apenas que a foto está na galeria, sem indicar data da captura ou que é uma imagem antiga. Para uso como evidência, isso é uma diferença material.

**Correção proposta:** separar capturar agora de salvar última prévia; não fazer fallback silencioso; manter `capturedAt` verificável e aviso de antiguidade. **Aceite:** câmera indisponível nunca gera confirmação de captura atual a partir do cache.

## 5. Funcionalidade, recuperação e endpoints

### APP-10 — P2 — Estado e rótulo da gravação não correspondem ao contrato novo

**Evidência:** `App.tsx:1294–1334`; `screens/LiveScreen.tsx:418` e `:471`.

O app usa `isRecording || intendedRecording`, ignora `manualRecordingActive` e altera o botão otimisticamente sem interpretar o resultado. A interface oferece “Gravar 24h”, enquanto a sessão manual da API tem teto de dez minutos. Contínua protegida pode responder sucesso sem parar e o app mostrar parado. Mesmo corrigindo APP-01, essa falha permanece.

**Correção/aceite:** representar manual, automática e desconhecida separadamente; explicar o limite; reconciliar resposta e polling; não oferecer parada manual de contínua. Resposta `continuous_recording_protected` não pode mudar a tela para “parado”.

### APP-11 — P2 — URLs de vídeo ignoram refresh e perdem status HTTP

**Evidência:** `src/services/stream-urls-cache.ts:66–84`; ensaio isolado descrito acima.

Fetch próprio não usa o pipeline de `request`; erro 401 vira Error sem status. A câmera pode parecer indisponível quando a sessão só precisa renovar. Uma consulta paralela de outra tela pode renovar por acaso, mas não torna esse contrato confiável.

**Correção/aceite:** compartilhar autenticação/erros tipados mantendo deduplicação e cancelamento; 401 renova uma vez, 403 informa permissão, falha de rede não vira logout.

### APP-12 — P2 — Downloads nativos usam token capturado, sem renovação

**Evidência:** `App.tsx:1092–1107`, `:1479`.

`FileSystem.downloadAsync` recebe Bearer diretamente e não passa pelo wrapper de refresh. Token expirado interrompe clipes e exportações. Retomar depende de outra operação renovar a sessão; não há handshake próprio para baixar novamente com credencial atual.

**Correção/aceite:** token curto de download ou renovação controlada com identidade da sessão; cancelamento rastreável; um 401 não deve apagar a única evidência local/remota.

### APP-13 — P2 — Limite de clipes concorrentes tem janela de corrida

**Evidência:** `clip-capture.service.ts:114–119`, `:166`.

O limite é consultado antes dos awaits de câmera/fonte; a reserva só entra no Map após spawn. Chamadas simultâneas podem observar a mesma capacidade livre. Não foi realizado teste de carga contra câmeras reais.

**Correção/aceite:** reservar vaga atomicamente antes do trabalho assíncrono, liberar no erro e aplicar cota por usuário/instalação; em laboratório, N starts simultâneos nunca excedem o teto configurado de processos.

### APP-14 — P2 — Download do clipe não reavalia acesso à câmera

**Evidência:** `camera-stream.controller.ts:735–749`; `clip-capture.service.ts:239–242`.

Start verifica liveView, câmera e plano; stop/download verificam sobretudo propriedade do clipId. Não é acesso livre ao clipe de terceiros, pois userId é conferido. Porém a revogação de acesso à câmera após start não é reavaliada no download.

**Decisão necessária:** definir se um clipe já capturado pertence definitivamente ao usuário ou acompanha revogação. Se acompanha, revalidar câmera/política no download. Não aplicar `exportEvidence` indiscriminadamente: o produto hoje permite explicitamente clipe ao viewer que pode ver ao vivo.

### APP-15 — P2 — Polling de IA sobrepõe chamadas e aceita respostas fora de ordem

**Evidência:** `src/hooks/useLiveDetections.ts:36–67`; `App.tsx:218`.

Intervalo de 600 ms dispara sem single-flight; timeout do wrapper é 15 s, permitindo aproximadamente 25 consultas simultâneas por câmera sob lentidão. `cancelled` protege desmontagem, não a ordem de respostas da mesma sessão. O hook depende da câmera aberta, não de uma declaração explícita de overlay realmente visível.

**Correção/aceite:** agendar o próximo poll após finalizar o anterior, abort ao pausar, número sequencial de resposta e backoff. Com atraso de 15 s deve existir no máximo uma consulta ativa por consumidor.

### APP-16 — P2 — IA não aplica a mesma permissão global de ao vivo

**Evidência:** `apps/api/src/ai/ai.controller.ts:142`, `:190`, `:210`; `role-permissions/permissions.guard.ts`; `access-control.service.ts:202`.

As rotas examinadas validam papel e ACL por câmera, mas não possuem `RequirePermission('liveView')`, presente nas URLs de stream. O guard é transparente quando não há anotação; a ACL por câmera é outra política. Usuário com câmera concedida e liveView global negado pode conservar acesso a detecções/ativação de lease.

**Correção/aceite:** decidir permissão explícita para inferência ao vivo e aplicá-la nos endpoints, não só na interface. Testar papel com liveView negado e câmera individual concedida. Não foi demonstrado acesso a câmera sem ACL.

### APP-17 — P2 — Atualizações simultâneas perdem índice de miniaturas

**Evidência:** `src/services/poster-cache.ts:64–80`; workers em `App.tsx:834`.

Cada gravação lê e reescreve o índice inteiro sem serialização. Dois saves de câmeras diferentes podem deixar só a última entrada; reproduzido em laboratório. Arquivos já baixados podem ficar sem referência, repetindo downloads e acumulando armazenamento.

**Correção/aceite:** fila por scope ou índice transacional; dois saves simultâneos preservam ambas as entradas; faxina remove somente arquivos sem referência validada.

### APP-18 — P2 — Hidratação inicial de posters ignora troca de sessão

**Evidência:** `App.tsx:807–813`.

Após `await loadCachedPosters`, o resultado é aplicado antes das guardas de token/geração usadas no restante do fluxo. Uma leitura antiga pode inserir imagens locais depois do logout/troca de conta. Não há prova de reprodução de stream não autorizado; trata-se do estado local de imagens.

**Correção/aceite:** mesma identidade e geração desde o primeiro await; cache de A nunca é aplicado à tela B.

### APP-19 — P2 — Normalização da biblioteca concorre com inclusão/exclusão

**Evidência:** `src/services/clips.ts:103–139` versus `addClip/removeClip`, que usam `serialized`.

`listClips` também escreve o índice após verificar arquivos/gerar thumbnails, mas fora da fila de mutações. Pode sobrescrever um clipe recém-adicionado ou recolocar metadados recém-removidos.

**Correção/aceite:** leitura reparadora participa da mesma transação/fila, ou aplica diff com versão; atrasar geração de thumbnail enquanto adiciona/remove não perde nem ressuscita itens.

### APP-20 — P2 — Evento pode permanecer resolvido apenas na interface

**Evidência:** `src/hooks/useAlarms.ts:73–88`.

Ack/resolve atualiza otimisticamente antes do POST. Em falha, chama reload, mas não restaura o estado anterior. Se POST e reload falharem, o evento fica visualmente resolvido e pode reduzir o contador sem confirmação do servidor.

**Correção/aceite:** rollback condicionado à identidade da operação e estado “enviando”; falha de rede nunca deve manter confirmação falsa de resolução.

### APP-21 — P2 — Filtro local após limite esconde eventos válidos

**Evidência:** `useAlarms.ts:50–54`, `:112`; `cameras.controller.ts:454–501`.

O app pede os primeiros 100 alarmes e só depois exclui diagnósticos. Cem diagnósticos recentes podem ocultar um evento de segurança na posição 101. O contador considera apenas o subconjunto carregado, sem informar que é parcial. API já oferece parâmetros de filtro e paginação, mas o app não os explora nesse fluxo.

**Correção/aceite:** filtro de eventos do cliente no servidor, paginação e total apropriado; cenário de 100 diagnósticos + um evento real continua encontrável.

### APP-22 — P2 — Tela de evento usa imagem atual e abre ao vivo

**Evidência:** `screens/redesign/EventsRedesign.tsx:113–138`; callback de push em `App.tsx:458`.

A miniatura vem de `streamPosters`, não do instante do evento; tocar abre a câmera ao vivo. Não é necessariamente erro de autorização, mas é inadequado para investigar ocorrência passada sem aviso: o usuário vê outra cena.

**Correção/aceite:** distinguir “prévia da câmera” de “imagem do evento”; oferecer “Ver ocorrência” com instante e gravação associada, além de “Abrir ao vivo”. Se não houver gravação, dizer isso explicitamente.

### APP-23 — P2 — WebRTC H.265 não cancela toda a negociação pendente

**Evidência:** `components/HevcWebRtcVideo.tsx:104–160`.

O HTML usa fetch sem AbortController nas negociações. `closeSession` pode esperar DELETE antes de fechar a conexão; a continuação de start não confere `closed` depois de cada await. Há timeout externo de 20 s no componente, portanto não é correto dizer que toda a tela fica indefinidamente sem timeout. O risco é o trabalho/recurso pendente sobreviver ao abandono da tentativa.

**Correção/aceite:** cancelamento por geração, deadline de OPTIONS/POST/DELETE e fechamento local imediato; resposta WHEP tardia deve ter a sessão descartada. Validar no WebView real.

### APP-24 — P2 — Diagnóstico do playback pode travar ou escolher fallback errado

**Evidência:** `components/VideoPlayers.tsx:519–553`.

A sonda Range não possui deadline/abort próprio. O comentário distingue 401/403 de 503, mas o trecho trata 503 e encaminha os demais ao fallback de compatibilidade, sem um ramo explícito de renovação para 401/403. Converter vídeo não corrige autorização expirada.

**Correção/aceite:** timeout e geração por mídia, renovar autorização antes de mudar codec, cancelar resposta antiga ao trocar arquivo; 401 não deve iniciar tentativa desnecessária de transcode.

### APP-25 — P2 — Push iOS está explicitamente indisponível

**Evidência:** `src/services/push.ts:89–94`.

O fluxo retorna null em plataformas diferentes de Android, explicando que APNs ainda exige credencial própria. Isso é lacuna de produto, não bug provado de uma implementação APNs existente.

**Correção/aceite:** implementar e homologar APNs ou declarar claramente a indisponibilidade por plataforma; teste físico de foreground, background, app encerrado, permissão negada e toque em notificação.

### APP-26 — P2 — Logout offline pode manter notificações da conta anterior

**Evidência:** `src/services/push.ts:116–130`; `push-devices.service.ts:register`, `tokensForUsers`.

Falha de unregister é ignorada e o token em memória é descartado. O backend seleciona tokens cadastrados sem TTL de `lastSeenAt` nesse método. Se a pessoa mudar de instalação, registrar no servidor B não remove o cadastro no servidor A. Pode continuar recebendo avisos da conta anterior no aparelho.

**Correção/aceite:** identidade persistente de instalação/aparelho, remoção pendente e renovação/expiração de registro; definir revogação de push na saída. Troca A→B offline não deve deixar notificações de A indefinidamente.

### APP-27 — P2 — “Sair” encerra sessões em outros aparelhos

**Evidência:** `auth.controller.ts:108`; `auth.service.ts:372–382`.

Logout incrementa authVersion do usuário e revoga todas as authSessions. Pode ser política intencional, mas o contrato não distingue “Sair deste aparelho” e “Sair de todos”. A equipe técnica e o cliente precisam saber o alcance.

**Correção/aceite:** separar endpoints/ações ou comunicar saída global antes da confirmação; sair no celular não derruba silenciosamente o painel web se a escolha for saída local.

### APP-28 — P2 — Silenciamento não valida acesso ao alvo

**Evidência:** `notifications.controller.ts:33–52`; `push-devices.service.ts:isMuted/setMute`.

O controller valida existência de usuário, não a concessão da câmera. O usuário só altera seu próprio mute, portanto isso **não prova leitura de conteúdo nem alteração do mute de terceiros**. Ainda assim, câmera arbitrária/removida pode produzir estado indevido ou erro de integridade em vez de erro de domínio consistente.

**Correção/aceite:** validar câmera e ACL; DTO validado para booleano; testar câmera alheia, inexistente e valor inválido sem 500 nem gravação indevida.

### APP-29 — P2 — Cadastro depende de GPS sem prazo explícito

**Evidência:** `services/installer-location.ts:11–17`; `components/AddCameraSheet.tsx:322`.

Submit aguarda posição de alta precisão antes de cadastrar. O catch cobre rejeição, não um pedido que demora excessivamente. Em local fechado/GPS degradado, o usuário pode ficar esperando por uma informação auxiliar.

**Correção/aceite:** deadline, opção de continuar sem localização e captura assíncrona segura; ausência de fix não bloqueia cadastro além do limite definido.

### APP-30 — P2 — Interface de frota renderiza listas sem virtualização

**Evidência:** `screens/redesign/CamerasRedesign.tsx:106`; `screens/MosaicScreen.tsx`; `screens/redesign/EventsRedesign.tsx`; `cameras.controller.ts:313`.

ScrollView e mapeamento completo combinam-se com lista de câmeras sem paginação nessa rota. O mosaico limita streams simultâneos a quatro — proteção positiva —, mas isso não limita os componentes/miniaturas das listas. Não foram medidos FPS, memória ou bateria, portanto não há percentual de degradação demonstrado.

**Correção/aceite:** FlatList/SectionList, paginação/projeção de payload, callbacks estáveis e prioridade de imagem por visibilidade; medir 50/200/500 câmeras em aparelho intermediário antes de fixar orçamento.

## 6. Melhorias estruturais e decisões pendentes

### APP-33 — P1 — Falha de remux pode apagar o único original do clipe

**Evidência:** `apps/api/src/camera-stream/clip-capture.service.ts:184–195` e `:214–236`.

`remux` devolve booleano de sucesso, mas `stop` ignora esse resultado, remove o TS de origem e considera o MP4 válido se tiver tamanho maior que zero. Uma falha que deixe MP4 parcial pode ser apresentada como sucesso; uma falha sem saída apaga o TS antes de devolver erro. Além disso, chamadas concorrentes de stop não compartilham promessa de finalização e podem remuxar para o mesmo destino.

**Correção/aceite:** single-flight por clipId, saída temporária, conferir retorno e integridade antes de promover MP4, preservar TS em falha recuperável. Injetar erro de remux, falta de espaço e dois stops simultâneos; nunca apagar a única cópia íntegra nem devolver sucesso por um arquivo parcial. O `ffprobe` síncrono sem timeout no remux também deve ganhar deadline/execução assíncrona para não bloquear a API. Esses cenários foram identificados no código, não provocados em produção.

### APP-31 — P3 — Rondas e layouts não distinguem erro de ausência

`App.tsx:749–758` converte falhas das duas APIs em listas vazias. Isso evita quebrar instalação antiga, mas também esconde timeout, 403 ou falha atual. Separar 404 de versão antiga, indisponibilidade e lista legitimamente vazia. O relógio da ronda (`RondaScreen.tsx:97–110`) também merece política explícita de pausa/retomada em background e teste nativo; não foi demonstrado que o SO execute timers continuamente em segundo plano.

### APP-32 — P3 — Contratos e estados concentrados em App.tsx

Mais de duas mil linhas concentram autenticação, mídia, evidência, permissões, push e persistência. As telas clássica e redesign não recebem exatamente as mesmas capacidades: a gravação do sistema existe no caminho clássico; o redesign não oferece esse mesmo controle. Não tratar as duas variantes como equivalentes sem uma matriz de paridade.

Separar máquinas de estado de sessão, player e clipe; cliente de API com rotas/tipos compartilhados; testes de contrato executados contra controllers reais. Refatoração deve vir após os testes dos P1, não substituí-los.

## 7. Proteções confirmadas que devem ser preservadas

- Credenciais de sessão no SecureStore, com política de chave vinculada ao aparelho; remoção do legado de AsyncStorage.
- Cache de URLs de vídeo inclui servidor, token, câmera e modo; limpeza aborta pendências e finally confere identidade da promessa.
- Muitos fluxos do App já usam token e geração para descartar listas/playback antigos. A falha é a cobertura inconsistente, não ausência total dessas proteções.
- Login manual limpa resposta antiga de push e navega ao início; branding válido é persistido por instalação e não substituído por padrão quando a busca falha.
- Guards de câmera privada verificam proprietário; política de destinos de câmera existe no serviço; não foi demonstrado SSRF nesta rodada.
- Backend de playback exige acesso à câmera; listagem produz campos explícitos, não devolve diretamente filePath do banco.
- PTZ combina permissão global e ACL por câmera. Ações de alarmes possuem permissão específica e conferência de acesso.
- Cadastro/edição possuem identificador de operação para descartar respostas antigas em vários caminhos.
- Reprodução utiliza monitoramento de avanço de frames em WebRTC e caminhos de recuperação; HLS/HEVC não devem ser removidos para resolver apenas um bug de estado.
- Crash reporting tem sanitização; galeria pede escrita de mídia própria; controles do redesign já contêm rótulos de acessibilidade em diversas ações. Isso não equivale a certificação completa de privacidade/acessibilidade.

## 8. Plano de correção e critérios de encerramento

### Lote A — Sessão e isolamento

APP-02/03/04/05/06/18. Testar logout com refresh pendente, A→B no mesmo servidor, troca de instalação, offline no refresh, resposta de alarmes atrasada e legado sem proprietário. Nenhum token/dado pode atravessar a identidade de sessão. Testes devem inspecionar requisições realmente emitidas, não apenas procurar strings no código.

### Lote B — Evidências e gravação

APP-01/07/08/09/10/12/13/14/19/33. Testar rota real, limites, gravação contínua, interrupção do download, restart da API, expiração terminal, arquivo vazio, integridade do arquivo, falha de remux e snapshot indisponível. Não encerrar o lote apenas porque o botão mudou de cor.

### Lote C — Vídeo, IA e eventos

APP-11/15/16/20/21/22/23/24. Cobrir token vencido, 403, rede lenta, troca de câmera durante negociação, perda de frames com ICE conectado, fila de inferência, resposta fora de ordem, falha de ack e navegação ao instante de ocorrência.

### Lote D — Produto e operação

APP-17/25/26/27/28/29/30/31/32. Push por plataforma, saída local/global, GPS sem fix, armazenamento cheio, álbum sem permissão, listas grandes, leitores de tela e fontes ampliadas. Preservar configuração branca/rosa de cada cliente também offline e em retorno de background.

### Matriz nativa ainda obrigatória

| Dimensão | Cenários mínimos |
|---|---|
| Sistema | Android suportado mais antigo, Android atual e iPhone físico, se iOS for produto suportado. |
| Build | Clássico e redesign; pelo menos duas marcas/instalações; APK release produzido pela Central. |
| Rede | Wi-Fi, dados móveis, troca entre redes, offline, latência/perda e retorno. |
| Player | H.264/H.265, áudio ligado/desligado, HLS/WebRTC, rotação, tela bloqueada e processo encerrado. |
| Usuário | Viewer, operador, administrador; câmera pública/privada; permissão revogada durante sessão. |
| Evidência | Captura real, download interrompido, galeria negada, pouco espaço, restart da API e retorno depois do TTL. |
| Escala | Listas grandes, quatro streams no mosaico, ronda prolongada e aquecimento/bateria. |
| Eventos | Push no cold start, evento antigo, sem gravação, filtro, paginação e ações offline. |

Também falta comparar o APK que está em cada aparelho com o commit/build produzido pela Central. Este relatório identifica a base de fontes analisada; não afirma que todos os clientes instalaram essa mesma versão.

## 9. Conclusão

Prioridade imediata: impedir mistura/restauração indevida de sessões, corrigir contrato da gravação e garantir que download/captura não percam ou representem incorretamente evidências. Depois vêm consistência de permissões, recuperação do player e desempenho.

A aprovação final exige testes de contrato e dispositivos físicos. Os testes atuais são úteis, mas passaram mesmo com divergência de rota no controle de gravação: **suíte verde não é prova de integração completa entre app e API**.
