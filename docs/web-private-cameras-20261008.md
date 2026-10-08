# Câmeras privadas pelo navegador — plano e implementação

## Fluxo e decisões

O administrador cadastra uma câmera RTSP ou RTMP, marca **Câmera privada**, escolhe um usuário ativo como proprietário e, opcionalmente, pessoas com acesso individual. O mesmo controle aparece em **Editar câmera → Geral**. Não é necessário criar grupos exclusivos para preservar a privacidade. Desligar a opção significa permissões normais, nunca vídeo público na internet.

O proprietário tem acesso ao conteúdo. Novos compartilhamentos dão somente visualização, inclusive histórico permitido pelo contrato, sem conceder administração global, PTZ ou início de gravação. Permissões avançadas de delegados já existentes em câmeras privadas são preservadas. Ao converter comum em privada, acessos diretos anteriores não selecionados são retirados; permissões de grupo não liberam conteúdo privado. Administradores continuam gerenciando cadastro técnico, mas não ganham acesso automático às imagens.

Alterar privacidade/proprietário/pessoas autorizadas exige confirmação clara. A mensagem inclui o efeito nas gravações antigas. Campos sem alterações não são enviados. Uma revisão do cadastro e outra dos acessos evitam sobrescrever mudanças feitas enquanto a edição estava aberta.

## Servidor e persistência

- Reutiliza `Camera.isPrivate`, `ownerUserId` e `CameraPermission`; nenhuma migração de banco ou alteração automática em câmeras existentes.
- Cadastro administrativo valida proprietário e espectadores ativos antes de criar. Cadastro e permissões nascem na mesma operação Prisma aninhada, sem janela intermediária de exposição. O cadastro pelo app mantém sua cota, proprietário autenticado e política anterior.
- Edição salva cadastro e permissões em transação serializável; falha desfaz toda a transação. Estado desatualizado retorna 409, booleano não literal/dados incompletos retornam 400, usuário sem autorização retorna 403.
- Ao trocar proprietário, o anterior não mantém automaticamente acesso. Pode ser selecionado explicitamente como espectador; nesse caso recebe VIEW, não herda ADMIN de proprietário.
- Ao voltar à câmera comum, remove propriedade e a concessão ADMIN do antigo dono; permissões individuais de outros usuários permanecem, assim como as regras normais dos grupos.
- Lista de usuários para o seletor expõe apenas ID, nome e login, exige ADMIN + cameraConfig e só é consultada com a opção privada ligada. Cache curto em memória, cancelamento de requisição, sem consultas periódicas extras.
- Vídeo ao vivo, gravações, miniaturas e avisos usam o controle de acesso existente. O callback MediaMTX agora revalida usuário ativo, acesso atual e câmera ativa, impedindo um token antigo de continuar autorizando novos acessos após revogação.
- Ao editar a privacidade, reconecta leitores WebRTC/RTSP/RTMP da câmera escolhida e encerra respostas FLV abertas. Caminhos internos `_source`, publicações de câmera e outras câmeras não são encerrados. Requisições HLS passam pela autorização atual; conteúdo já recebido/bufferizado/downloads concluídos não pode ser recolhido.
- Falha ao confirmar reconexão é exibida como pendência, sem fingir sucesso completo. Mudança de proprietário pelo endpoint legado também reconecta leitores.

## Limites reais

É privacidade de acesso dentro do sistema, não criptografia contra alguém que controla o servidor com root. Administradores com poder de alterar cadastro/acessos podem conceder acesso explicitamente; a alteração é auditada. Não existe promessa de isolamento contra administrador malicioso com controle da instalação. Dados já copiados ou quadros recebidos antes da mudança não podem ser apagados remotamente. O usuário vê essa fronteira sem linguagem técnica na configuração normal.

Não muda gravação, RTMP/DDNS, áudio, resolução, FPS, detector, modelo, licenças ou grupos automaticamente. Nenhum APK é gerado. Demo permanece fora do escopo de publicação.

## Validação e publicação

Testes de helper/DTO e regressão de permissões cobrem proprietário ativo, criação normal, valores booleanos estritos, usuários autorizados, transferência, revisão desatualizada e reconexão só da câmera selecionada. Interface tem testes de payload/diferenças/cadastro/edição e renderização React real. O laboratório descartável usa banco/API reais para cadastrar RTSP e RTMP, testar proprietário/delegado/admin/grupo/intruso, revogar token antigo e preservar modo manual/chave RTMP. Os seis testes de vídeo HLS e os avisos existentes também são repetidos nesse laboratório. Não são testes físicos em cliente.

Publicar somente imagens compiladas e assinadas API/web após passar os testes. Preservar banco/configuração com backup e comparar escolhas existentes antes/depois; não reiniciar IA ou ingestão. Atualizar pacote completo aprovado da Central para novas instalações e manter Vibe, Dguardian e IB Telecom na mesma versão. Registrar evidências em `runtime-artifacts/private-*` na Management e o resultado em cada instalação.
