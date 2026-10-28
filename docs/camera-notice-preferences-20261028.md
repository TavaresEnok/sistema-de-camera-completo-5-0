# Avisos de detecção: tempo, sons e perímetro

## Comportamento

- O aviso de cada câmera dura 10 segundos por padrão. O cadastro e a edição, incluindo câmeras RTMP, permitem selecionar 5, 10, 15, 20, 30 ou 60 segundos. A API aceita inteiros de 1 a 120.
- Avisos simultâneos têm prazos independentes. Até três ficam visíveis; uma fila curta evita que a chegada de outra câmera remova um cartão antes do prazo. Itens ainda não exibidos expiram após 30 segundos para não reproduzir histórico antigo.
- “Atenção (atual)” preserva os quatro bipes originais. “Urgente”, “Sirene”, “Alarme de invasão” e “Bipes rápidos” oferecem padrões mais fortes de aproximadamente um segundo. “Ouvir som” permite escolher antes de salvar. A reprodução normal respeita o silenciamento global.
- O servidor filtra o aviso usando o perímetro salvo. Objetos usam o centro da base da caixa; movimento usa os componentes mascarados. Inclusões e exclusões são respeitadas. Em configuração somente com linhas, uma detecção genérica não basta: exige travessia confirmada da linha configurada e no sentido permitido.
- O feed legado de movimento usa as mesmas verificações de licença, permissão e perímetro do feed combinado.
- A mudança filtra avisos, sem remover eventos da timeline, alterar a seleção de classes ou armar gravações.

## Migração e publicação

`20261028120000_camera_notice_preferences` adiciona somente `Camera.noticeSound` (padrão `attention`) e `Camera.noticeDurationSeconds` (padrão `10`). `noticeSoundEnabled` existente é preservado. Nenhum som é habilitado automaticamente.

O instalador de atualizações API/web admite a transição com `--approve-notice-preferences-schema`, verificando hash fixo do SQL, preservação de migrações existentes e mudanças limitadas aos dois campos. Assinatura e hash do pacote continuam obrigatórios.

O build `infra/Dockerfile.notice-preferences` reutiliza dependências validadas; as imagens finais contêm apenas código compilado. A atualização não precisa reiniciar os serviços de IA, MediaMTX ou ingestão RTMP.

## Validação

Regressões cobrem geometria em resoluções diferentes, inclusão/exclusão, linha removida e direção, metadados insuficientes, classes licenciadas, filtros de acesso, prazos individuais, fila e duração padrão, validação dos DTOs, padrões de áudio de um segundo, silenciamento e prévia explícita. O formulário é renderizado com as opções selecionadas e passa na verificação de tipos.

Não se trata de uma medida de precisão do modelo nem de um teste físico em cada câmera. A lógica do aviso é conferida com eventos e geometrias; a detecção e o acompanhamento continuam usando o processamento existente.
