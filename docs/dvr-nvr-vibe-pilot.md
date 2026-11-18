# DVR/NVR — Vibe e Dguardian

O piloto está autorizado na Vibe e na Dguardian. Cada instalação tem seu próprio cadastro de gravadores.

## Operação

Infraestrutura → DVR/NVR → Adicionar gravador. Informe nome, IP, credenciais e grupo ativo. As portas ficam em Conexão avançada. O cadastro salvo ainda não comprova acesso ao vídeo.

Use Buscar canais para consultar ONVIF ou Manual para informar canal/caminho. A descoberta agrupa perfis pelo VideoSourceToken, sem escolher streams de câmeras diferentes pela resolução. É limitada por tempo: resultados parciais nunca significam inventário completo. Quando a origem não pode ser identificada, não se inventa um canal.

Verifique o vídeo de cada canal e confira a imagem antes de importar. A importação valida novamente o acesso. Novos canais começam com gravação manual, gravação desarmada, IA e avisos desligados e retenção herdada do grupo. Cada canal consome uma posição da licença de câmeras.

Canais importados ficam em DVR/NVR para cadastro e no Ao Vivo para operação. Câmeras mostra avulsas por padrão, com filtro para incluir todos. Configurar abre a edição já existente de vídeo, gravação e avisos. Eventos embarcados do gravador não são habilitados neste piloto; use a detecção do S2Cam.

O vínculo de câmera já cadastrada preserva UUID, gravações e regras. Exige mesma conexão, credencial e grupo; câmeras privadas e câmeras que dependem de eventos embarcados não são adotadas por este fluxo. Não se transferem permissões nem se muda grupo durante o vínculo.

Conexão é administrada pelo gravador. Como o pipeline atual exige campos de conexão por câmera, eles são mantidos como cópias cifradas sincronizadas em transação. Alterações de conexão exigem canais desativados; reativá-los usa o novo acesso. Grupo e fabricante de um gravador com canais não podem ser trocados neste piloto.

## Escopo

Inclui conexão RTSP, descoberta ONVIF e caminhos conhecidos de Intelbras/Dahua/Hikvision, com caminho manual para outros equipamentos. Isso não é homologação universal de uma marca. É obrigatório validar modelo/firmware em equipamento real.

Não inclui reprodução do HD do gravador, eventos nativos, configuração de disco/firmware, acesso P2P por número de série nem recuperação de lacunas. O histórico da página Reprodução continua sendo o acervo do S2Cam.

## Segurança e implantação

`RECORDERS_ENABLED=true` na API das instalações autorizadas; o backend retorna 404 quando desligado e o menu usa a flag pública. Rotas exigem ADMIN e cameraConfig, com limitação de sondagens, política de destinos de câmera e credenciais cifradas. Senhas nunca são retornadas por `/recorders`.

Migração aditiva `20261116140000_recorders`: tabela Recorder e vínculo opcional, FK restritiva e unicidade gravador/canal em Camera. Não converte nem recadastra câmeras existentes. Remover tabela/coluna durante rollback apagaria vínculos; se necessário, voltar às imagens anteriores mantendo a migração e os dados.

O deploy assinado tem aprovação específica por hash e aceita os hosts `vibe` e `dguardian` para o piloto. Faz backup e confere as escolhas de gravação. Atualiza API/web e preserva imagens/contêineres de IA, transporte e banco. Há pausa breve da API; reconciliação após boot precisa ser verificada.

## Verificação

- Testes backend: agrupamento multicanal (32 fontes), recusa de perfis ambíguos/URLs arbitrárias, idempotência, cota por canal, falha parcial, grupo suspenso, flag e edição de conexão ativa.
- Verificação TypeScript API/web e build.
- Migração contra cópia somente de schema em PostgreSQL isolado; verifica unicidade e impedimento de remoção de gravador com canal.
- Navegador com API simulada e rede bloqueada: desktop/celular, senha oculta, cadastro, verificação/importação manual e feature desabilitada.
- Compatibilidade de hardware pendente até disponibilização de gravador de teste.

## Publicação e conferência em 16/11/2026

Publicado somente na Vibe, runtime `372b669e84c48531ce0be637cce4eadf3b58b37f`.
O management foi usado apenas para compilar/assinar. Dguardian e IB Telecom
não receberam este pacote. Naquela publicação, o instalador exigia o hostname `vibe`.

- API e painel saudáveis; migração aplicada após backup do banco.
- IA, MediaMTX, ingestão RTMP, PostgreSQL e Redis mantiveram contêiner, imagem e início de execução.
- Inventário preservado: 36 câmeras, 35 habilitadas e duas com gravação armada, como antes da atualização.
- API de gravadores retorna 401 sem login e 200 para o administrador. Cadastro vazio retorna 400, sem criar registro.
- Navegador contra a Vibe real: desktop/celular, abertura e cancelamento do cadastro, senha oculta e recarga mantendo login. Sem erros JavaScript nem escrita de configurações.
- Nenhum gravador ou canal fictício foi criado no banco de produção.

O teste de navegador real está em `apps/web/tests/recorders-vibe-smoke.cjs`.
Recebe usuário/senha por stdin, só permite a origem Vibe e bloqueia escritas de
aplicação. Login/renovação de sessão são necessários ao teste; não usa logout
global, que revogaria outras sessões do operador.

A implementação desta etapa está entregue. Homologação de vídeo em equipamento
real depende de informar modelo, endereço alcançável pela Vibe, portas e uma
credencial de teste. Reprodução do HD e eventos nativos continuam fora desta etapa.
