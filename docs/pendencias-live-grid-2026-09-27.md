# Fechamento das pendências — Ao vivo / grade

## Implementação

- Sessões manuais persistidas em PostgreSQL, com prazo absoluto que não é renovado pelo reinício da API.
- Comandos serializados por câmera mediante advisory lock; posse temporária por instância, renovada a cada ciclo de recuperação de 5 segundos.
- Parada solicitada em outra instância é processada pelo dono. Posse expirada permite retomada; watchdog local encerra o processo sem depender de novo polling SQL.
- Encerramento aguarda operações em andamento antes de parar processos e liberar posse. Falha de transação encerra efeitos externos já iniciados.
- Política contínua permanece protegida. Recuperação de sessões aplica-se ao gravador oficial `local`; o worker Go legado mantém o comportamento anterior.
- Recuperação explícita dos layouts antigos do navegador: confirmação de propriedade, separação por usuário, filtragem das câmeras permitidas, preservação do original e prevenção de nova importação automática.

## Verificação reproduzível

- `apps/api/tests/manual-recording-sessions.e2e.ts`: banco descartável, migração real, prazo após reinício, concorrência, parada remota, proteção da contínua, expiração, watchdog e retomada após lease expirada. Exige `MANUAL_SESSION_TEST_DATABASE=isolated` e banco vazio de laboratório.
- `apps/web/tests/browser/live-displays.html` + `live-displays.cjs`: hook React real em páginas separadas do Chromium. Oito cenários aprovados, com BroadcastChannel e com fallback de eventos storage: transferência confirmada, isolamento entre usuários, origem fechada e substituição de janela duplicada.
- `apps/web/tests/recover-legacy-layouts.test.mts`: validação do cache, permissões, limites e descarte de campos não confiáveis.
- `apps/web/tests/browser/live-soak.cjs`: coletor preparado para homologação prolongada da grade, com sessão de teste autorizada. Emite memória JS, nós, tempo de execução, quantidade de vídeos, frames descartados e erros agregados; não registra tokens nem URLs das câmeras.

## Limites que não devem ser confundidos com aprovação

- O ensaio de janelas valida coordenação real do navegador, não reprodução de streams reais.
- O ensaio PostgreSQL usa ações de gravação instrumentadas, não câmeras/FFmpeg reais.
- Lease com watchdog cobre o ciclo normal de reinício, concorrência e perda de renovação; não certifica alta disponibilidade do restante do gravador. Congelamento prolongado do sistema operacional/event loop e armazenamento compartilhado exigem fencing externo antes de escalar toda a API horizontalmente.
- Não há Safari/iPhone físico conectado. HLS nativo, áudio, fullscreen e retorno do segundo plano ainda precisam desse dispositivo.
- Ensaio prolongado com 36/64 streams reais continua sem execução: requer câmeras disponíveis, sessão autorizada de visualização e máquina cliente representativa. O coletor não substitui essa medição nem mede diretamente o decoder/GPU do sistema.

## Implantação

Código de aplicação promovido: `708126590a54fad5b538acaf91dab46ffba49436`, branch `migration/repository-5-0`.

| Instalação | Resultado |
|---|---|
| Demo (`demo-04.s2cam.com.br`) | API/Web reconstruídos e implantados; 65 migrações aplicadas; containers saudáveis; HTTPS 200; readiness completo. |
| IBTelecom (`ibtelecom.s2cam.com.br`) | API/Web reconstruídos e implantados; 65 migrações aplicadas; containers saudáveis; HTTPS 200; readiness completo. |
| Vibe (`vibe.s2cam.com.br`) | API/Web reconstruídos e implantados; 65 migrações aplicadas; containers saudáveis; HTTPS 200; readiness completo. |
| Management / Central (`central.s2cam.com.br`) | Repositório atualizado, imagem da Central reconstruída e implantada após backup PostgreSQL; `/api/ready` confirma `datastore: true`, sem mutações pendentes. |

Última reconferência pública das três instalações: 27/09/2026, 20:48 UTC, sem falhas em banco, schema, Redis, armazenamento, MediaMTX e serviço de IA. Isso é verificação de disponibilidade, não homologação visual de cada câmera.

- Backup de banco com API parada, ambiente e recuperação do Web preservados em `infra/backups/live-grid-7081265` em cada instalação. Imagens anteriores também foram preservadas quando disponíveis; na Demo o Web anterior foi copiado porque o Docker já não possuía todas as camadas da imagem antiga.
- Vibe: proxy do host atualizado para cookie HLS por câmera, com cópia anterior no backup; `nginx -t` aprovado e reload realizado. Os três domínios retornam `X-S2Cam-Hls-Session: camera` no caminho HLS.
- Gateway: configuração inspecionada; encaminha aos proxies das instalações, sem necessidade de alteração para esta entrega.
- Serviços de IA, MediaMTX e aplicativos já instalados nos celulares não foram reconstruídos nesta implantação de API/Web. Atualizar o repositório da Central não substitui APKs instalados.

Validação de código: 538 testes Web, 1.628 testes API, TypeScript de ambos, build Web, schema Prisma e ensaio isolado PostgreSQL aprovados. Oito cenários Chromium de múltiplas janelas aprovados.

Central: 501 testes aprovados, 13 ignorados pela própria suíte, nenhum erro, em container de laboratório com Bash e árvore de fontes completa. A primeira execução incompleta falhou por dependências/arquivos ausentes no laboratório; após corrigir o ambiente, a suíte passou antes da promoção. Backup em `/opt/ajustcam-management/backups/live-grid-7081265`; imagem anterior retida para recuperação. Artefatos e configurações locais não versionados foram preservados.
