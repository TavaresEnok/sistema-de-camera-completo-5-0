# Auditoria técnica sistêmica — S2Cam / DRAC

Data: 26/09/2026, UTC. Referência: commit `ff6114d205e9efde67018e03e38f3e21b5e575eb`, branch `migration/repository-5-0`, workspace `/opt/drac`.

Solicitação: [roteiro de auditoria](roteiro-auditoria-tecnica-profunda.md). Esta é a fase de diagnóstico: **nenhuma correção de aplicação, alteração de configuração, atualização de servidor ou implantação foi realizada nesta auditoria**. Os arquivos deste relatório são a entrega documental autorizada. Testes com escrita usaram dados sintéticos e ambientes descartáveis, não o banco operacional.

## 1. Resumo executivo e matriz de achados

O sistema possui mecanismos relevantes de proteção: autorização centralizada na API, rotação de refresh tokens, validação de caminhos de arquivos, diário de exclusão, locks para operações de gravação, confirmação de upload antes da poda local, migrações versionadas e testes extensos. Entretanto, essas garantias não são uniformes entre notificações, autenticação web, Central e scripts operacionais.

Foram registrados **28 achados: 2 P0, 7 P1, 16 P2 e 3 P3**. A prioridade considera o impacto possível e não significa que todos os problemas estejam ativos em todos os servidores. Há bugs reproduzidos, riscos demonstrados por leitura de código e hipóteses explicitamente delimitadas.

Os principais bloqueadores para ampliar a frota são: perda de alterações concorrentes na Central; rollback que pode descartar alterações legítimas do banco; destinatários de push divergentes da autorização; e bloqueio global das rotas da Central por leitura de corpo de requisição. Não é recomendável considerar a implantação pronta para milhares de usuários apenas porque os containers estão saudáveis.

| ID | Severidade/prioridade | Tipo | Área | Problema | Impacto | Confiança |
|---|---|---|---|---|---|---|
| AUD-001 | P0 / crítica | Bug confirmado | Central | Instalação remota salva snapshot obsoleto fora da serialização | Perda de cadastros concorrentes | Alta; reprodução HTTP |
| AUD-002 | P0 / crítica | Risco demonstrado | Atualização | Rollback restaura dump anterior à parada dos writers, inclusive em falha de build/fetch | Perda de alterações válidas | Alta no fluxo; sem desastre real executado |
| AUD-003 | P1 / alta | Bug confirmado | Push / ACL | Destinatários não respeitam integralmente privacidade, usuário ativo e grupo | Divulgação indevida de metadados de alarmes | Alta; serviço exercitado com fixture |
| AUD-004 | P1 / alta | Bug confirmado, condicional | Central / datastore | Dual-read recupera registros excluídos do snapshot legado | Reaparecimento de usuários, sessões e instalações | Alta; merge reproduzido |
| AUD-005 | P1 / alta | Bug confirmado | Central / disponibilidade | Corpo incompleto ocupa fila global antes de autenticar | Bloqueio de operações da frota | Alta; reprodução HTTP |
| AUD-006 | P1 / alta | Bug confirmado por código | Restore | Topologia fixa, probes imediatos e ERR trap em readiness | Restore válido pode falhar ou sofrer rollback indevido | Alta; restore destrutivo não executado |
| AUD-007 | P1 / alta | Bug provável | Web / autenticação | Logout local pode ser revertido por refresh pendente ou posterior | Sessão reaparece em terminal compartilhado | Média-alta; sem teste de navegador |
| AUD-008 | P1 / alta | Bug confirmado | API / autenticação | Token de reset não é consumido atomicamente | Duas trocas de senha com o mesmo token | Alta; concorrência isolada |
| AUD-009 | P1 / alta | Risco / contrato divergente | Evidências | Exclusões administrativas não aplicam proteção de legal hold da retenção | Remoção de evidência preservada | Alta no código; política de override a decidir |
| AUD-010 | P2 / média | Bug provável | Web / sessões | Refresh concorrente sem single-flight e coordenação entre abas | Logout intermitente / estado incoerente | Média-alta |
| AUD-011 | P2 / média | Bug confirmado | S3 | Host assinado difere do host de virtual-host addressing | Falha de autenticação ou roteamento no storage | Alta; signer exercitado |
| AUD-012 | P2 / média | Bug confirmado | Offload | Flag de exclusão mútua é definida depois de await | Dois ciclos simultâneos de upload/poda | Alta; concorrência reproduzida |
| AUD-013 | P2 / média | Bug confirmado, condicional | Cookies / Compose | Variável vazia desabilita fallback Secure de produção | Cookie sem Secure em instalação mal configurada | Alta; não ativo no Vibe inspecionado |
| AUD-014 | P2 / média | Risco operacional | Central JSON | Lock em arquivo sobrevive à morte abrupta | Reinício exige intervenção | Alta; comportamento explícito |
| AUD-015 | P2 / média | Risco de observabilidade | Central / health | Health não comprova acesso ao datastore nem progresso da fila | Falso saudável operacional | Alta; observado no teste AUD-005 |
| AUD-016 | P2 / média | Risco de escala | Central / PostgreSQL | Leituras e escritas de snapshots completos sob fila global | Amplificação de I/O e latência | Alta no desenho; sem benchmark de frota |
| AUD-017 | P2 / média | Risco de disponibilidade | IA / ASGI | Handlers async executam joins síncronos | Event loop bloqueado durante parada | Alta no código; carga não simulada |
| AUD-018 | P2 / média | Risco operacional | API / ciclo de vida | Bootstrap não habilita shutdown hooks | Cleanup não garantido em SIGTERM | Alta no bootstrap |
| AUD-019 | P2 / média | Bug confirmado por código | Investigações | Filtra depois de limitar às 50 mais recentes | Busca omite casos existentes | Alta |
| AUD-020 | P2 / média | Bug confirmado | Testes / atualização | Teste exige URL literal substituída por função de bind | Suíte da API reprovada | Alta; teste executado |
| AUD-021 | P2 / média | Bug confirmado | Testes / RBAC | Fixture PostgreSQL omite username obrigatório | Oito testes não chegam à autorização | Alta; banco novo real |
| AUD-022 | P2 / média | Risco operacional | Redis / filas | Persistência não é definida explicitamente no Compose | Recuperação de jobs não garantida | Média-alta; sem teste de perda |
| AUD-023 | P2 / média | Dívida / risco | Dependências | Build da Central instala sem lockfile | Mesmo commit pode gerar dependências diferentes | Alta |
| AUD-024 | P2 / média | Risco de segurança | Python | python-multipart fixado em versão afetada por advisory | DoS se parser vulnerável for alcançável | Alta na versão; exploração atual não demonstrada |
| AUD-025 | P2 / média | Lacuna de testes | CI | bash -n com glob verifica só o primeiro script; outros gates incompletos | Falso senso de cobertura | Alta |
| AUD-026 | P3 / baixa | Dívida técnica | Arquitetura | Serviços e telas concentram responsabilidades | Alto custo de regressão e revisão | Alta |
| AUD-027 | P3 / baixa | Melhoria | Repositório | Cache gerado versionado e resíduos locais sem classificação | Ruído e risco de limpeza indevida | Alta na presença; remoção depende de validação |
| AUD-028 | P3 / baixa | Bug provável de teste | Central / benchmark | Teste de unidade de banda depende de tempo real estreito | Reprovação dependente do ambiente | Média; causa temporal não completamente isolada |

### Veredito operacional

O Vibe respondeu saudável na amostra observada, mas saúde instantânea não demonstra ausência de falhas de concorrência, autorização ou recuperação. A revisão **não certifica** que IBTelecom, Demo, Management e Gateway estejam atualizados ou equivalentes ao Vibe: não houve nova inspeção SSH dessas máquinas nesta execução. Também não certifica que o commit local seja o último disponível no Git remoto. Essas afirmações exigem coleta de referências remotas e versões por host.

## 2. Base de evidência, método e limites

### Escopo efetivamente percorrido

Foram cruzados entrypoints, módulos, controllers, serviços, consumidores, Prisma, migrations, Dockerfiles, Compose, scripts, testes, autenticação web/mobile, Central, processamento de vídeo e IA. A análise foi orientada por fluxos, não por contagem de arquivos abertos. O repositório tem 1.394 arquivos versionados; a existência de cobertura automatizada não equivale a revisão linha a linha de todos eles.

Foram usados containers isolados com código montado somente para leitura. Testes unitários rodaram sem acesso à rede externa; integrações PostgreSQL usaram um banco temporário exclusivo, sem conectar aos dados operacionais. Dependências vieram das imagens locais existentes, não de uma instalação limpa integral do lockfile. Essa diferença limita a equivalência com o CI.

Consultas de produção foram somente leitura: saúde, versão, contagens agregadas e migrations. Não foram coletados nomes de clientes, senhas, tokens, imagens, gravações ou conteúdo de mensagens para este documento. As credenciais fornecidas na conversa não foram copiadas ao repositório.

### Estado local observado

Na amostra de 26/09/2026 às 15:06 UTC:

- Commit local e `DRAC_VERSION`: `ff6114d205e9efde67018e03e38f3e21b5e575eb`.
- Ambiente de produção, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`, `RECORDING_CONTROL_MODE=local` e offload configurado a cada 15 minutos.
- Banco operacional: 64 migrations aplicadas, 35 câmeras cadastradas e 1.411 registros de gravação naquele instante. Contagens variam com o uso e não comprovam integridade de cada arquivo.
- `/health/ready` respondeu pronto para banco, schema, Redis, storage, MediaMTX e IA.
- Containers de API, web, PostgreSQL, Redis, MediaMTX, IA, ingestão RTMP e callback estavam saudáveis; processos de backup estavam em execução.
- Nenhum reinício de serviço operacional foi solicitado pela auditoria.

### Validações executadas

| Verificação | Resultado | Interpretação |
|---|---|---|
| API, `tests/*.test.ts` | 1.617 testes: 1.616 passaram, 1 falhou, 0 pulados | Falha AUD-020; duração aproximada 573 s |
| TypeScript da API | `tsc --noEmit --incremental false`: exit 0 | Código atual com dependências da imagem local |
| Web, testes Node | 528 passaram, 0 falhas, 0 pulados | Não substitui navegador, vídeo real ou acessibilidade |
| Mobile, testes Node/TS | 102 passaram, 0 falhas, 0 pulados | Não houve build nem execução em aparelho |
| IA Python, unittest | 323 passaram | Stack da imagem local; não é benchmark de acurácia nem validação GPU |
| Central, suíte geral | 510: 489 passaram, 8 falharam, 13 pulados | Duas execuções com a mesma distribuição; causas discriminadas abaixo |
| Central, PostgreSQL dedicado | 13 passaram | Suites de datastore e timeseries/heartbeat; cobrem os 13 antes pulados |
| API, e2e PostgreSQL dedicado | 11: 3 passaram, 8 falharam | Locks passaram; fixture RBAC inválida, AUD-021 |
| Prisma, banco vazio descartável | 64 migrations aplicadas | Não certifica upgrade de todas as bases históricas |
| Sintaxe shell | Loop com `bash -n` por arquivo passou | Scripts principais, testes shell e scripts de infra/management |
| Whitespace | `git diff --check` sem erro | Não é análise funcional |
| Provas dirigidas | Concorrência Central, reset, offload; dual-read; cookie; push; S3; fila HTTP | Detalhadas nos achados |

As oito falhas da suíte geral da Central não são oito bugs de produto: seis exigiam `/bin/bash`, ausente na imagem de execução; uma lia `public/index.html` com diretório corrente incorreto; uma dependia do tempo real da medição S3. A releitura do teste comercial no diretório correto passou. A repetição dos cinco testes de performance, junto do comercial, terminou com cinco aprovações e uma falha de banda (AUD-028). Os seis testes que dependem de Bash não foram revalidados nesse harness. Não somar retestes a suites originais como se fossem casos diferentes.

Tentativas iniciais com caminho incorreto do loader TSX ou diretório sem tsconfig foram erros do harness, corrigidos antes dos resultados da tabela. Não foram classificados como falhas do projeto.

### O que esta execução não provou

Não houve execução integral de `pnpm verify`, build limpo de todas as imagens, lint global, typecheck web/mobile, testes Go, navegador real, teste RTSP completo com fonte sintética, E2E em aparelho, pentest externo, auditoria de todas as transitivas ou teste de desastre em produção. Não houve medição de p95/p99 sob milhares de usuários, validação física de GPU, restauração integral de backup operacional, varredura do histórico Git por segredos ou conferência atual das ACLs de nuvem.

## 3. Arquitetura encontrada

### Componentes e responsabilidades

| Camada | Implementação | Responsabilidade e fronteira |
|---|---|---|
| Monorepo | pnpm 9.15, TypeScript/JavaScript/Python/Go | Aplicações, serviços, infraestrutura e scripts compartilhados |
| API local | NestJS 10, Prisma 5.22, Node, BullMQ 5 | Usuários, permissões, câmeras, gravações, evidências, jobs, configuração e comunicação com a Central |
| Web | React 18, Vite 6, Zustand, TanStack | Operação, visualização, playback, configurações e investigações |
| Mobile | Expo 54, React 19, React Native 0.81 | Acesso móvel e notificações; armazenamento seguro de credenciais e migração do legado |
| Banco local | PostgreSQL 16 | Estado persistente, relações, permissões, evidências, auditoria e sessões |
| Fila/cache | Redis 7 + BullMQ | Jobs, agendamento e coordenação assíncrona |
| Vídeo | MediaMTX, FFmpeg, SRS e coturn | RTSP, ingestão RTMP, WebRTC/WHEP, HLS, relay e gravação |
| IA | FastAPI, OpenCV, ONNX Runtime, OpenVINO, supervision | Captura, movimento, objetos, faces, regiões e tracking |
| Worker alternativo | Go 1.22 | Controle legado de gravação, condicionado ao modo de execução |
| Central | Node HTTP/JS, UI própria, PostgreSQL/JSON/dual | Frota, licenças, versões, configuração, heartbeat, instalação remota e integrações comerciais |
| Gateway | nginx/TLS + vídeo/relay conforme topologia | Entrada pública e roteamento por domínio para instalações |
| Operação | Compose, scripts shell, jobs de backup, GitHub Actions | Instalação, atualização, rollback, restore, readiness e validação |

O diagrama fornecido pelo usuário representa Gateway e Management na rede privada e Vibe externo. O código e as configurações versionadas são compatíveis com esse desenho, mas não substituem a inspeção atual de NAT, firewall e roteamento de cada máquina.

### Fronteiras importantes

Cada instalação mantém seu próprio banco, processamento, acervo e API. A Central não é a API local das câmeras: administra a frota e recebe estado agregado. Misturar os serviços de Central e tenant durante restore viola essa divisão, como em AUD-006.

O vídeo pode seguir um caminho diferente da interface HTTPS. Um painel acessível não prova que WebRTC/UDP, TURN, RTSP de origem ou HLS estejam acessíveis. A captura depende da rede que alcança a câmera; não se deve abrir indiscriminadamente banco, Redis, IA ou administração MediaMTX para resolver falhas de vídeo.

No modo local observado, a API coordena FFmpeg. O worker Go legado não é simplesmente código morto: há um perfil e um modo de operação próprios. Ativar ambos sem respeitar o controle de modo cria risco de dois controladores para a mesma câmera; a revisão identificou testes de proteção dessa configuração, sem executar o serviço Go nesta rodada.

### Inventário funcional

Na API foram identificadas famílias de controllers para: autenticação, usuários, permissões por papel/câmera, grupos, sites, áreas, mapas, câmeras, descoberta RTMP, streaming, PTZ, gravações, evidências, investigações, revisão, alarmes, notificações, layouts, rondas, chat de grupo, configurações, integridade, auditoria, IA, GPU, cloud storage/conector, política comercial, métricas, observabilidade e saúde.

Jobs identificados: checagem de câmera, limpeza de gravações, exportação de gravação, exportação de evidências, thumbnails, notificação de alarme, recibos de push e offload para nuvem. A existência de retries não assegura que todos sejam idempotentes em crash; a concorrência de offload foi testada especificamente em AUD-012.

Não foi encontrado um canal SSE/WebSocket para atualizar o estado operacional da interface. `apps/web/src/App.tsx` usa polling de 12 segundos e eventos de visibilidade/foco. A ocorrência de “WS-Security” em testes de ONVIF não equivale a WebSocket da interface.

O inventário de models, endpoints e arquivos por camada está em [inventário complementar](auditoria-inventario-2026-09-26.md). Ele é um mapa de navegação, não uma alegação de cobertura integral de cada implementação.

## 4. Fluxos principais e invariantes

| Fluxo | Caminho real | Invariante que precisa valer |
|---|---|---|
| Login web | React → auth API → User/AuthSession → access token em memória + refresh HttpOnly | Revogação, logout e rotação devem concordar entre abas e chamadas concorrentes |
| Autorização | JWT → consulta de usuário/authVersion → roles/permissions → ACL do recurso | A mesma política deve valer em dados, vídeo, exportações e push |
| Vídeo puxado | Câmera RTSP → MediaMTX → WebRTC/WHEP ou HLS → cliente | Credenciais da origem não podem escapar; ACL não pode ser contornada por URL alternativa |
| Vídeo enviado | Câmera RTMP → SRS → callback/autorização → MediaMTX | Chave de publicação e callback precisam delimitar a câmera correta |
| Gravação | API/controlador → FFmpeg → arquivo → metadata PostgreSQL → playback/export | Um único controlador por câmera; arquivo e banco reconciliáveis após crash |
| IA/alarme | Frames → IA ou eventos de dispositivo → API → regra/alarme → fila → push | Destinatários devem manter autorização vigente no momento de envio |
| Acervo cloud | Segmento fechado → upload → HEAD/validação → vínculo do storage → poda local | Nunca apagar a única cópia comprovadamente íntegra |
| Retenção/evidência | Política → identificação de protegidos → diário de exclusão → banco/FS | Legal hold precisa ter semântica única em todas as exclusões |
| Frota | Heartbeat/licença/revisão → Central/datastore → comando/configuração → instalação | Atualizações simultâneas não podem sobrescrever outro estado |
| Deploy | Backup → fetch/build → parar writers → migration → subir → readiness/rollback | O ponto de rollback deve preservar todas as escritas anteriores à parada |

## 5. Achados P0 — tratar antes de nova promoção ampla

### AUD-001 — Snapshot obsoleto da instalação remota apaga alteração concorrente

**Tipo:** bug confirmado. **Prioridade:** P0/crítica. **Confiança:** alta.

**Evidência:** `apps/central/src/server.js:3553`, função `handleRemoteInstall`; salvamento em torno de `3603`; callback de host key em `3612`; exclusão de `remote-install` da fila em `4532`. `apps/central/src/datastore/pg-store.js:210`, `writeAll`, inclui remoção de chaves ausentes no snapshot em `218`, `222` e `226`.

**Causa raiz e fluxo:** a rota carrega o documento da Central, aguarda operações assíncronas e depois salva o documento completo, sem passar pela mesma serialização das demais mutações. Excluir uma tarefa longa da fila evita bloqueio por SSH, mas também retira a proteção das pequenas alterações de estado que antecedem e acompanham essa tarefa. O caminho de medição cloud usa recarga serializada; o de instalação remota não mantém essa disciplina em todos os pontos.

**Reprodução executada:** em uma Central temporária, criar `audit-a`; iniciar POST de instalação remota de A, entregando só parte do corpo; provisionar `audit-b` por outra requisição; completar o corpo de A. A instalação remota respondeu 202; a consulta posterior retornou apenas A. Resultado: `{"remoteInstallStatus":202,"idsAfterConcurrentProvision":["audit-a"],"concurrentInstallationLost":true}`. O alvo SSH era sintético/local sem serviço; nenhum servidor real foi provisionado. A perda foi reproduzida no datastore JSON. No PostgreSQL, o mecanismo de `writeAll` também remove registros que não constam do snapshot; a corrida HTTP completa não foi repetida nesse backend.

**Impacto:** desaparecimento de instalação criada durante a operação, sobrescrita de configurações e potencial perda de outras coleções que participam do documento. Não é necessário que a instalação SSH termine com sucesso para o primeiro salvamento causar o problema.

**Correção recomendada:** serializar apenas load/mutate/save com recarga fresca em cada callback; manter SSH fora da seção crítica. Evoluir posteriormente para mutações transacionais por entidade, com controle de versão. Não envolver a conexão SSH inteira no lock global.

**Regressões/teste obrigatório:** provisionar, alterar licença, receber heartbeat e remover usuário durante instalação remota; provar preservação de ambas as alterações em JSON e PostgreSQL. Exercitar também o callback de host key e falha de SSH.

### AUD-002 — Rollback pode descartar escritas feitas enquanto o build ocorre

**Tipo:** risco de perda de dados demonstrado pelo fluxo. **Prioridade:** P0/crítica. **Confiança:** alta na sequência; perda real não provocada.

**Evidência:** `scripts/update-drac.sh:308` gera dump com aplicação ativa; `321` habilita rollback antes de fetch; `334` constrói imagens com writers ativos; `340` para a aplicação. A função `rollback`, em `153`, restaura código e banco a partir do dump. `scripts/restore-drac.sh:244` também captura estado de segurança antes de `stop_writers` em `251`.

**Causa raiz:** o snapshot usado como recuperação precede a janela em que a aplicação ainda aceita alterações. A flag de rollback não distingue falha de fetch/build de falha após migration. Assim, uma falha anterior a qualquer alteração de schema ainda pode restaurar um banco mais antigo.

**Cenário:** dump às 10:00, novos cadastros/metadata às 10:01, build falha às 10:03, rollback restaura 10:00. O dump pode ser perfeitamente consistente e, mesmo assim, perder os dados da janela. Parar writers somente no momento do rollback não recupera essas escritas.

**Impacto:** perda de configurações, usuários, metadados de vídeo e eventos; possível desencontro banco/arquivos. A opção de permitir árvore suja também exige cuidado: `git reset --hard` do rollback não preserva edições versionadas locais apenas porque o status foi registrado em texto.

**Correção recomendada:** separar preparação de alteração operacional; concluir fetch/build primeiro; parar writers e só então capturar o ponto consistente imediatamente anterior à migration. Registrar estágio e restaurar banco somente quando houve alteração de banco que exige isso. Preservar patches locais explicitamente ou recusar árvore suja.

**Regressões/teste obrigatório:** fixture com escritor contínuo e falhas injetadas em fetch, build, migration e readiness; todas as escritas anteriores ao quiesce precisam sobreviver. Testar falha do próprio rollback e recuperação manual. Nenhum teste destrutivo foi executado no banco operacional.

## 6. Achados P1 — correção prioritária

### AUD-003 — Push não usa a mesma autorização das câmeras

**Tipo/prioridade/confiança:** bug confirmado; P1/alta; alta.

**Evidência:** `apps/api/src/notifications/push-devices.service.ts:43`, `getTokensForCamera`, consulta apenas `groupId`, agrega privilegiados e permissões de câmera/grupo; contraste com `apps/api/src/access-control/access-control.service.ts:171`. Consumidor real: `apps/api/src/jobs/processors/alarm-notification.processor.ts:218`, que inclui nome da câmera, texto do evento e identificadores no push.

**Causa/impacto:** a implementação promete espelhar a ACL, mas não dispõe dos campos necessários para avaliar privacidade e dono; também não aplica uniformemente usuário ativo e restrição de grupo aos destinatários por permissão. Um usuário sem acesso ao recurso pode receber metadados sensíveis. Não foi demonstrado acesso ao vídeo ou à gravação por esse caminho.

**Reprodução:** serviço real com Prisma sintético retornou tokens de administrador não proprietário e viewer autorizado apenas pelo grupo para o cenário privado: `{"recipients":["admin-not-owner","group-viewer"],"count":2}`. Nenhuma notificação externa foi enviada.

**Recomendação:** centralizar resolução inversa da ACL, incluindo câmera privada, dono, permissão direta, papel, usuário ativo e estado do grupo; aplicar mute depois. **Impacto da mudança:** preservar alertas sem câmera destinados à administração. **Teste:** matriz de papéis e estados em PostgreSQL, com transporte push falso e assert de destinatários e payload.

### AUD-004 — Dual-read ressuscita registros apagados

**Tipo/prioridade/confiança:** bug confirmado sob configuração dual com legado correspondente; P1/alta; alta.

**Evidência:** `apps/central/src/datastore/dual-read.js:55`, `mergeDb`; `apps/central/src/datastore/index.js`, `load`; `infra/management/docker-compose.yml:54` tem default `dual`. O próprio código registra a ressalva, mas não impede o estado perigoso em operação.

**Causa/impacto:** exclusão no PostgreSQL se torna indistinguível de registro ainda não migrado. O merge repõe usuários, sessões e instalações presentes no JSON congelado. Uma sessão ainda válida no legado pode voltar a participar da autenticação; expiração e demais verificações continuam existindo, portanto não significa que qualquer sessão antiga funcione.

**Reprodução:** executar `mergeDb` com usuário e sessão ausentes do lado novo e presentes no legado faz ambos reaparecerem. É prova da regra de merge, não exploração de login no Management real. O modo efetivo desse servidor não foi consultado nesta execução.

**Recomendação:** reconciliação conferida e mudança explícita para o modo `pg`; se dual precisar aceitar exclusões, usar tombstones ou política equivalente. **Impacto:** migrar sem perder registros que só existem no legado. **Teste:** logout/revogação/exclusão → save → load → restart em dual e pg, preservando revogação.

### AUD-005 — Requisição incompleta bloqueia operações da Central

**Tipo/prioridade/confiança:** bug confirmado; P1/alta; alta.

**Evidência:** `apps/central/src/server.js:205`, `readBody`; handler de login; `4410`, `runSerialized`; `4532`, escolha de rotas serializadas. A seção global inclui espera de corpo de requisição e não apenas mutações.

**Reprodução:** enviar parcialmente um POST de login não autenticado à fixture, manter o corpo incompleto e consultar uma rota administrativa por outra conexão. Resultado: `{"unauthenticatedPartialBody":true,"health":200,"administrativeRequestStalled":true}`. A consulta administrativa excedeu a janela de 500 ms do teste; a conexão de ataque foi encerrada ao final.

**Impacto/limites:** indisponibilidade temporária de operações/heartbeats que dependem da fila, mesmo com liveness verde. Timeouts de HTTP/proxy podem limitar a duração; não foi demonstrado bloqueio infinito nem exploração pela borda pública da frota. Buffering do nginx pode mitigar a chegada de corpos lentos, sem corrigir o desenho da aplicação.

**Recomendação:** ler/validar corpo com limites e prazo antes do lock; autenticar antes de enfileirar mutações quando possível; limitar fila e duração. **Regressão:** garantir que separar parsing não reintroduza AUD-001. **Teste:** slow body, desconexão, corpo inválido e rajadas devem manter latência de operações independentes sob limite definido.

### AUD-006 — Restore não respeita topologia e readiness corretamente

**Tipo/prioridade/confiança:** bug confirmado pela sequência de shell; P1/alta; alta, sem execução de restore real.

**Evidência:** `scripts/restore-drac.sh:64`, `start_runtime`, inclui explicitamente `drac-central`; `197` instala ERR trap; `274` faz probes imediatos em loopback; `278` usa `set +e` em readiness. Comparar com a lógica corrigida de bind/retry e serviços condicionais em `scripts/update-drac.sh`.

**Causa/impacto:** o restore pode iniciar a Central em tenant que não deveria hospedá-la; não espera aquecimento nem usa o bind efetivo da web; e `set +e` não desabilita a execução de `trap ERR`. Readiness com código 1, pretendido como atenção, pode acionar rollback antes da comparação com 2. Uma restauração boa pode ser classificada como falha.

**Recomendação:** derivar serviços e overlays da topologia real; usar probes com retry e bind correto; capturar retorno com `comando || status=$?`. Tratar AUD-002 antes de confiar no rollback. **Impacto:** preservar operação de instalações com/sem Central e GPU. **Teste:** harness de Compose fake com retorno 0/1/2, bind privado, inicialização lenta e perfis distintos; depois restore completo em VM descartável.

### AUD-007 — Logout pode ser revertido pelo refresh web

**Tipo/prioridade/confiança:** bug provável por fluxo assíncrono; P1/alta; média-alta. Sem reprodução em navegador nesta execução.

**Evidência:** `apps/web/src/store/authStore.ts:120`, refresh; `145`, bootstrap; `201`, revalidate; `261`, logout; `apps/web/src/App.tsx:413`, timer de revalidação independente do estado autenticado.

**Causa/impacto:** logout limpa estado local, mas ignora erro da chamada remota e não invalida respostas pendentes por geração da sessão. Um refresh iniciado antes pode aplicar `isAuthenticated=true` depois. Se logout remoto falhar e o cookie permanecer, a revalidação posterior pode recuperar a sessão. O risco importa especialmente em terminal compartilhado. O estado efetivo do token após revogação no servidor depende da ordem das respostas; não se afirma acesso permanente após logout remoto bem-sucedido.

**Recomendação:** geração monotônica/cancelamento lógico de autenticação, intenção de logout que iniba refresh até novo login e tratamento visível de revogação incompleta. Cookie HttpOnly deve continuar sendo apagado pelo servidor. **Impacto:** não transformar queda breve de rede em logout acidental de usuários que não pediram logout. **Teste:** Playwright com refresh atrasado, logout offline, reconexão e avanço do relógio de cinco minutos.

### AUD-008 — Reset de senha não consome token atomicamente

**Tipo/prioridade/confiança:** bug confirmado; P1/alta; alta.

**Evidência:** `apps/api/src/auth/auth.service.ts:338`, `resetPassword`: lê token/validade, calcula hash assíncrono e atualiza usuário por ID sem condição de token ainda disponível.

**Reprodução:** duas chamadas simultâneas do método real, com bcrypt real e Prisma controlado, passaram pela mesma leitura válida e concluíram duas atualizações. Duas promises fulfilled, duas escritas. O teste prova a janela de concorrência; não foi usado token real nem modificado usuário operacional.

**Impacto:** quebra da propriedade de uso único; a última atualização define a senha. É necessário possuir token válido: o achado não permite redefinir arbitrariamente qualquer conta.

**Recomendação:** consumo condicional por hash e validade, checando uma única linha afetada, em transação com revogação de sessões; conservar hash forte. **Impacto:** preservar semântica de expiração e mensagens sem enumeração. **Teste:** PostgreSQL real com barreira concorrente, exigindo exatamente um sucesso e uma rejeição.

### AUD-009 — Proteção de evidências difere entre retenção e exclusão manual

**Tipo/prioridade/confiança:** risco de integridade/contrato divergente; P1/alta; alta no código, intenção de produto pendente.

**Evidência:** `apps/api/src/recordings/retention.service.ts:334` identifica `legal_hold` e referências de investigações; `apps/api/src/recordings/recordings.service.ts:3316`, `deleteAllRecordings`, apaga conjuntos sem aplicar o mesmo filtro; `apps/api/src/cameras/cameras.service.ts:875` remove câmera; relações em `apps/api/prisma/schema.prisma:301` e `353` incluem cascatas.

**Causa/impacto:** proteção existe no fluxo automático, mas não é invariável nos caminhos administrativos. Remover câmera ou todo o acervo pode eliminar evidência que um investigador considera preservada. A exclusão total possui autorização administrativa e parada de gravação; não é endpoint público nem falta comprovada de autorização.

**Recomendação:** decidir se hold é inquebrável ou se existe override explícito, auditável e separado da exclusão comum. Aplicar a política antes da cascata e antes de tocar arquivos. **Impacto:** pode mudar uma funcionalidade administrativa hoje intencional; não implementar silenciosamente. **Teste:** câmera com gravação protegida, exportação e investigação; todos os caminhos de exclusão, inclusive batch, devem obedecer ao contrato escolhido.

## 7. Achados P2 — consistência, operação e manutenção

### AUD-010 — Refresh concorrente causa falsa rejeição da sessão

**Tipo/prioridade/confiança:** bug provável; P2/média; média-alta.

**Evidência/causa:** `apps/web/src/store/authStore.ts:120` não compartilha promise nem coordena abas. `apps/api/src/auth/auth.service.ts:169` faz rotação condicional de sessão: dois requests com o mesmo refresh token não podem vencer. Bootstrap e revalidação compartilham cookie, mas não exclusão mútua.

**Impacto/reprodução proposta:** disparar refresh simultâneo em duas abas com a mesma sessão pode fazer uma receber 401 e limpar o estado, apesar de a outra renovar corretamente. Não reduzir a proteção do backend para esconder a corrida.

**Recomendação/impacto:** single-flight por aba e coordenação segura entre abas; integrar ao controle de geração de AUD-007. **Teste:** navegador com duas abas, refresh atrasado, rotação e expiração; diferenciar rejeição real de corrida.

### AUD-011 — Assinatura S3 inconsistente em virtual-host style

**Tipo/prioridade/confiança:** bug confirmado; P2/média; alta.

**Evidência:** `apps/api/src/cloud-storage/s3-client.ts:134`, host usado na assinatura; `187`, URL final recebe prefixo do bucket. Consumidores incluem offload e acesso a objetos; o teste de virtual-host existente verifica URL, não a equivalência do host assinado.

**Reprodução:** `signS3Request` com `forcePathStyle=false` produziu `{"signedHost":"s3.example.invalid","urlHost":"private-bucket.s3.example.invalid","mismatch":true}`. Sem request a bucket real.

**Impacto:** conforme transporte/provedor, assinatura rejeitada ou host de roteamento errado. Modo path-style não é afetado por esse descompasso específico. Proteções de confirmação/poda reduzem risco de perda de acervo; não se demonstrou apagamento por esse bug.

**Recomendação/impacto:** construir URL definitiva antes da canonicalização e assinar exatamente o que será enviado. **Teste:** vetor conhecido SigV4, host/porta, path-style/virtual-host, query, caracteres especiais e endpoint com prefixo; integração S3 descartável.

### AUD-012 — Dois ciclos de offload entram na seção protegida

**Tipo/prioridade/confiança:** bug confirmado; P2/média; alta.

**Evidência:** `apps/api/src/cloud-storage/cloud-offload.service.ts:224`, `runOnce`; verifica `running`, aguarda `storageParaEscrita` em `232` e só marca em `237`. Há chamadores HTTP e de fila (`cloud-storage.controller.ts` e `jobs/processors/cloud-offload.processor.ts`).

**Reprodução:** duas chamadas do método real sincronizadas na resolução do storage executaram ambas upload/poda sintéticos: `{"concurrentCycles":2,"skipped":[false,false]}`.

**Impacto:** uploads duplicados, disputa de banda e interleaving na poda; não foi provada perda de arquivo. **Recomendação:** reservar execução antes do primeiro await, liberando em finally também nos retornos antecipados; lock distribuído se houver múltiplas APIs. **Teste/impacto:** cron+manual simultâneos, destino inexistente, erro de preflight e recuperação, sem bloquear permanentemente futuros ciclos.

### AUD-013 — Variável vazia torna cookie de produção não Secure

**Tipo/prioridade/confiança:** bug confirmado condicional; P2/média; alta.

**Evidência:** `infra/docker-compose.yml:449` injeta `COOKIE_SECURE=${COOKIE_SECURE:-}`. `apps/api/src/auth/auth.controller.ts:137`, `refreshCookieOptions`, usa fallback de produção somente para undefined; string vazia se torna false.

**Reprodução:** invocar o método com NODE_ENV de produção e variável vazia devolveu `secure=false`. **Impacto:** instalação que depende do default pode emitir cookie sem Secure. O Vibe observado tinha `COOKIE_SECURE=true`, logo não se constatou essa configuração vulnerável localmente.

**Recomendação/impacto:** normalizar vazio como ausente ou exigir configuração explícita no deploy; preservar desenvolvimento HTTP. **Teste:** undefined, vazio, true, false e produção atrás de proxy confiável, verificando `Set-Cookie` real.

### AUD-014 — Lock JSON permanece após queda abrupta

**Tipo/prioridade/confiança:** risco operacional explícito; P2/média; alta.

**Evidência:** `apps/central/src/datastore/singleton-lock.js:13`, acquire com `open(..., 'wx')`; EEXIST interrompe inicialização. A liberação ocorre no encerramento limpo.

**Cenário/impacto:** SIGKILL/OOM deixa arquivo; restart policy pode entrar em loop sem restaurar serviço. A escolha conservadora evita duas instâncias gravando JSON e não deve ser substituída por remoção cega do lock.

**Recomendação/impacto:** preferir datastore PostgreSQL para operação central ou lock associado ao processo/descritor com semântica adequada; documentar recuperação segura e identificação de dono. **Teste:** morte abrupta, restart, segunda instância legítima e filesystem compartilhado; nunca remover lock de processo ativo apenas por idade.

### AUD-015 — Health da Central não equivale a readiness

**Tipo/prioridade/confiança:** risco de observabilidade; P2/média; alta.

**Evidência:** `apps/central/src/server.js:3787`, GET `/api/health`; `infra/management/docker-compose.yml:94` usa esse endpoint como healthcheck. Responde sem demonstrar disponibilidade do datastore ou progresso da fila global.

**Reprodução/impacto:** AUD-005 manteve health 200 durante bloqueio administrativo. Não afirmar que liveness deve executar toda a operação: o problema é usá-lo como única prova de prontidão.

**Recomendação/impacto:** separar liveness de readiness, com acesso limitado ao datastore e métricas de idade/progresso da fila; evitar avalanche de probes e reinícios por falha transitória. **Teste:** banco indisponível, fila bloqueada, startup e recuperação; alertar sobre indisponibilidade real.

### AUD-016 — Persistência por documento completo limita escala da Central

**Tipo/prioridade/confiança:** risco de performance/escala; P2/média; alta no desenho, capacidade não medida.

**Evidência:** `apps/central/src/datastore/pg-store.js:106`, `readAll`; `210`, `writeAll`, laços de upserts e exclusões para coleções completas; `apps/central/src/server.js:4410`, fila global. Handlers administrativos também salvam estado em vários caminhos de leitura/autenticação.

**Causa/impacto:** o custo de uma operação pequena cresce com a quantidade total de instalações, usuários, sessões e auditoria. Serialização protege consistência de snapshots, mas amplia espera. O lock singleton PostgreSQL existente não permite simplesmente subir réplicas gravadoras independentes.

**Recomendação/impacto:** medições primeiro; depois operações específicas por entidade, transações e versionamento otimista. Preservar auditoria e contrato JSON durante migração. **Teste:** carga com tamanhos progressivos de frota e histórico, p95/p99, tempo de heartbeat, WAL e backlog; sem número de capacidade inventado.

### AUD-017 — Parada de IA bloqueia o event loop

**Tipo/prioridade/confiança:** risco demonstrado por código; P2/média; alta.

**Evidência:** `services/ai-service-python/main.py:208` e `301`, handlers async chamam `processor.stop()` diretamente; `stream_processor.py:455` faz até dois joins com timeout de dois segundos.

**Cenário/impacto:** threads lentas durante stop/stop-all podem bloquear o loop ASGI por vários segundos; em lote, a espera soma por câmera. O limite teórico dos joins não é latência medida nem garantia de que todos atinjam timeout.

**Recomendação/impacto:** transferir espera bloqueante para thread/executor, com limite de concorrência e estado de término bem definido. Preservar locks de mapa e fechamento de recursos. **Teste:** processador com join atrasado, requisição health concorrente e paradas repetidas sem thread órfã.

### AUD-018 — Hooks de shutdown não são habilitados no bootstrap da API

**Tipo/prioridade/confiança:** risco operacional; P2/média; alta.

**Evidência:** `apps/api/src/main.ts:118` chega a `listen` sem `app.enableShutdownHooks()`. `apps/api/src/common/prisma/prisma.service.ts:10` e outros providers têm hooks de cleanup; existe helper de shutdown no Prisma, mas não é chamado no bootstrap.

**Causa/impacto:** a presença de `onModuleDestroy` não garante execução em SIGTERM sem wiring do ciclo Nest. Encerramentos por deploy podem perder flushes ou limpeza best-effort, aumentando trabalho de reconciliação. Não foi demonstrada corrupção de gravação causada especificamente por isso.

**Recomendação/impacto:** habilitar ciclo de encerramento, definir prazo compatível com Compose e tratar consumidores/filas/processos externos. **Teste:** subprocesso com SIGTERM, confirmação de cleanup e reinício sem jobs ou processos duplicados; shutdown não pode travar indefinidamente.

### AUD-019 — Busca de investigações filtra depois do limite

**Tipo/prioridade/confiança:** bug confirmado por código; P2/média; alta.

**Evidência:** `apps/api/src/investigations/investigations.service.ts:130`, `list`; `take: 50` precede filtros q/status/prioridade/classificação/owner aplicados em memória.

**Cenário/impacto:** com 51 ou mais casos autorizados, uma busca que só corresponde ao caso antigo retorna vazio. O usuário interpreta como inexistência, não como truncamento. Carregar todos os itens aninhados das 50 investigações também tem custo variável.

**Recomendação/impacto:** filtrar antes de paginar; se metadata estiver serializada, criar projeções indexáveis ou estratégia transitória correta. Expor cursor/total conforme contrato de UI. **Teste:** mais de 50 casos, correspondência somente fora da primeira página, filtros combinados e isolamento por usuário.

### AUD-020 — Teste de deploy está desatualizado em relação ao bind

**Tipo/prioridade/confiança:** bug confirmado no teste; P2/média; alta.

**Evidência:** `apps/api/tests/operational-scripts-safety.test.ts:44` exige `wait_for_http HEAD http://127.0.0.1:5173/ Web`; `scripts/update-drac.sh` agora usa `"$(web_health_url)"`. A mudança funcional de bind não foi acompanhada pela expectativa do teste.

**Reprodução/impacto:** única falha na suíte API: “update aguarda API e Web iniciarem antes de considerar o deploy quebrado”; 1.616/1.617 aprovados. É falha real da suíte atual, não prova de que a nova função de bind esteja errada.

**Recomendação/impacto:** testar comportamento do probe com bind loopback e privado, não exigir literal antigo. **Teste:** harness de comando e retry, inclusive indisponibilidade inicial. Não fazer o teste passar removendo a proteção funcional.

### AUD-021 — Fixture RBAC não acompanha schema User

**Tipo/prioridade/confiança:** bug confirmado no teste; P2/média; alta.

**Evidência:** `apps/api/tests/access-control-postgres.e2e.ts:90`, `user.createMany`, não fornece `username`; `apps/api/prisma/schema.prisma:466` exige campo único não nulo.

**Reprodução/impacto:** sobre banco novo com as 64 migrations, os oito casos RBAC falharam com `Argument username is missing` antes de testar autorização. Os três casos de locks na execução e2e passaram. Não interpretar as oito falhas como oito bypasses de ACL; a consequência é ausência de prova de autorização e gate reprovado.

**Recomendação/impacto:** ajustar dados sintéticos ao contrato real e manter casos negativos; não tornar username opcional apenas para acomodar fixture. **Teste:** executar suíte novamente em banco vazio, exigir zero skip e verificar cleanup.

### AUD-022 — Persistência de filas Redis não é explícita

**Tipo/prioridade/confiança:** risco operacional; P2/média; média-alta.

**Evidência:** `infra/docker-compose.yml:28`, serviço Redis, sem volume nomeado e política AOF explicitamente declarados. A imagem pode criar volume anônimo e usar snapshots; isso não equivale a política de durabilidade e recuperação documentada.

**Cenário/impacto:** recriação com perda/troca do volume ou falha antes de persistir pode eliminar jobs, recibos e agendamentos. Reinício simples não implica necessariamente perda total, e alguns produtores podem reconciliar jobs; a cobertura dessa reconstrução não foi provada para todos os tipos.

**Recomendação/impacto:** definir RPO, persistência e volume gerenciado; escolher AOF/snapshots conforme carga; manter jobs idempotentes e reconstruíveis a partir do banco quando adequado. **Teste:** crash/recreate em ambiente descartável, exportações pendentes, retries e cron; monitorar disco e latência de fsync.

### AUD-023 — Build da Central não é reproduzível por lockfile

**Tipo/prioridade/confiança:** dívida/risco de supply chain; P2/média; alta.

**Evidência:** `apps/central/Dockerfile:6` copia package.json e executa `npm install --omit=dev --omit=optional`, sem copiar um lockfile nem consumir o lock pnpm do workspace.

**Causa/impacto:** faixas e transitivas podem resolver versões diferentes em rebuild do mesmo commit. Tags base móveis ampliam a diferença entre artefatos, mesmo que o código seja idêntico. Não foi demonstrada dependência maliciosa nem divergência efetiva entre servidores.

**Recomendação/impacto:** build com lock congelado e runtime mínimo; registrar digest e SBOM. Escolher uma estratégia consistente com o monorepo, evitando dois locks independentes em conflito. **Teste:** dois builds limpos com o mesmo material resolvem a mesma árvore; smoke de SSH e datastore.

### AUD-024 — Dependência Python afetada por advisory conhecido

**Tipo/prioridade/confiança:** risco de segurança; P2/média no contexto observado; alta na versão, alcance atual não demonstrado.

**Evidência:** `services/ai-service-python/requirements.txt:7` fixa `python-multipart==0.0.12`. O mantenedor informa que versões anteriores a 0.0.18 são afetadas por DoS ao processar multipart deformado, CVE-2024-53981. [Advisory oficial GHSA-59g5-xgcq-4qw3](https://github.com/Kludex/python-multipart/security/advisories/GHSA-59g5-xgcq-4qw3), consultado em 26/09/2026.

**Impacto/limites:** há versão declarada vulnerável, mas os handlers de IA inspecionados não usam Form/UploadFile; não foi demonstrado parsing multipart alcançável nem exploração pública. O P2 reflete essa condição; não reclassifica a gravidade do advisory upstream.

**Recomendação/impacto:** remover dependência se desnecessária ou atualizar com matriz FastAPI/Starlette/Pydantic compatível e consulta aos advisories atuais. 0.0.18 é a primeira correção desse advisory, não uma recomendação de versão mais recente ou livre de todos os outros problemas. **Teste:** resolver dependências, inicializar ASGI, validar contratos e executar scanner completo de transitivas/imagem antes de promoção.

### AUD-025 — Gates de CI deixam lacunas de cobertura

**Tipo/prioridade/confiança:** lacuna de testes confirmada; P2/média; alta.

**Evidência:** `.github/workflows/ci.yml`, job scripts, usa `bash -n scripts/*.sh`: Bash interpreta o primeiro arquivo como script, os demais como argumentos. Há job RBAC PostgreSQL da API, mas as suites PostgreSQL da Central podem ficar puladas sem URL; serviço Go não possui gate equivalente identificado nesse workflow. Alguns testes de configuração validam réplica da regra/regex, não a implementação chamada pelo servidor.

**Impacto:** status verde pode não cobrir sintaxe de todos os scripts, contrato Central/PG ou código Go. Nesta auditoria, o loop explícito de sintaxe passou: não se encontrou erro de sintaxe escondido nesses arquivos.

**Recomendação/impacto:** loop por arquivo; jobs isolados Central/PG e Go; falhar quando integração obrigatória for pulada; preferir testes de comportamento aos de forma. **Teste:** inserir defeitos em fixtures/cópias descartáveis e provar reprovação; não alterar código produtivo para testar o gate.

## 8. Achados P3 — simplificação e higiene

### AUD-026 — Concentração excessiva de responsabilidades

**Tipo/prioridade/confiança:** dívida técnica; P3/baixa; alta.

**Evidência:** `apps/api/src/cameras/cameras.service.ts` tem aproximadamente 4.119 linhas; `recordings.service.ts`, 3.398; `recording-process-manager`, 2.842; proxy MediaMTX, 2.924; `apps/central/src/server.js`, 4.608; `apps/central/public/index.html`, 6.316; `apps/mobile/App.tsx`, 2.009. Contagens são indicadores, não bugs por si.

**Causa/impacto:** políticas, persistência, protocolos e coordenação assíncrona convivem em unidades grandes. Isso favorece divergências como snapshot remoto e autorização inversa de push.

**Recomendação/impacto:** extrair por responsabilidade estável e contratos, começando por mutações da Central, ACL e ciclo de autenticação; não reescrever o sistema nem repartir arquivos arbitrariamente. **Teste:** caracterização dos fluxos antes de mover código, mantendo contratos públicos e observabilidade.

### AUD-027 — Resíduos precisam de classificação antes da limpeza

**Tipo/prioridade/confiança:** melhoria; P3/baixa; alta na presença, uso a verificar.

**Evidência:** cache versionado `services/ai-service-python/datasets/coco8/labels/val.cache`; arquivos locais não versionados de backup e patches em `infra/`, além de `backups/`. Eles já existiam e foram preservados.

**Impacto:** caches gerados podem ficar incompatíveis com dataset/ambiente; resíduos confundem suporte e podem conter informação operacional. Não se concluiu que backups ou patches sejam inúteis, nem foram lidos integralmente ou apagados.

**Recomendação/impacto:** inventariar proprietário, finalidade, retenção e sensibilidade; remover cache do versionamento somente após validar regeneração; manter backup fora do fluxo de código. **Teste:** execução sem cache e restauração do material de recuperação antes de qualquer descarte.

### AUD-028 — Teste de banda tem resultado dependente do ambiente

**Tipo/prioridade/confiança:** bug provável de teste/diagnóstico; P3/baixa; média.

**Evidência:** `apps/central/tests/cloud-storage-performance.test.js:44` espera uma faixa de 20 a 80 Mb/s a partir de atraso de 200 ms. Rodadas obtiveram aproximadamente 18,89 e 19,02 Mb/s, inclusive no reteste sem limite de um CPU. `apps/central/src/s3-probe.js:342` contém fator 8 correto para converter bytes em bits.

**Impacto/limites:** a falha não comprova confusão MB/s versus Mb/s. Transporte, tempo de execução e ambiente podem influenciar o limite; a causa exata da latência extra não foi isolada. Não atribuir automaticamente a um CPU, pois o reteste não confirmou essa explicação.

**Recomendação/impacto:** testar conversão como função pura com relógio controlado e testar transporte separadamente; investigar latência adicional antes de simplesmente ampliar tolerância. **Teste:** execução repetida em runner limpo, medições por fase e nenhuma dependência de banda externa.

## 9. Divergências transversais

| Contrato esperado | Implementações divergentes | Consequência / referência |
|---|---|---|
| Quem não vê câmera não recebe dados dela | ACL da API versus seleção de push | AUD-003 |
| Exclusão/revogação persiste após leitura | PostgreSQL versus fallback JSON | AUD-004 |
| Toda mutação da Central preserva alterações concorrentes | Rotas serializadas versus remote-install | AUD-001 |
| Logout encerra a intenção de sessão | Store limpo versus refresh em voo/timer | AUD-007 |
| Token de reset é de uso único | Verificação antes do hash versus update por ID | AUD-008 |
| Legal hold protege evidência | Retenção versus purge/cascade | AUD-009 |
| Update e restore respeitam o mesmo host | Serviços condicionais/bind versus serviços fixos/loopback | AUD-006 |
| Busca encontra todo o universo autorizado | Filtros depois de take 50 | AUD-019 |
| Teste e schema concordam | User.username versus fixture e2e | AUD-021 |
| Código promovido deve passar o gate | Função web_health_url versus regex antiga | AUD-020 |

## 10. Segurança

### Controles positivos observados

O access token web fica em memória e a sessão durável usa cookie HttpOnly. A API verifica estado de usuário/authVersion, além da assinatura JWT. Há rotação condicional de refresh, hash de senha e de token de reset, guards de papel/permissão, validação de caminhos com resolução real e proteções contra traversal em restauração. Serviços de infraestrutura usam isolamento de rede/bind, e configurações de Management incluem hardening de container. Esses controles reduzem classes de ataque, mas não anulam os achados específicos.

### Prioridades e exposição

Priorizar AUD-003/004/005/007/008 antes de mudanças cosméticas. Corrigir AUD-013 como default de instalação, mesmo não estando ativo no Vibe. Diferenciar acesso de administrador autenticado, acesso interno e acesso público em todo reteste. Instalação remota envolve credenciais e autoridade elevadas: serialização, auditoria e host key não podem ser enfraquecidas para resolver concorrência.

A busca limitada por arquivos de chave/ambiente versionados e cabeçalhos de chave privada não encontrou material correspondente. Isso **não** é atestado de ausência de segredos: não cobre histórico, todos os padrões, imagens ou backups. As senhas compartilhadas na conversa merecem rotação planejada e contas/chaves de menor privilégio; não foram rotacionadas durante diagnóstico para evitar interromper acesso. Não compartilhar chave privada única entre todos os servidores como solução de Git; preferir identidades por host e escopo mínimo quando essa política for revisada.

Não foram testados ataques de carga contra produção, força bruta, acesso a câmeras de terceiros ou exploração do advisory Python. Provas de concorrência e bloqueio foram locais e descartáveis.

## 11. Banco de dados, integridade e recuperação

As 64 migrations aplicaram em PostgreSQL vazio. O schema tem 28 models. Esse resultado valida a sequência limpa observada, não todos os caminhos de upgrade com dados históricos, nem igualdade integral de schema de cada instalação.

Há mecanismos úteis de transação, advisory lock e diário de exclusão para aproximar estado de banco e filesystem. Arquivo e PostgreSQL não compartilham transação atômica; recuperação depende de journal, idempotência e reconciliação. A conferência por HEAD antes da poda e a identidade do storage de origem são importantes e devem sobreviver às correções.

Os riscos mais graves não são ausência genérica de transação: são **fronteiras incorretas**. AUD-001 salva estado antigo com sucesso; AUD-002 restaura um snapshot consistente, porém temporalmente errado; AUD-008 valida antes da operação que precisa ser atômica; AUD-009 permite cascata fora da política de retenção.

Antes de otimizar índices, coletar planos e cardinalidades de consultas reais. Não foi comprovado N+1 generalizado nem necessidade de particionar todas as tabelas. Investigações requerem corrigir semântica de filtro antes de otimizar. Central requer sair de gravação integral por request antes de considerar mais réplicas. Ensaios de restauração devem conferir banco, arquivos, chaves/configuração, vínculos de storage e retomada de jobs, não apenas exit code de `pg_restore`.

## 12. Performance e escalabilidade

### Gargalos demonstrados no desenho

Central: fila global + snapshot completo + handlers que aguardam I/O. Web: polling de estado por cliente, ampliando carga linearmente conforme usuários; não foi medido como gargalo atual. IA: joins em handler async, captura/inferência competindo por recursos e necessidade de validar perfil de hardware. Acervo: offload compete pelo mesmo link do vídeo e pode duplicar ciclos por AUD-012. Investigações: consulta limitada antes do filtro e carga de itens aninhados.

### O que medir antes de prometer capacidade

- Por instalação: câmeras por codec/resolução/FPS, bitrate, CPU, GPU, RAM, disco livre, IOPS, latência de escrita e fila FFmpeg.
- Rede: tráfego simultâneo de live, reprodução, cloud e backup; perda de pacote, TURN e fallback HLS.
- API: p50/p95/p99 por família, queries lentas, pool PostgreSQL, duração/idade dos jobs, conexões de streaming e timeouts.
- Central: tempo de heartbeat, idade da fila, tamanho de snapshot, WAL e latência conforme frota e histórico crescem.
- IA: latência de inferência, frames descartados, atraso de captura, threads ativas, acurácia por cenário e eventos falsos/omitidos.

Não há evidência suficiente para recomendar microserviços adicionais, Kubernetes ou sharding imediato. A primeira melhora é corrigir invariantes e isolar trabalho bloqueante; depois medir. Escalar horizontalmente a API também exige revisar locks em memória, estado de controle de gravação e idempotência de jobs.

## 13. Infraestrutura, Git e implantação

O commit e a versão anunciada localmente coincidem. Isso é melhor que inferir versão pelo nome de imagem `latest`, mas ainda é necessário registrar digest de imagem e referência promovida. O repositório solicitado pelo usuário é `TavaresEnok/sistema-de-camera-completo-5-0`; esta fase não fez push, troca de remote ou confirmação de HEAD remoto. Não se deve descrever servidores não revisitados como atualizados com base somente no histórico da conversa.

Os scripts têm boas intenções de backup, quiesce, validação e rollback, mas AUD-002 e AUD-006 impedem tratá-los como recuperação já comprovada. A prioridade operacional é ensaio de update/restore com falhas injetadas em clone descartável. Backup em execução não demonstra recuperabilidade. Restore precisa respeitar modo local/worker, GPU, Central versus tenant e bind web.

Antes de atualizar a frota após as correções: conferir backup restaurável, espaço, commit aprovado, árvore de trabalho, diffs locais e identidade de cada host; promover primeiro em instalação de teste; observar heartbeat, vídeo, gravação, playback e jobs; só depois expandir. Não basta atualizar a mesma branch em todas as máquinas sem preservar particularidades de ambiente.

## 14. Dependências

Foi identificada uma versão Python afetada por advisory específico e uma quebra de reprodutibilidade no Dockerfile da Central. Não foi executado um inventário completo de CVEs transitivos npm/pip/Go/OS. Portanto, “apenas uma vulnerabilidade” seria uma conclusão incorreta.

O pin de dependências diretas Python ajuda, mas não congela automaticamente todas as transitivas. Tags Docker móveis também não identificam artefato imutável. A recomendação é gerar SBOM, resolver builds com lock, consultar advisories atuais, classificar alcançabilidade e atualizar por lotes testáveis. Não atualizar indiscriminadamente toda a stack ML: ONNX/OpenVINO/NumPy/OpenCV e modelos podem ter restrições cruzadas. Compatibilidade e precisão precisam de teste além de import bem-sucedido.

## 15. Código morto, duplicação e limpeza

Nenhum conjunto amplo foi classificado como removível sem ressalva. O worker Go tem uso condicionado; callbacks RTMP têm consumidores; datas antigas em documentos não bastam para declarar obsolescência; referências históricas ao Git anterior não são necessariamente remotes ativos. Duplicação de responsabilidade foi demonstrada em autorização de push, scripts update/restore e lógica de teste que replica implementação.

| Candidato | Classificação | Próxima verificação segura |
|---|---|---|
| `datasets/coco8/labels/val.cache` | Artefato gerado versionado | Teste de regeneração e consumidores de benchmark |
| Backups e patches locais não versionados | Material operacional, não lixo comprovado | Dono, data, sensibilidade, utilidade para recuperação |
| Worker Go legado | Implementação alternativa, não morto | Perfis em uso na frota e política de descontinuação |
| Código repetido de ACL | Duplicação de regra com bug | Centralizar contrato sem mudar permissões legítimas |
| Helpers distintos de update/restore | Duplicação divergente | Testes de comportamento antes de compartilhar funções |
| Serviços/telas gigantes | Complexidade, não prova de código morto | Extrair por domínio depois dos testes de caracterização |

Não apagar backups, patches, modelos, datasets ou compatibilidade legada apenas para reduzir tamanho do repositório.

## 16. Testes ausentes ou insuficientes

1. HTTP concorrente da Central em JSON e PostgreSQL com instalação remota, heartbeat, exclusão e provisionamento.
2. Update/rollback com escritor concorrente e falha em cada fase; restore com perfis/binds/readiness distintos.
3. Matriz push versus ACL de câmera privada, usuário desativado, grupo suspenso e mute.
4. Revogação/exclusão persistente após merge/restart dual; reconciliação seguida de pg-only.
5. Navegador multiaba: refresh, logout offline, resposta atrasada, expiração e reconexão.
6. Reset de senha concorrente com PostgreSQL real e exatamente um vencedor.
7. Legal hold em delete total, delete de câmera, batch, retenção e exportações.
8. SigV4 virtual-host com assinatura validada, não somente string da URL.
9. Offload cron/manual concorrente, mudança de storage, erro parcial e repetição idempotente.
10. Shutdown com SIGTERM e retomada de filas/processos, inclusive falha abrupta.
11. ASGI responsivo durante stop/stop-all, perda de câmera e recuperação de thread.
12. Redis crash/recreate com jobs pendentes e RPO explícito.
13. Investigações acima de 50 registros e paginação/filtros combinados.
14. Gates Central/PostgreSQL e Go obrigatórios; correção das fixtures e expectativas atuais.
15. E2E de streaming/gravação/playback, navegador/aparelho, GPU e carga de frota. Existem testes de pipeline no projeto/CI, mas não foram executados integralmente nesta auditoria.

## 17. Melhorias arquiteturais justificadas

**Política de acesso compartilhada:** expor decisões reutilizáveis e testáveis para API e resolução de destinatários, sem duplicar aproximações da ACL. Justificativa: AUD-003.

**Mutações explícitas da Central:** separar transporte HTTP, serviços de aplicação e repositório; aplicar transações por entidade com concorrência versionada. Justificativa: AUD-001/005/016. Evitar uma reescrita total; migrar rotas progressivamente.

**Máquina de estados de implantação:** preparação, quiesce, checkpoint, migration, start, readiness e rollback com invariantes e estágio persistido. Justificativa: AUD-002/006. Não confundir “há backup” com “há ponto de restauração correto”.

**Estado de sessão com geração:** login/logout/refresh como transições coordenadas, incluindo abas e falhas de rede. Justificativa: AUD-007/010.

**Contratos de evidência:** regra única de preservação e override, com trilha auditável. Justificativa: AUD-009.

**Observabilidade de trabalho real:** readiness separado de liveness, idade de filas, sucesso de backup restaurado e confirmação de acervo. Justificativa: AUD-015/022 e confiança operacional, sem criar probes caros que agravem incidentes.

## 18. Plano seguro de correção

Esta é uma proposta; nenhuma fase abaixo foi implantada nesta auditoria.

| Fase | Escopo | Dependências e critério de saída |
|---|---|---|
| 1 — Críticos | AUD-001 e AUD-002 | Fixtures concorrentes primeiro; prova de preservação de dados em JSON/PG e rollback por estágio; backup restaurável antes de rollout |
| 2 — Bugs importantes | AUD-006, 008, 011, 012, 019; decisões de AUD-009 | Restore em VM de teste; reset com único vencedor; storage mock; busca >50; política de hold aprovada |
| 3 — Consistência | AUD-004, 010, 013, 020, 021 | Reconciliação antes de pg-only; corrigir testes sem enfraquecer contrato; sessão compatível com fase 4 |
| 4 — Segurança | AUD-003, 005, 007, 024 e rotação planejada de credenciais | ACL compartilhada; separar parsing/lock sem regredir AUD-001; browser E2E; atualização de dependências com alcance verificado |
| 5 — Performance/operação | AUD-014, 015, 016, 017, 018, 022 | Medir baseline; liveness/readiness; jobs idempotentes; persistência definida; testes de crash/carga |
| 6 — Refatoração e gates | AUD-023, 025, 026, 028 | Lock de build, SBOM, testes comportamentais, extrações pequenas protegidas por contratos |
| 7 — Limpeza | AUD-027 e candidatos validados | Inventário e backup; remover somente o que tiver ausência de consumidor ou regeneração comprovada |

A ordem temática pedida não deve adiar contenção de exposição ativa: se AUD-003, 004, 005 ou 007 estiver ocorrendo, a contenção e correção sobem junto da fase 1. A fila de fases não autoriza manter vazamento conhecido até terminar refatorações.

Cada correção deve referenciar seu ID, incluir teste que falha antes e passa depois, registrar efeito nos consumidores e ter estratégia de rollback que não destrua dados. Promover em ambiente de teste, observar métricas e só então liberar por instalação.

## 19. Cobertura final por área

| Área | Nível alcançado | O que falta |
|---|---|---|
| API auth, ACL, push, cloud, investigações | Revisão cruzada dirigida + suites + PoCs selecionadas | E2E completo de cada endpoint e todas as combinações de permissão |
| Gravação, retenção, evidências, câmera | Revisão dos fluxos de integridade, exclusão e controle + testes | Captura/restore real em laboratório, falha de disco/rede, inspeção de todos os arquivos |
| Prisma/migrations | Schema e relações cruzados; 64 migrations em banco novo; e2e isolado | Upgrade de bases históricas e diff por servidor |
| Central auth/datastore/instalação/health | Revisão cruzada + reprodução HTTP + suites JSON/PG | Carga grande, SSH real de teste e todos os fluxos comerciais |
| Web | Sessão/estado/polling e consumidores dirigidos; 528 testes | Navegador, vídeo real, UX/acessibilidade e typecheck/build limpo |
| Mobile | Segurança de sessão e contratos dirigidos; 102 testes | Aparelhos, builds iOS/Android, push real e redes móveis |
| IA | Serviço, ciclo de vida, integração e 323 testes | GPU, modelos reais em campo, acurácia representativa e stress |
| Go legado | Inventário e contratos de modo de controle | Execução dos testes Go e comportamento em produção |
| Infra/scripts/CI | Revisão de configuração e scripts críticos; sintaxe e testes dirigidos | Restore completo e rollout canário após correções |
| Vibe operacional | Snapshot de saúde/versão/banco somente leitura | Auditoria longitudinal, cada câmera e recuperação de desastre |
| IBTelecom/Demo/Management/Gateway | Topologia informada e configuração versionada | Inspeção operacional atual por host; não certificados nesta rodada |
| Dependências/segredos | Manifestos, build e advisory específico; busca limitada | SCA/SBOM completa, imagens, histórico Git e inventário de credenciais |

### Conclusão

O trabalho encontrou falhas além de sintaxe e lint e demonstrou que milhares de testes aprovados não cobrem invariantes essenciais de concorrência e recuperação. Há evidência suficiente para iniciar correções pelos IDs, mas não para declarar todo o sistema auditado exaustivamente, todos os servidores atualizados ou ausência de outros problemas. A próxima ação de maior valor é corrigir e provar AUD-001/AUD-002 em ambiente descartável, acompanhada dos controles de segurança prioritários, antes de nova promoção ampla.
