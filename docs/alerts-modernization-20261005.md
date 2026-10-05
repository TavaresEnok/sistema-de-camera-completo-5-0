# Alertas operacionais: atualização de 05/10/2026

Publicado na Central, sem reiniciar API/IA/mídia dos clientes.

## O que mudou

- Perfil padrão `customer`: mensagens simples sobre câmera/servidor sem comunicação, espaço e gravações. Alertas internos/desconhecidos não são enviados a clientes.
- Perfil opcional `technical`: avisos internos para um destino de suporte. O perfil é escolhido por instalação; não representa dois destinos simultâneos.
- Tempo padrão de confirmação: 10 minutos para câmera e servidor, editável entre 1 e 1440. O estado do painel continua usando o limiar existente de 180 segundos; ele não é o prazo de notificação.
- Câmeras são identificadas pelo nome quando o heartbeat fornece a lista. Versões sem lista recebem aviso agrupado, sem inventar nomes.
- Dados incompletos, câmera desativada, status desconhecido e ausência de leitura do disco não produzem recuperação falsa. Tempo sem observação recente não conta como queda confirmada de câmera.
- Recuperação positiva, somente depois de confirmação de entrega do aviso correspondente.
- Fila por instalação persistida no datastore já existente (payload JSON no PostgreSQL/arquivo). Nenhuma migração de schema.
- Até oito problemas confirmados agrupados por mensagem/canal. Quatro instalações processadas em paralelo, com rodízio; ciclo padrão de 15 segundos. Estado e fila limitados a 1000 entradas por instalação; histórico de tentativas limitado a 100 registros.
- Novas tentativas com espera crescente, até oito tentativas; `retry_after` do Telegram respeitado. Token inválido/destino bloqueado exigem corrigir o cadastro. Um teste manual confirmado retoma os avisos falhos daquele canal.
- Canal já entregue não é reenviado quando outro canal falha. Mudança de destinatário cancela a fila antiga em vez de reapontá-la.
- Envio automático e teste manual não seguram o portão do datastore durante I/O externo. Teste concorrente não sobrescreve configuração nova.
- Sucesso do Telegram exige `ok:true`, não apenas HTTP 200. Erros de rede não incluem URL/token. E-mail tem prazos por etapa e prazo total de 30 segundos.
- Tela permite perfil, categorias, tempos, recuperação, teste e acompanhamento de pendências/falhas. Confirmação de salvamento/teste permanece após atualizar a tela.
- Bot próprio por instalação continua disponível. Bot compartilhado pode ser fornecido por `CENTRAL_TELEGRAM_BOT_TOKEN`, somente na configuração protegida da Management; cada instalação escolhe seu próprio grupo.

## Evidências

- Commit de implementação: `8c1adc96a2ae53a5705d91f74654c910913c8659`.
- Imagem publicada: `drac-central:20261005-notifications-v2`, identidade `sha256:a9af1bd29ff766d3b41622640da0be12a1395bc7a886e255e9b115717e9fa379`.
- Suíte ampla durante desenvolvimento: 569 testes, 556 aprovados, zero falhas, 13 ignorados. Ajustes finais revalidados por 57 testes específicos, todos aprovados.
- Teste HTTP com servidor real e transporte Telegram simulado: autenticação, cadastro, observação, persistência e confirmação de entrega. Teste de lentidão demonstrou que um envio não bloqueia alterações da frota e não sobrescreve destino alterado durante o teste.
- Navegador contra Central isolada, sem portas públicas e sem destinatários reais: zero erros de script; perfil cliente, tempos e salvamento conferidos. Encontrado e corrigido o desaparecimento do feedback após `load()`.
- Produção: `/api/ready` ready, datastore true, queuedMutations 0. Oito instalações continuam cadastradas, perfis padrão cliente/10 minutos, zero envios pendentes ou falhos.
- Fingerprint comercial antes/depois idêntico: `7703d0c31013708cfef1474d43d02a9fc2213d9795ec834b5db508f7c833e214` (licenças, limites, restrições, vínculos de dispositivo e ativação Telegram).
- Painel Vibe HTTP 200 e Dguardian `/api/health/ready` com seis verificações OK após publicar.
- Logs pós-publicação: zero erros do worker. Backup da Central por `pg_dump -Fc` e lista do `pg_restore` verificados antes da troca.
- Após heartbeats reais: snapshots por câmera presentes para IB Telecom (28 registros) e Vibe (34); Dguardian com zero câmeras. Isso confirma recebimento do bloco, não estado online de cada câmera nem entrega de Telegram.
- Amostra ociosa, com canais desativados: Central 0,01% CPU / 57,04 MiB. Não é teste de capacidade sob envio intenso.

## Operação e limites

Central → selecionar instalação → Alertas. Cadastre um bot e um destino, salve e use Enviar teste. O token específico da instalação continua cifrado e nunca aparece na leitura pública. Sem dados de bot/grupo não há envio real.

Na publicação nenhuma das oito instalações possuía Telegram configurado; nenhum destinatário foi habilitado ou mensagem real enviada. Os testes de transporte foram simulados, não prova de recebimento pelo Telegram/usuário. Registrar o bot no BotFather e definir o grupo são passos do dono da conta; não foi criado um bot em nome dele.

Confirmação do Telegram significa aceitação pelo serviço, não leitura humana. Em timeout ou queda entre envio e gravação do resultado, uma repetição excepcional pode ocorrer: Telegram não fornece uma chave de idempotência para `sendMessage`. Não se promete entrega exatamente uma vez.

Servidor sem comunicação não comprova interrupção de gravação local. Os prazos começam na observação do problema e são acrescidos do ciclo, intervalo do heartbeat, fila e disponibilidade do serviço de mensagens.

Os alertas locais antigos do watchdog continuam sendo uma ferramenta de suporte; este trabalho migra a entrega de clientes pela Central, sem reescrever arquivos assinados nas instalações. Não cadastre grupo de cliente no canal técnico local.

## Publicação e recuperação

Foi acrescentado `/opt/ajustcam-management/repo/infra/management/docker-compose.notifications.yml` ao conjunto anterior de quatro overlays, preservando montagens de licença, publicação e artefatos. Operação futura deve manter esse overlay.

Backup protegido: `/opt/ajustcam-management/backups/notifications-upgrade-20261005/database.before.dump` (772262 bytes, modo 0600) e `image.before.txt`. Rollback de aplicação: executar compose com o conjunto anterior, sem o overlay notifications, mantendo o banco atual. Não restaurar banco antigo automaticamente; isso poderia perder alterações posteriores de licença/configuração.
