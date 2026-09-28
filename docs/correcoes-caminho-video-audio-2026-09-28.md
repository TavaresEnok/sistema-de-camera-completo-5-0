# Correções do caminho de vídeo/áudio — 28/09/2026

Referência: `auditoria-caminho-video-audio-2026-09-28.md`.

## Implementado no código

O estado de implantação mais recente está na seção final. A tabela abaixo registra a cobertura técnica dos achados, incluindo trabalhos ainda pendentes.

- Áudio preserva vídeo H.264 da fonte selecionada, inclusive RTMP 1080p. HEVC continua convertido na grade de compatibilidade; original com áudio preserva HEVC. Isso pode consumir mais banda que a antiga redução a 360p, mas não mais que o mesmo H.264 repassado sem áudio, exceto pela trilha de som.
- Grade e variante com áudio seguem a mesma política de fonte e de proporção da imagem.
- Web e app mantêm a variante preparada ao mutar/desmutar. Primeira ativação pode negociar nova sessão. A sessão é liberada pelo ciclo normal ao fechar/sair da câmera.
- Contagem reconhece publicadores RTSP dos caminhos de entrega; caminho apenas cadastrado não recebe isenção do limite.
- Limite real adicional por locks do kernel no início de cada FFmpeg. Partidas concorrentes disputam slots; término/crash libera o lock. Exige `flock`, disponível na imagem MediaMTX examinada; falha fechada se ausente. Caminhos antigos só recebem esse controle quando reconciliados.
- Ajustes de política no mesmo publicador aguardam ausência de leitores; consultas de runtime inconclusivas preservam sessão. Mudança explícita da origem não é mascarada. O bitrate instantâneo da cena não recalcula o comando.
- FPS usa delta de quadros apresentados, reinicia janela por câmera/modalidade e deixa de mostrar número antigo quando não recebe frames.
- Diagnóstico da API separa encode de áudio e vídeo; não anuncia limite de resolução quando faz cópia; remove multiplicador fixo de CPU apresentado como custo.
- RTMP identifica ausência de áudio e Opus pelas trilhas reais: evita conversor sem áudio conhecido e copia Opus conhecido. RTSP sem metadado continua conservador; não adivinha codec pelo cadastro.
- URL de sessão WHEP web restrita à mesma origem; limpeza limitada por timeout e sem seguir redirecionamento.
- Sondagens de estatísticas dos players mobile sem chamadas simultâneas sobrepostas.
- Captura de poster não abre fonte de câmera explicitamente desativada.
- Modelo SRS da Gateway bloqueia RTMP PLAY em todos os seus vhosts, preservando publish/forward. A configuração remota não foi substituída: contém particularidades, inclusive demo-04, que devem ser preservadas.
- Evento local `s2cam:live-receiver-sample` com contadores de vídeo, perda, jitter, buffer, tempo de decode, congelamentos, RTT e relay; sem SDP, URLs ou endereços ICE. Nenhum envio automático ao servidor.

## Cobertura do relatório e pendências reais

| Achado | Estado |
|---|---|
| V01/V02 | Corrigidos no código; primeira negociação de áudio continua possível. Falta ensaio no aparelho do usuário. |
| V03/V04 | Contagem, exceção por prontidão e admissão no processo corrigidas. Orçamento ponderado por codec/resolução ainda não implementado; limite atual é conservador por processo. |
| V05/V06 | Contador e diagnóstico corrigidos; precisam chegar à versão servida. |
| V07 | Receptor já vigia quadros de vídeo; instrumentação ampliada. Watchdog servidor continua por bytes, sem prova por trilha; não foi inventada métrica ausente na API. |
| V08 | Bitrate estável e proteção de leitores implementados. Migração totalmente versionada de grafo não implementada. |
| V09/V10 | Consolidação de fontes RTSP/IA/gravação não executada: exige preservar main/sub, fonte original das gravações, autenticação e recuperação. Alterar só o nome do caminho quebraria limpeza/reconciliação. RTMP já compartilha entrada. |
| V11 | Codec/ausência tratados quando runtime informa. Falta probe de áudio RTSP compartilhado e validação HLS/HEVC/Opus nos aparelhos suportados. |
| V12 | Seleção/mute corrigidos; matriz completa de dispositivos ainda não executada. |
| V13 | Proteções implementadas; nenhuma exploração foi realizada. |
| V14 | Bloqueio PLAY aplicado e verificado nos sete vhosts da Gateway SRS 5; publicação e encaminhamento preservados. Evidências na seção final. |
| V15/V16 | Instrumentação de receptor adicionada; medições A/B, origem/PTS/GOP, TURN e carga ainda pendentes. Nenhuma alteração especulativa de timestamp. |
| V17 | Captura bloqueada para desativadas; origem exata dos pedidos antigos ainda deve ser rastreada. |
| V18 | Git não equivale a implantação: API/web/APK/Gateway não foram atualizados nesta etapa. |

## Validação

- API: compilação TypeScript aprovada. Bateria ampla inicial: 1.631/1.633; uma falha de fixture (campos omitidos versus câmera explicitamente desativada) corrigida, outra era ausência de arquivos operacionais no contêiner de teste. Reexecução direcionada da regressão RTMP passou; dez testes operacionais passaram após montar os arquivos corretos.
- Testes comportamentais novos exercitam cópia H.264 com áudio, HEVC por modalidade, proteção de leitores ativos, identificação de áudio e admissão concorrente/liberação de slot.
- Web: 541 testes aprovados após incluir telemetria; testes de origem WHEP e cálculo de FPS incluídos.
- App: TypeScript aprovado e 115 testes aprovados com os mocks nativos oficiais do repositório.
- SRS: configuração validada em processo isolado (`-t`), sem rede e sem reiniciar produção; versão local de teste 6.0.191, não confundir com Gateway 5.

## Ensaio de produção ainda necessário

Identificar cliente/navegador; implantar API/web com rollback e publicar novo APK conforme o fluxo da Central. Drenar a sessão antiga da sala para aplicar a política sem expulsar leitores. Medir mesma câmera/qualidade/rede com e sem áudio: FPS origem/saída/receptor, CPU por processo, banda, perda, RTT e sincronismo A/V. Testar HLS e HEVC antes de declarar compatibilidade geral.

Captura local temporária das métricas pelo técnico no navegador:

```js
const samples = [];
const collect = ({ detail }) => {
  samples.push(detail);
  if (samples.length > 300) samples.shift();
};
window.addEventListener('s2cam:live-receiver-sample', collect);
// Ao terminar:
window.removeEventListener('s2cam:live-receiver-sample', collect);
console.table(samples);
```

Não declarar todas as 18 linhas concluídas nem prometer 20 FPS: a economia e a estabilidade precisam ser comprovadas em execução.

## Continuação operacional

- Gateway consultada: SRS 5.0.213, sete vhosts incluindo demo-04. Configuração completa sem bloqueio PLAY confirmada. Acrescentado bloqueio nos sete, mantendo destinos e timeouts; validação `srs -t` aprovada na própria versão 5.0.213. Backup remoto: `/opt/ajustcam-gateway/srs/srs.conf.before-play-block-20260928`. SIGHUP enviado; contêiner continuou em execução com a mesma data de início e zero reinícios. Sessões anteriores não foram expulsas. O mecanismo de recarga é documentado em https://ossrs.io/lts/en-us/docs/v5/doc/http-api .
- Reaproveitamento normal da grade pela IA agora exige igualdade da URL física pedida, incluindo canal, subtipo e credenciais; não altera os fallbacks explícitos de recuperação. Modalidade de áudio não sobrescreve o registro da fonte compartilhada.
- Mais 35 testes de compartilhamento/registro/identidade aprovados e TypeScript da API aprovado.
- Imagens de produção API/web compiladas, ainda sem substituir os contêineres. Durante preparação do rollback, Docker não encontrou os IDs das imagens dos contêineres atuais; tentativa de snapshot também falhou com `content digest ... not found`. Não reiniciar esses contêineres sem uma recuperação verificável.
- IBTelecom acessível: checkout `667b4fa`, diferente do código corrigido; nenhuma implantação feita ali nesta continuação. Management acessível, porém projeto não está em `/opt/drac` e Docker exige sudo; localização/inventário ainda em andamento.

### Atualização da Vibe

O problema de conteúdo Docker das imagens atuais foi contornado sem remover dados: imagens anteriores `drac-live-rollback-api:7081265` e `drac-live-rollback-web:7081265` foram verificadas (Node executável; nginx com tmpfs de runtime aprovado) e preservadas sob `drac-video-rollback-api:20260928` e `drac-video-rollback-web:20260928`. São imagens de recuperação anteriores, não snapshots exatos da sessão atual.

API/web da Vibe foram então substituídos com `compose up -d --no-deps api web`; ambos ficaram **healthy**. Banco com 65 migrações aplicadas e código com 65 migrações; nenhuma nova migração adicionada por estas correções. MediaMTX/Redis/Postgres/ingestão não foram reiniciados. Imagens geradas contêm as mudanças de código até `945c1f7` (o commit foi criado depois do início do build).

A sessão da sala permaneceu no comando antigo (`libx264`, sem admissão por flock), pois já possuía leitor. Não foi expulsa. Solicitado fechar a visualização por cerca de 30 segundos para reconciliar a configuração e medir a nova sessão. Isso significa que **serviço atualizado ainda não comprova correção ativa naquele processo antigo**.

Management: diretório encontrado `/opt/ajustcam-management`, não é raiz Git; não possui `sudo`. Acesso administrativo por `su` funcionou. Central em execução identificada como `ajustcam-central:cc32efa`. Nenhuma troca da Central ou geração de APK realizada nesta etapa.

### Incidente na validação e recuperação (substitui o estado anterior da Gateway)

O estado imediatamente após SIGHUP não foi suficiente para validar a Gateway: posteriormente o SRS estava **exited**, e as entradas da Vibe fecharam por timeout aproximadamente às 15:44 UTC. A configuração anterior foi restaurada do backup e o SRS iniciado novamente. As publicações voltaram (primeira amostra: 11 RTMP; sala com vídeo H.264 e um leitor). A causa exata da saída do SRS ainda não foi estabelecida; não atribuir somente à regra PLAY sem reprodução. O bloqueio PLAY **não está mais aplicado na Gateway**, embora o template protegido continue no Git, pendente de validação completa de forward/reload antes de reaplicar.

Um segundo defeito foi encontrado na admissão: variáveis locais de shell são expandidas pelo MediaMTX antes da execução, causando `sh: out of range`. O limitador foi refeito com slots literais, sem `$slot`, e o caminho afetado foi corrigido pela API. Teste de regressão exige ausência de expansão de variáveis e testa exclusão concorrente/liberação. Sete testes do pipeline passaram; nova imagem da API compilada para implantação.

Management: checkout real `/opt/ajustcam-management/repo` avançado por fast-forward até `5e7c629`, usando root para referências Git que pertenciam a root. Arquivos locais de cliente Vibe e ambiente preservados. Agente de build ativo; último APK Vibe consultado é de 21/09, commit `b3aed31`. Atualizar o checkout não atualiza esse APK publicado.

### Implantação e APK confirmados

- Vibe: API recompilada com a correção de admissão `36b94824997b4b98671c97eba1802fdb1d36569a`; API e Web saudáveis. `DRAC_VERSION` corrigida para o mesmo commit e API recriada para reportá-lo. Verificador operacional passou, com avisos de credenciais administrativas iniciais inválidas e rotas autenticadas não testadas. A variante de áudio da sala foi sondada com H.264 1920×1080 e Opus; diagnóstico indica cópia de vídeo e conversão somente do áudio. A amostra não comprova estabilidade contínua de FPS no navegador.
- IBTelecom: checkout, imagens API/Web e versão reportada atualizados ao mesmo commit. Verificação de serviços, exposição, banco, rotas públicas e watchdog passou; login/rotas autenticadas permanecem sem validação por falta das credenciais atuais. Imagens exatas anteriores preservadas como `drac-video-rollback-api:20260928` e `drac-video-rollback-web:20260928`. Serviços de banco e vídeo não foram recriados nesta implantação.
- Instalação limpa: gate executado no commit publicado `36b9482`, concluído com código 0. Instalador terminou, serviços saudáveis, login administrativo e cinco rotas autenticadas aprovados. Readiness: 53 checks, seis atenções e zero bloqueios. Verificador final deixou aviso de Git não acessível no contexto root do teste; a versão fixada foi confirmada pelo instalador. Ambiente e volumes isolados do gate removidos ao término.
- Central: commit `36b9482` promovido por sua API administrativa após os gates reais de instalação limpa e matriz. SHA-256 do instalador: `391da0a21846b0a0f0ed882c0f5ff1cd9cc2c6b80f700f2e7c39b716a9361f40`. Management recebeu fast-forward; arquivos locais preservados. Remoto `legacy-origin` removido dos checkouts Vibe, IBTelecom e Management.
- APK Vibe: job `1790612859295-vibe` concluído em 28/09/2026 às 16:31:29 UTC, pela Central e agente oficial, usando o commit aprovado. Pacote `com.s2cam.vibe`, versão exibida `2.0.1`, versionCode **39** (anterior: 38); assinatura verificada e certificado SHA-256 igual ao APK anterior. APK SHA-256: `e61090354a3ae46069d230b79b4c771626d107f426df0625cb2a9fec9f5c69df`. AAB SHA-256: `255f592793d23647785444d8eb824a0e72c58b546bdf585d9986dcb5619b9029`. Metadados indicam `sourceDirty:false`. APK e AAB anteriores copiados na Management com sufixo `.before-video-audio-20260928`; hash do backup APK conferido. Publicação: https://s2cam.com.br/apk/drac-vibe.apk . Instalação e comportamento no aparelho ainda precisam de ensaio.
- Gateway: permanece operacional com a configuração restaurada, **sem bloqueio PLAY**. Nova reprodução isolada na versão SRS 5.0.213 aceitou as sete regras e permaneceu ativa após HUP, mas sem publishers/forward ativos. Esse resultado não explica a saída anterior em produção e não autoriza declarar V14 resolvido. Containers temporários e configuração de teste foram removidos.

Continuam pendentes os trabalhos técnicos explicitados na tabela, especialmente orçamento ponderado, compartilhamento RTSP completo, monitoramento por trilha, sondagem compartilhada de áudio RTSP e medições A/B nos clientes. Implantação e build não substituem essas validações.

### Bloqueio RTMP aplicado e verificado — substitui a pendência V14

Em 28/09/2026, aproximadamente às 16:45 UTC, foi aplicado `security { enabled on; allow publish all; deny play all; }` nos sete vhosts da Gateway, mantendo os destinos originais. O template agora inclui também demo-04 → `10.10.0.23:1935`.

Validação isolada usou **a imagem exata de produção**, `ossrs/srs@sha256:b429bdb565f0a533e60634856760a500a1b673f8cadce072b2a2eb2674cd7b31`, SRS 5.0.213, em uma rede Docker interna sem portas públicas. FFmpeg publicou vídeo sintético H.264/AAC numa Gateway de teste, que o encaminhou a outra instância SRS. Com a regra ativa, ffprobe da Gateway falhou e o SRS registrou `1053(SecurityDeny)`; ffprobe da origem recebeu H.264 e AAC. A regra foi desligada e religada por HUP enquanto um leitor acompanhava a origem: leitura direta voltou a funcionar com security desligada, foi negada ao religar e o encaminhamento continuou com quadros crescentes, sem reiniciar o SRS. O contador do leitor passou de 254 para 697 quadros, sem drops reportados nessa amostra. O teste usou explicitamente `-c conf/srs.conf`; o comando padrão da imagem lê `conf/docker.conf` e não serve como evidência da configuração montada.

Aplicação: configuração completa preparada em arquivo temporário, sete blocos conferidos e `srs -t` aprovado na mesma imagem. Backup remoto preservado em `/opt/ajustcam-gateway/srs/srs.conf.before-validated-security-20260928`. Para impedir que a recarga automática leia um arquivo parcialmente escrito, o contêiner foi brevemente pausado durante a cópia integral; o inode do arquivo montado foi preservado (`1439110`), depois o contêiner foi liberado e recebeu HUP. SRS manteve início `2026-09-28T15:52:32.239306187Z` e zero reinícios. A causa do incidente anterior continua não estabelecida; a proteção de escrita não é uma conclusão causal.

Verificação externa: sete conexões ffprobe ao IP público/1935 com tcUrl de cada vhost (seis domínios e fallback por IP), usando nome de stream sintético e sem credenciais de câmera. Todas falharam; sete erros `SecurityDeny` foram registrados na Gateway entre 16:45:35 e 16:45:37 UTC. Antes e depois, Gateway reportou dez publicações ativas. Vibe manteve trinta entradas RTMP prontas após a recarga. Esses números são observações dos dois servidores, não contagens equivalentes da mesma frota.

A regra protege novas conexões PLAY, conforme https://ossrs.net/lts/en-us/docs/v5/doc/security . Ela não encerra leitores previamente conectados; não houve expulsão indiscriminada de sessões. A reprodução autorizada no navegador/app continua via a instalação, não por PLAY público da Gateway.

Para futuras alterações: preservar os sete destinos, validar a configuração completa com a imagem exata, guardar backup, evitar troca de inode do bind mount e leitura de conteúdo incompleto, recarregar e conferir publicações/saúde/negação explícita nos logs. Se houver regressão, restaurar o backup com o mesmo cuidado de escrita; iniciar o SRS somente se tiver saído. Não substituir a configuração remota inteira por um template sem comparar suas particularidades.

## Segunda etapa autorizada — compartilhamento, capacidade e saúde por trilha

Esta seção atualiza a cobertura de V03/V04, V07, V08/V09/V10, V11 e V17. Não substitui medições nos aparelhos nem declara implantação antes dos gates.

- Admissão ponderada: cópia de vídeo/conversão só de áudio custa um ponto; conversão pequena conhecida custa dois; HEVC pesado ou dimensões/FPS desconhecidos custam quatro. `MEDIAMTX_MAX_TRANSCODE_POINTS=10` é um orçamento relativo configurável, não uma previsão de percentual de CPU. Reserva atômica com locks de kernel, teto independente por processo e liberação automática na saída. Compatível com o `flock` BusyBox da imagem real; sem variáveis de shell que o MediaMTX possa expandir prematuramente.
- Probe único de metadados por URL exata e transporte: coalescência concorrente, cache limitado a 512 entradas, sucesso por cinco minutos e falha por dez segundos. Codec de vídeo e codec/ausência de áudio compartilham a mesma sonda. Credenciais rotacionadas e transporte diferente não reutilizam a identidade antiga.
- Origem RTSP bruta compartilhada por live, áudio, gravação, clipe e IA compatível: hash da URL completa e transporte; não troca main por sub, não transforma a fonte de gravação nem recodifica a origem. Alterações criam uma nova geração, preservando os leitores da anterior. Falha no controle retorna a origem direta. Cache/concorrência limitados; reconciliação após recriação do MediaMTX; limpeza conservadora, sem remover caminhos com leitores ou ainda referenciados por entregas sob demanda. Flag reversível: `CAMERA_SHARED_RTSP_ENABLED`.
- Autorização mantém fontes brutas privadas: clientes externos não ganham acesso a elas. Worker FFmpeg local usa loopback sem expor a senha administrativa no argumento; consumidores internos continuam autenticados.
- Watchdog por trilha: até quatro probes de pacotes por tick, em rodízio, somente em fontes prontas com leitores. Não decodifica imagens. Detecta áudio sem vídeo e vídeo sem áudio pelos timestamps; exige três amostras conclusivas antes de recuperar. Timeout/erro/informação insuficiente permanecem desconhecidos e não provocam reset. Tick não se sobrepõe; mantém o freio contra reinícios repetidos. Recuperação de geração bruta conserva a URL física exata. Diagnóstico expõe horário/estado de cada amostra sem inventar FPS. Flag: `MEDIAMTX_TRACK_HEALTH_ENABLED`.
- Limpeza de FFmpeg órfão: as variáveis locais do script antigo também eram expandidas prematuramente pelo MediaMTX. O script agora é decodificado no momento da execução, preservando a restrição a processos FFmpeg que publicam exatamente naquele caminho.
- Posters de câmeras desativadas: não recebem novos tokens de poster e pedidos antigos autenticados são recusados antes de consultar cache ou iniciar captura. Não foram excluídos cadastros, imagens ou gravações.

### Evidências anteriores à implantação

- Compilação TypeScript sem emissão passou; bateria direcionada: **87 testes, 87 aprovações**. Inclui admissão concorrente/liberação, cache compartilhado, rotação de credenciais, geração main/sub, recuperação, perdas independentes de trilhas, proteção de acesso e bloqueio de poster.
- Ensaio isolado com a imagem exata MediaMTX usada na Vibe (`sha256:65a3d7fff1debd4a33846eb0f3c28326ecb871d1359b6ad951848ace91ea1b20`), rede interna e vídeo sintético: **três leitores / uma conexão RTSP com a origem**, em H.264/AAC e HEVC/AAC. Foram observados respectivamente 60 e 56 pacotes de vídeo em cerca de três segundos de fonte nominal 20 FPS, com áudio preservado. Isso prova o compartilhamento sem recodificar, não uma matriz de navegadores ou comportamento sob perda WAN. Contêineres/rede temporários removidos.
- Primeira execução geral: 1.654 testes, 1.652 aprovações, um teste de integração isolada pulado por padrão e uma falha ambiental (Dockerfile não montado no executor). A execução com montagem corrigida será registrada após terminar; não foi escondida nem tratada como aprovação integral.

### Limites que ainda exigem evidência externa

O APK Vibe versão 39 já publicado contém as correções do receptor; esta etapa altera a API, não o aplicativo. O teste no aparelho do usuário e uma matriz real Android/iOS/navegadores/HLS/HEVC/Opus/TURN continuam necessários. Não há resultado desses aparelhos nesta seção. Compartilhar a origem reduz sessões duplicadas, mas não elimina a decodificação legítima na IA nem limita toda a CPU do servidor. Timestamp avançando prova transmissão, não prova que a imagem visual não esteja congelada dentro da câmera. Migração de entrega preserva leitores ativos; hooks e limites novos só valem quando o caminho antigo drenar/reconciliar. A causa histórica da saída anterior do SRS continua sem evidência causal conclusiva.
