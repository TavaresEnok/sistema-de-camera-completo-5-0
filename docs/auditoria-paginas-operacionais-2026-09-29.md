# Auditoria de Desempenho, Armazenamento, Mapa e páginas complementares

Data: 29/09/2026. Código examinado: `5391c4a0dc390025d05f756c1cbc80d07ec9da92`, versão implantada na Vibe e IBTelecom na rodada anterior. O commit posterior `75b678a` contém somente documentação.

## Resultado e limites

Foram encontrados problemas funcionais, de autorização, integridade do acervo, concorrência, apresentação e linguagem. A prioridade é corrigir o escopo das consultas de armazenamento e as operações destrutivas da nuvem; depois, proteger os formulários e corrigir os contratos entre interface e API.

O inventário contém **38 achados: 11 P1, 26 P2 e 1 P3**. Alguns agrupam manifestações da mesma causa; não representam 38 incidentes observados em produção.

Esta rodada é uma análise, não uma implementação. Nenhuma gravação foi apagada, nenhum comando físico PTZ foi enviado e nenhuma configuração de câmera foi alterada. A reprodução dos métodos de armazenamento e mapa usou dependências simuladas, sem conexão com banco ou fornecedor de nuvem. Não foi comprovada exploração em produção nem perda real de arquivos.

P1 = prioridade alta: acesso indevido, integridade do acervo ou perda de alterações relevantes. P2 = problema funcional/operacional ou de usabilidade. P3 = melhoria de clareza/manutenção. Não foi comprovado um P0 nesta rodada; ausência de P0 demonstrado não significa ausência de risco.

A análise principal percorreu Desempenho, Armazenamento e Mapa, seus componentes e endpoints associados. A análise complementar percorreu fluxos de Investigação, Alarmes, Inteligência/Detecções, PTZ, Auditoria e trechos de Reprodução. Não se declara revisão linha a linha de toda a Reprodução, de todo o processamento de vídeo, do APK ou da Central nesta rodada.

Não houve sessão autenticada em navegador para validar aparência real, foco, dispositivos móveis e latência. Achados de layout são fundamentados no JSX/CSS; problemas de concorrência são fundamentados no fluxo de estado e precisam de ensaios de interface com respostas atrasadas durante a correção.

## Inventário de cobertura

| Página/rota | Cobertura nesta rodada |
| --- | --- |
| Desempenho `/performance` | Página, coleta compartilhada, diagnóstico de recursos, autorização e origem das métricas |
| Armazenamento `/storage` | Página, consumo, nuvem atual/anterior, exclusão local/remota, proteção e contratos de resposta |
| Mapa `/map` | Mapa geográfico, planta, localização, miniaturas, salvamento, escopo e responsividade |
| Investigação `/investigation` | Carregamento, troca de caso, edição, notas, preservação, eventos e relatório |
| Alarmes `/alarms` | Listagem, atualização, filtros, regras e destinos de notificação |
| Inteligência `/ia` e Revisão `/review` | Configuração global, feed compartilhado, filtros, paginação e permissões |
| Controle PTZ `/ptz` | Seleção, diagnóstico, movimento, parada e comunicação com operador |
| Auditoria `/audit-logs` | Listagem, busca, atualização aparente e paginação da API |
| Reprodução `/playback` | Complemento: carregamento paginado, cancelamento e exportação de clipe; vídeo já teve auditoria própria |
| `/wall`, `/events`, `/cameras/:id` | Rotas de compatibilidade: mural redireciona para ronda; eventos e editor legado não são páginas independentes a redesenhar |
| Ao Vivo, Câmeras e Perímetro | Relatórios específicos anteriores; não repetida a auditoria integral |
| Grupos, Funções, Configurações, Usuários, Minha conta, Novidades, Rondas e Mosaicos | Rodada administrativa anterior; conferidas as fronteiras de permissão compartilhadas |
| Login e recuperação de senha | Cobertura anterior de autenticação/app; sem nova auditoria integral nesta rodada |
| APK e Central técnica | Fora desta rodada de páginas web; dependências e separação de linguagem consideradas |

Referências anteriores: `auditoria-tecnica-2026-09-26.md`, `correcoes-auditoria-2026-09-26.md`, `correcoes-administracao-2026-09-28.md`, `correcoes-live-grid-2026-09-27.md`, `auditoria-perimetro-2026-09-26.md` e `auditoria-caminho-video-audio-2026-09-28.md`.

## Armazenamento

### ST-01 — P1 — Escopo vazio passa a consultar todas as câmeras

Evidência: `apps/api/src/recordings/recordings.service.ts:2242`, método `getStorageUsageAnalytics`; controller em `recordings.controller.ts:402`.

O controller calcula corretamente `getPlaybackCameraIds(user)`. Porém o serviço transforma `[]` em `cameraWhere = undefined` e omite o filtro de gravações, clipes e câmeras. Um usuário autenticado com permissão de reprodução, mas sem câmeras autorizadas ao histórico, pode receber nomes, grupos e consumo de outras câmeras. Não é necessário que tenha acesso à página Armazenamento: a rota aceita VIEWER com `playback`.

Reproduzido com o método compilado e Prisma simulado: entrada `accessibleCameraIds: []` produziu consulta sem `where.cameraId` e a resposta incluiu a câmera sintética fora do escopo.

Correção: distinguir ausência de escopo de escopo vazio; exigir escopo explícito no caminho público e retornar resultado vazio para `[]`. Critério: usuário sem câmeras e usuário com todos os grupos restritos recebem zero itens/totais; escopo parcial nunca revela câmera externa ou privada.

### ST-02 — P2 — Tabelas por câmera e grupo não recebem os dados esperados

Evidência: `StoragePage.tsx`, variáveis `cameraUsage`/`groupUsage`; `getStorageUsageAnalytics`, retorno.

A página lê `analytics.byCamera` e `analytics.byGroup`, mas a API retorna apenas `items` por câmera/dia e `summary`. Portanto pode mostrar consumo no resumo e “Nenhum uso encontrado” nas duas tabelas. O contrato divergente foi confirmado executando o método com dados sintéticos.

Correção: definir um contrato único com agregações por ID de câmera e ID de grupo, sem agrupar somente por nome. Critério: soma das tabelas coincide com o resumo; câmera sem grupo aparece corretamente; grupos homônimos permanecem distintos.

### ST-03 — P1 — Operações de nuvem ignoram a permissão configurável

Evidência: `apps/api/src/cloud-storage/cloud-storage.controller.ts`; `role-permissions/permissions.guard.ts`.

As operações de política, envio manual, esvaziamento e remoção exigem papel ADMIN, mas não usam `@RequirePermission`. O guard é transparente quando esse metadado não existe. Assim, retirar `serverConfig` de ADMIN não bloqueia essas ações na API. Os cartões também não verificam essa permissão.

Correção: vincular as operações à permissão apropriada e alinhar os controles da interface. Critério: ADMIN com permissão revogada recebe 403, sem chamada ao S3 nem alteração no banco; SUPER_ADMIN mantém a regra explícita do sistema.

### ST-04 — P1 — Exclusão remota não consulta proteção de evidências

Evidência: `cloud-storage-admin.service.ts:109` (`esvaziar`) e `:179` (`remover`), comparados a `recordings/retention.service.ts:392`.

A exclusão local consulta `assertGlobalPurgeAllowed`. O esvaziamento de armazenamento anterior percorre os objetos e os exclui sem consultar investigação/preservação; a remoção forçada pode retirar o cadastro necessário para acessar o acervo, também sem essa verificação. A confirmação digitada do bucket confirma intenção, mas não substitui a regra de proteção das evidências.

Correção: aplicar a proteção ao acervo remoto e à remoção do destino; impedir a perda da última cópia protegida. Critério: uma evidência preservada impede a operação antes da primeira exclusão remota. Validar também concorrência entre ativação da proteção e exclusão.

### ST-05 — P1 — Falha de exclusão remota elimina a referência do arquivo

Evidência: `cloud-storage-admin.service.ts:109`, laço de exclusão seguido de `recording.updateMany`.

O serviço contabiliza erros individuais do S3, mas ao final limpa `cloudKey` e `cloudUploadedAt` de todas as gravações do armazenamento. Arquivos que não foram apagados ficam sem a referência usada para reprodução, embora ainda existam no fornecedor. Reproduzido com S3 e Prisma simulados: uma exclusão que lança erro resulta em `falhas: 1` e mesmo assim executa a limpeza das referências.

Correção: atualizar somente objetos comprovadamente removidos, preservar falhas para retentativa e registrar progresso durável. Critério: falha parcial mantém acessíveis os objetos restantes; nova execução é idempotente; erro de banco após exclusão também tem reconciliação.

### ST-06 — P1 — Exclusão global não aplica o escopo de câmeras

Evidência: `recordings.controller.ts:238` e `recordings.service.ts:3316`.

O DELETE global exige ADMIN + `serverConfig`, mas não recebe nem verifica o conjunto de câmeras administráveis. O serviço consulta e apaga todas as gravações/clipes. Já a exclusão selecionada documenta e aplica a necessidade de validar cada câmera, inclusive privadas. A advertência visual de exclusão global não resolve essa diferença de autorização.

Correção: tornar a operação global exclusiva de uma autoridade global explicitamente definida ou limitar aos recursos autorizados. Critério: administrador sem autoridade sobre câmera privada não remove seu histórico por uma rota alternativa. O escopo da confirmação deve coincidir com o escopo efetivo.

### ST-07 — P1 — Exclusão global não garante pausa consistente de todos os produtores

Evidência: `recordings.controller.ts:238`, `recording-process-manager.service.ts:2892`, `recordings.service.ts:3316`.

No modo `worker`, `stopAll()` apenas registra aviso e retorna. Além disso, o serviço captura a lista de arquivos antes da transação e depois executa `deleteMany({})`. Uma gravação/clipe inserido entre a captura e a exclusão pode ter a linha apagada sem entrar no conjunto de arquivos preparado. A existência da janela é confirmada pelo código; sua ocorrência real não foi provocada. O modo worker não foi identificado como modo ativo da Vibe nesta rodada.

Correção: protocolo de pausa confirmado pelos produtores, trava coordenada e exclusão dos IDs efetivamente preparados; retomada definida para sucesso e falha. Critério: inserção concorrente não cria arquivo órfão nem perde metadados; falha no banco permite retomada e recuperação.

### ST-08 — P2 — Totais truncados e consulta pesada

Evidência: `getStorageUsageAnalytics`, duas consultas `take: 100000`, sem ordenação ou sinal de truncamento.

O resultado deixa de representar o total quando o intervalo supera esse limite. Até 200 mil registros são materializados para agregar em memória por requisição. Não foi medido gargalo atual, mas o truncamento é determinístico acima do teto.

Correção: agregar no banco, validar intervalo e informar explicitamente qualquer limite. Critério: base sintética acima de 100 mil segmentos mantém total exato e uso de memória controlado.

### ST-09 — P2 — Datas, estados e informações técnicas inadequados

Evidência: `StoragePage.tsx`, efeito de consulta, tabela Volumes, `StorageSection` e cartões de consumo.

Limpar um campo de data chama `toISOString()` sobre data inválida antes da cadeia de tratamento da requisição. Datas invertidas não são validadas; limites são construídos em UTC, enquanto o cliente pode esperar seu dia local. Hostname, diretório físico e “Local FS” aparecem na tela do cliente. O resumo “linha(s)” revela a estrutura interna da agregação. A seção expansível não informa `aria-expanded`; os campos de data não têm rótulos explícitos. Falta distinguir disco total usado de consumo das gravações e retenção configurada de histórico efetivamente disponível.

Correção: validar antes de consultar; adotar fuso declarado e coerente; usar “Armazenamento local”, “Consumo no período” e “Prazo configurado para manter gravações”; identificar carregamento/erro separadamente de zero. Critério: apagar data não derruba a página; nenhuma informação de infraestrutura é necessária ao usuário comum.

## Desempenho

### PF-01 — P2 — Indicador de processamento não mede utilização de CPU

Evidência: `PerformancePage.tsx:135`, cálculo de `cpu`; `health.service.ts:179` retorna `os.loadavg()`.

A tela usa carga média de um minuto dividida por núcleos e apresenta percentual de processamento “agora”. Carga média inclui tarefas esperando execução e, no Linux, espera não interrompível; não equivale ao percentual de CPU consumida. O teto em 100 também esconde a intensidade de sobrecarga. RAM calculada por total menos memória livre não distingue memória reaproveitável.

Correção: medir CPU por diferença de contadores em intervalo conhecido e definir se a métrica representa host ou contêiner; usar memória disponível para capacidade operacional. Se conservar carga média, identificá-la como tal. Critério: comparar amostras sincronizadas com métricas do host, sem exigir igualdade com ferramentas que usam janelas diferentes.

### PF-02 — P2 — Operador entra em páginas cujos indicadores não pode consultar

Evidência: `App.tsx:362`, `:368`; `vmsDataStore.ts:596`; `health.controller.ts`, rota `system`.

Desempenho e Armazenamento aceitam operador, mas a store só solicita saúde do host para administrador e a API exige ADMIN. Desempenho assume zero quando `system` está ausente, inclusive RAM “0 / 0 GB”. Armazenamento também calcula 0% na ausência dos dados. Não é necessário ampliar o acesso do operador a informações técnicas para resolver isso.

Correção: definir uma visão operacional reduzida autorizada ou restringir os cartões/página; mostrar “Indisponível para seu acesso” em vez de zero. Critério: testar VIEWER, OPERATOR, ADMIN com permissões limitadas e SUPER_ADMIN.

### PF-03 — P2 — Atualização pesada e estado antigo sem identificação local

Evidência: `PerformancePage.tsx:144` e efeitos seguintes; `vmsDataStore.ts:603`; `stream-resource-advisor.service.ts:72`.

Cada ciclo chama `load()` geral, que busca até dez recursos, além de saúde de IA e diagnóstico. O diagnóstico constrói relatórios de todas as câmeras permitidas. O temporizador continua quando a aba está oculta. As duas consultas adicionais não possuem timeout/cancelamento local; erros viram `null` e os dados anteriores permanecem sem carimbo próprio. Uma chamada pendurada mantém `refreshRef` ocupado. O botão “Pausado” pausa esse temporizador, mas não congela mudanças da store compartilhada.

Correção: endpoint/resumo leve, atualização visível, timeout, cancelamento, dados com horário e aviso de falha; esclarecer “Atualização automática pausada”. Critério: aba oculta não gera esse ciclo; falha de IA não aparenta leitura atual; repetir atualização não acumula consultas. Não foi quantificada redução de CPU nesta rodada.

## Mapa

### MP-01 — P2 — Câmera muda de lugar ao salvar a planta

Evidência: `site-map-layouts.service.ts`, `sanitizeMarkers`; `MapPage.tsx`, `placeMarker`.

O cliente permite Y até 99%, mas o servidor limita Y a 70%. Reproduzido: `{xPct:40,yPct:95}` volta como `{xPct:40,yPct:70}`. Os 30% inferiores da planta não são preservados.

Correção: unificar os limites de coordenadas. Critério: salvar e reabrir marcadores nos quatro cantos e no centro preserva as posições dentro da tolerância definida.

### MP-02 — P2 — Coordenadas vazias são salvas como zero

Evidência: `components/CameraLocationDialog.tsx`, função `save`.

`Number('')` resulta em zero. Deixar os dois campos vazios passa nas validações de faixa e pode salvar a câmera em 0,0; um campo vazio e outro preenchido também produz localização incorreta. O teste existente contra 0,0 cobre outro trecho do mapa, não esse diálogo.

Correção: validar presença antes da conversão; se remover localização for permitido, oferecer ação explícita que grave `null`. Critério: campos vazios, espaços, vírgula decimal, valores extremos e zero legítimo têm resultados distintos e corretos.

### MP-03 — P1 — Atualização da câmera pode sobrescrever localização em edição

Evidência: `CameraLocationDialog.tsx`, efeito dependente de `[camera]`; `vmsDataStore.ts`, reconstrução das câmeras.

O diálogo repõe endereço e coordenadas sempre que muda a referência do objeto câmera. Uma atualização da store durante a digitação pode descartar o rascunho. Respostas de geocodificação também não são vinculadas à geração do formulário e podem chegar após trocar de câmera.

Correção: inicializar pela identidade da câmera/abertura, preservar campos modificados e descartar respostas antigas. Critério: atualizar o estado operacional não muda texto digitado; resultado da câmera A nunca preenche o formulário B.

### MP-04 — P2 — Descoberta automática entra em repetição após falha

Evidência: `MapPage.tsx:198`, `discoverLocations` e efeito dependente de `autoLocating`.

`autoLocationDone` só é marcado em sucesso. Ao falhar, `finally` altera `autoLocating` para false e o efeito tenta de novo imediatamente. Com permissão negada, rede falhando ou limite da API atingido, isso repete POSTs. O backend limita essa rota a três chamadas por minuto, mas o cliente continua tentando. Abrir o mapa também inicia alteração de localização automaticamente para administrador.

Correção: limitar tentativas, aplicar espera progressiva e preferir descoberta explícita com quantidade de câmeras afetadas; considerar o resultado do servidor. Critério: 403/429/queda de rede não gera laço; tentar novamente é uma ação controlada.

### MP-05 — P1 — Troca de unidade/andar pode salvar rascunho no destino errado

Evidência: `MapPage.tsx`, seletores de unidade/andar, efeito de `draftMarkers`, consulta de layouts e `saveLayout`.

Os seletores continuam ativos durante edição. O rascunho não é atualizado enquanto `editing` é true, mas o salvamento usa o `siteId` e `floor` atuais. Assim, posições originadas na unidade A podem ser enviadas à B. A resposta de carregamento de uma unidade anterior também pode alterar o andar atual. O serviço sanitiza coordenadas, mas não valida se os IDs das câmeras pertencem à unidade.

Correção: vincular rascunho a unidade/andar, proteger saída com alterações, cancelar respostas antigas e validar vínculos no servidor. Critério: alternar A/B com latências invertidas não mistura planta, andar nem marcadores.

### MP-06 — P2 — Acesso à planta expõe todos os marcadores da unidade

Evidência: `site-map-layouts.controller.ts:24` e `site-map-layouts.service.ts`, `assertCanViewSite`/`list`/`getByFloor`.

Ter acesso a uma câmera autoriza ver a unidade; a resposta então retorna o objeto completo de marcadores. A filtragem de câmeras na renderização não remove IDs/posições de câmeras não autorizadas da resposta HTTP. A edição da planta exige ADMIN, mas não `cameraConfig`.

Correção: filtrar marcadores pelo conjunto autorizado e aplicar permissão à escrita. Definir separadamente quem pode receber a planta física completa. Critério: usuário de uma câmera não recebe marcadores privados; ADMIN com `cameraConfig` revogada não altera a planta.

### MP-07 — P2 — Filtros e miniaturas não acompanham o mapa visível

Evidência: `MapPage.tsx`, `filteredPanelCameras`, propriedades de `GeographicCameraMap`, `loadSidebarPosters` e seu efeito.

Busca, grupo, zona e estado filtram a lateral, mas o mapa recebe todas as câmeras habilitadas. As miniaturas também usam todas as câmeras do painel. A função de carregamento depende do array reconstruído da store, podendo renovar tokens antes do intervalo de quatro minutos. Não há cancelamento de respostas nem escuta de mudança do breakpoint: abrir em tela estreita e ampliar pode deixar a lateral sem miniaturas até outra dependência mudar.

Correção: tornar explícito se o filtro atua na lista ou em todo o mapa; usar IDs estáveis e carregar miniaturas visíveis. Critério: filtro tem efeito previsível e atualização de status não reemite todos os tokens.

### MP-08 — P2 — Edição móvel, acessibilidade e envio de planta incompletos

Evidência: `MapPage.tsx`, lateral `hidden ... xl:flex`, modal de vídeo em `div`, `uploadSvg`, imagem `object-fill`; `GeographicCameraMap.tsx`, altura mínima 420px.

Em telas menores que 1280px não existe alternativa à lista/busca lateral; uma câmera sem posição fica difícil de localizar e editar pelo mapa. A ação de localização no modal também some abaixo de `sm`. O modal de vídeo não oferece as garantias de foco/Escape de um Dialog. Enviar SVG salva imediatamente e encerra edição, embora haja botão separado “Salvar posições”; não há validação local de tamanho nem tratamento de erro do FileReader. A imagem é esticada para preencher proporções diferentes. O servidor valida prefixo/tamanho da Data URL, não a estrutura do SVG; isso é lacuna de validação, não comprovação de XSS, pois a renderização atual usa `img`.

Correção: lista móvel recolhível, modal acessível, upload como rascunho com prévia/limites, proporção preservada com coordenadas na área efetiva da imagem. Critério: operar a 360px e por teclado; arquivo inválido recebe mensagem antes de salvar; posição permanece correta ao redimensionar.

## Investigação

### IN-01 — P1 — Atualizações gerais e busca podem apagar edição do caso

Evidência: `InvestigationPage.tsx:144`, `loadInvestigations` depende de `cameras`, filtros e cliente; em todo sucesso chama `hydrate`.

Atualizar câmeras recria a função e recarrega os casos; a resposta preenche novamente título, período, câmeras e evidências. Uma busca também pode substituir a edição pelo primeiro caso retornado. Se o ID solicitado não estiver na lista, a tela escolhe outro caso silenciosamente. “Nova área de trabalho” não limpa o ID antigo da URL.

Correção: separar consulta de lista, seleção e rascunho; carregar ID solicitado diretamente; proteger alterações não salvas e limpar URL ao criar. Critério: refresh, busca e renovação de sessão preservam rascunho; caso inexistente não abre outro como se fosse o solicitado.

### IN-02 — P1 — Respostas de casos diferentes podem se misturar

Evidência: `InvestigationPage.tsx:179`, carregamento de notas, atividade, preservação, custódia e fechamento; `reportHtml`.

As cinco consultas não possuem cancelamento nem identificação de geração. Ao alternar A/B rapidamente, respostas tardias de A podem aparecer sob B. O relatório HTML anterior só é limpo quando não há investigação, não quando muda entre casos válidos. Erro ao consultar preservação aparece como preservação desligada, embora o estado real seja desconhecido.

Correção: vincular cada resposta ao ID ativo, invalidar conteúdo na troca e representar preservação não consultada como indisponível. Critério: atrasar seletivamente respostas não mistura notas, relatório ou proteção; erro não afirma que evidência está desprotegida.

### IN-03 — P2 — Busca de eventos usa apenas a amostra recente da store

Evidência: `InvestigationPage.tsx:238`, `trackEventsTotal`; `vmsDataStore.ts:608`, eventos com `limit=100`.

A seleção do período filtra somente eventos já carregados globalmente, não consulta o histórico do período/câmeras. Mesmo o “total” antes do corte visual de 40 continua limitado à amostra recente. Um período antigo pode aparentar ausência de ocorrências existentes.

Correção: consultar eventos por período/câmeras com paginação e contagem apropriada. Critério: evento antigo fora dos 100 globais é encontrado; diferenciar itens carregados do total.

### IN-04 — P2 — Datas inválidas e notas sem estado de salvamento

Evidência: `InvestigationPage.tsx:256`, `saveWorkspace`; `:369`, `updateEvidenceNotes`.

O payload converte datas antes do `try`, após `setSaving(true)`; data vazia lança erro e pode deixar “Salvando” preso. Notas são alteradas localmente e salvas ao sair do campo; falha só mostra toast, sem diferenciar rascunho de persistido nem retentativa por item.

Correção: validar datas/período antes de entrar em salvamento; notas com confirmação de persistência e retentativa. Critério: data inválida não bloqueia a tela; nota recusada permanece claramente pendente.

### IN-05 — P2 — Listagem de casos continua sem paginação e cresce no servidor

Evidência: `investigations.service.ts:126`.

A correção anterior passou os filtros para antes do corte, resolvendo o achado antigo específico. Porém o método ainda carrega todos os casos elegíveis com itens, filtra metadados em memória e retorna os primeiros 50, sem cursor/total. Isso limita navegação e aumenta custo com crescimento do acervo.

Correção: paginação real com resumo leve, detalhe sob demanda e filtros compatíveis com o banco. Critério: caso 51 é alcançável sem adivinhar texto; custo de listar não depende de materializar todas as evidências.

## Inteligência e Detecções

### DE-01 — P2 — Troca de filtro durante carregamento é perdida

Evidência: `components/PainelDeDeteccoes.tsx:114`, `busy.current`, `load`, `loadMore` e efeito.

Se o usuário muda o filtro enquanto há consulta, a nova chamada retorna imediatamente porque `busy` está true. A resposta antiga preenche a lista, e liberar `busy` não agenda consulta para o filtro atual. Em “Carregar mais”, isso também permite manter itens de contexto anterior. Falha de paginação é silenciosa.

Correção: geração por filtros, cancelamento/consulta substituta e erro explícito de paginação. Critério: filtros rápidos A/B/C terminam em C, incluindo mudança durante “Carregar mais”; conteúdo não mistura filtros.

### DE-02 — P2 — Controle de marcação global é oferecido a quem não pode salvá-lo

Evidência: `AiPage.tsx:89`; `ai.controller.ts:102`.

A página aceita operador e oferece o botão que altera `/ai/settings`; o endpoint exige ADMIN + `serverConfig`. A interface altera otimisticamente a preferência e depois desfaz ao receber 403. O texto também não deixa claro que a configuração é global da instalação, não apenas preferência pessoal.

Correção: distinguir preferência individual de configuração global e oferecer escrita somente a quem pode executá-la. Critério: operador não experimenta um liga/desliga que inevitavelmente falha; alcance da mudança fica explícito.

## Alarmes

### AL-01 — P2 — Apenas os primeiros 200 alarmes são alcançáveis

Evidência: `AlarmsPage.tsx:400`, pedido `limit:300, offset:0`; `alarms.service.ts:338`, teto 200.

A página não pagina nem usa o total retornado. Busca textual e contadores operam só sobre esse subconjunto. Portanto alarmes existentes podem não ser encontrados sem filtros adicionais.

Correção: filtros no servidor e paginação/cursor; contadores globais separados da página carregada. Critério: bases acima de 300 alarmes permitem alcançar todos e localizar texto fora da primeira página.

### AL-02 — P2 — Consultas antigas podem substituir o filtro atual

Evidência: `AlarmsPage.tsx:393–444`, `loadAlarmsList` e dois efeitos.

Existe trava apenas entre atualizações de fundo. Atualização inicial por filtro/câmeras pode concorrer com outra e com a de fundo; nenhuma resposta verifica geração. O cliente não define timeout. A lista pode mostrar resultado de filtros anteriores ou manter carregamento indefinido.

Correção: coordenar todos os carregamentos, manter identificação do filtro e cancelar requisições substituídas. Critério: respostas em ordem inversa não alteram o filtro efetivamente apresentado.

### AL-03 — P2 — Apagar destino de notificação no formulário não o remove

Evidência: `AlarmsPage.tsx:589`, `saveRule`; `alarms.service.ts:642`.

Campos vazios de webhook/e-mail viram `undefined`, são omitidos do JSON e o backend interpreta como “não alterar”. O usuário apaga o destino e salva, mas o destino anterior permanece. A edição também separa atributos e habilitação em dois PATCHs, permitindo resultado parcial em falha do segundo.

Correção: usar representação explícita de remoção e atualização atômica. Critério: limpar destino persiste vazio após recarregar e impede novos envios para o destino removido.

### AL-04 — P1 — Listagem geral de alarmes ignora privacidade para administradores

Evidência: `cameras.controller.ts:465`, `listAlarms`; `access-control.service.ts:29`, regra de câmeras privadas.

Quando não há filtro de câmera, a rota usa todos os IDs de `camerasService.findAll()` para ADMIN/SUPER_ADMIN em vez de `getAccessibleCameraIds`. O serviço de controle de acesso exclui câmeras privadas sem vínculo mesmo para esses papéis. Como a resposta de alarmes inclui câmera, mensagem e ocorrências, a listagem geral pode revelar metadados de câmera privada que a consulta individual recusaria.

Correção: aplicar o mesmo escopo de privacidade na listagem, nos contadores e nos filtros. Critério: administrador não proprietário não recebe alarme nem contagem de câmera privada; proprietário e compartilhamento autorizado continuam funcionando. Não foi consultado conteúdo privado real para demonstrar o achado.

## Controle PTZ

### PT-01 — P2 — Seleção e ações não refletem capacidade/permissão

Evidência: `PTZPage.tsx:95`, `ptzCameras` inclui todas as habilitadas; `controlsDisabled` testa somente seleção; `ptz.controller.ts` valida `ptzControl` e acesso individual.

O texto declara que aparecem apenas câmeras que confirmaram PTZ, mas a lista contém todas as habilitadas. Usuário sem controle pode receber os mesmos botões até a API rejeitar. Diagnóstico fica no estado da página sem reset por câmera, podendo continuar visível após trocar seleção.

Correção: separar “câmeras controláveis” de “verificar capacidade”, respeitar capacidades efetivas e atrelar diagnóstico à câmera. Critério: câmera fixa ou sem autorização não parece pronta para movimento; resultado de A não é exibido como diagnóstico de B.

### PT-02 — P2 — Parada depende do pedido local, não da possibilidade de movimento

Evidência: `PTZPage.tsx:192`, `stopMove`; botão `disabled={!activeDirection}`; comando `home`; `lib/ptz.ts`.

Ao concluir/falhar o pedido de passo, a referência de movimento é apagada e a parada deixa de poder ser enviada. “Posição inicial” não cria essa referência. Se o equipamento continuar movendo após retorno incerto, a interface não oferece uma parada independente. Os pedidos de comando/diagnóstico não têm timeout do cliente. O backend já usa passos e proteções próprias: não foi demonstrado movimento físico descontrolado.

Correção: parada explícita para câmera autorizada, independente da promessa local; limites de espera e estado “não confirmado”. Critério: ensaio com câmera de teste/simulador permite parar após falha de resposta e após “Posição inicial”; nunca reenviar movimento automaticamente sem contexto.

## Auditoria

### AU-01 — P2 — Busca cobre só 100 registros e horário de atualização é artificial

Evidência: `AuditLogsPage.tsx:17`, filtro local e `new Date()` no rótulo; `vmsDataStore.ts:614`.

Todos os filtros operam nos últimos 100 registros da store. A API tem paginação, mas a página não a usa. “Atualizado em” mostra a hora do render, inclusive ao digitar na busca, e não a hora da última consulta bem-sucedida. Não há estado local de erro/recarga.

Correção: paginação e filtros remotos, carimbo real e erro por recurso. Critério: registro 101 é encontrado; digitar não altera a data de sincronização.

### AU-02 — P2 — Limites de consulta da API não são validados

Evidência: `audit.controller.ts`, `parseInt` de limit/offset; `audit.service.ts:68`, uso direto em `take`/`skip`.

ADMIN com `auditLogs` pode pedir limites muito altos; valores inválidos/negativos não têm validação dedicada. A exportação corta em 10 mil sem contrato de paginação visível nesse método. São riscos de consulta excessiva e relatório incompleto, não exposição pública demonstrada.

Correção: DTO com faixas, ordenação estável e exportação paginada/job quando necessária. Critério: parâmetros inválidos retornam 400 e intervalos grandes têm limite explícito ou exportação completa controlada.

## Reprodução — complemento

### PB-01 — P2 — Carregamento abandonado pode continuar paginando

Evidência: `PlaybackPage.tsx:383`, `fetchAllPages`, e `:945`, `loadWholeDay`.

A proteção `cancelled` impede aplicar o resultado ao estado, mas o laço de paginação não recebe AbortSignal nem condição de cancelamento. Na alternativa de dia inteiro, trocar câmera/dia pode manter buscas do contexto abandonado consumindo API. Isso não invalida as proteções de geração já presentes no player.

Correção: propagar cancelamento pelo laço/requisições. Critério: alternar câmeras/dias encerra paginação antiga; cancelamento não aparece como falha operacional.

### PB-02 — P2 — Motivo de exportação é preenchido automaticamente

Evidência: `PlaybackPage.tsx:2654`, `notes: Exportado da reprodução em ...`; `recordings.controller.ts:741` usa `dto.notes` como motivo obrigatório.

O caminho “Exportar trecho” registra uma frase automática com data como justificativa, embora a política do endpoint exija motivo. O download posterior pede motivo, mas isso não corrige o registro da criação/exportação do clipe.

Correção: pedir motivo claro no mesmo fluxo e compartilhá-lo com exportação/auditoria, sem confundir notas descritivas com justificativa. Critério: auditoria contém motivo informado pelo operador, não apenas horário; não exportar duplicado ao repetir confirmação.

## Clareza e apresentação transversal

### UX-01 — P3 — A simplificação de linguagem ainda não chegou a todos os fluxos

Evidências: `PerformancePage.tsx` (confirmação com IP/RTSP/ONVIF e “Ajustar seguro”); `StoragePage.tsx` (host/diretório/Local FS/linha); `AuditLogsPage.tsx` (“backend”, IDs e ações cruas); `InvestigationPage.tsx` (“persistida no backend”, status interno); `PTZPage.tsx` (IP e orientação de portas ao usuário).

Proposta para o cliente: “Aplicar ajustes recomendados”, “Armazenamento local”, “Histórico de atividades”, “Investigação salva”, estados traduzidos e instrução acionável conforme permissão. Diagnósticos de infraestrutura completos devem ficar na Central/equipe técnica. Em Auditoria, usar nome de usuário e ação legível, mantendo identificador disponível em detalhe para quem precisa.

Há muitos textos de 9–11px, tabelas extensas e informações auxiliares concorrendo com ações principais. Usar detalhes recolhíveis, rótulos legíveis, erros perto da ação e estados separados: carregando, vazio, sem permissão, indisponível e desatualizado. Evitar promessas como “a visualização continua funcionando” quando o próprio diagnóstico pode incluir falhas recentes.

Critério: revisão autenticada em 360px, 768px e desktop; teclado, foco, leitores de tela e contraste nos temas/personalizações reais. Não se atribui aprovação visual a partir apenas do código.

## Verificações realizadas

1. Leitura cruzada das páginas, componentes, store, rotas e serviços acima, comparando com os relatórios anteriores.
2. Execução dos métodos compilados com dependências simuladas via `Object.create(Service.prototype)`: escopo vazio sem filtro; resposta sem `byCamera`/`byGroup`; Y=95 convertido em Y=70; erro de exclusão S3 seguido de limpeza de referências. Asserções passaram, confirmando esses comportamentos defeituosos. Nenhuma dependência real de banco/S3 foi instanciada nesses ensaios.
3. Execução isolada, com montagem somente leitura e rede desativada, de `camera-map-location.test.mts`, `posicao-no-mapa.test.mts` e `ptz-friendly-control.test.mts`: **23 testes passaram**. Há testes de estrutura textual e testes de lógica; aprovação não representa teste ponta a ponta dos formulários.
4. Não foram executadas exclusões reais, testes de perda de energia, carga em produção, comandos físicos PTZ, nem validação autenticada de navegador. Não foram refeitas todas as suítes do projeto: esta rodada não mudou código executável.

## Ordem de correção e aceite

1. **Autorização e acervo:** ST-01, ST-03 a ST-07, MP-06 e AL-04. Usar base isolada com câmeras privadas, usuários sem escopo, evidências protegidas e fornecedor S3 simulado com falhas parciais. Nenhum teste destrutivo em produção.
2. **Contratos e persistência:** ST-02/ST-08/ST-09, MP-01/MP-02/MP-03/MP-05 e IN-01/IN-02/IN-04. Incluir testes de contrato e respostas fora de ordem.
3. **Consultas e controle:** PF-01 a PF-03, MP-04/MP-07, IN-03/IN-05, DE-01/DE-02, AL-01 a AL-03, PT-01/PT-02, AU-01/AU-02 e PB-01/PB-02.
4. **Interface final:** MP-08 e UX-01, validando os mesmos fluxos com conta de cliente e conta técnica, temas reais e telas menores.

Cada item deve ser fechado com evidência própria: alteração de código, teste do cenário e, quando aplicável, verificação visual ou física. Testes gerais passando e serviços saudáveis não substituem esse aceite. O relatório não declara as páginas totalmente livres de falhas; documenta os achados comprovados e as condições que ainda exigem validação.
