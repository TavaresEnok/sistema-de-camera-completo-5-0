# Dguardian — instalação automática local, 02/10/2026

## Resultado e limite de conclusão

Instalada pela rota real de instalação remota da Central, não por substituição
manual do instalador. Servidor Ubuntu 24.04 x86-64, oito vCPUs Xeon E5-2680 v4,
16 GB RAM, 4 GB swap, volume raiz ~97 GB com ~77 GB livres após instalação.
Host local `192.168.100.166/24`, roteador `192.168.100.1`; acesso administrativo
autorizado `45.176.143.184:45222`, usuário `dguardian`, elevado com sudo.

**Ainda não liberado para uso externo.** IP público portas 80/443: conexão
recusada nas verificações; DNS `dguardian.s2cam.com.br` retorna `177.104.156.25`,
não o servidor novo. Usuário foi consultado sobre domínio, encaminhamento de
portas, plano/limite e redes adicionais de câmeras; ainda sem resposta.
Nenhum DNS, NAT do roteador ou licença comercial foi inventado/alterado.
Não foram cadastradas câmeras fictícias como se fossem equipamentos do cliente.
Sem câmera e sem rota pública confirmada, transmissão/playback externo/app
e TURN da nova instalação **não foram aprovados**. A mídia UDP disponível no
host não comprova que o roteador a encaminha.

## Fluxo e revisões

Central com imagem `ajustcam-central:remote-install-20261002`, patch sobre
imagem implantada `ajustcam-central:cc32efa`, sem troca de dependências.
Overlay persistente management:
`/opt/ajustcam-management/repo/infra/management/docker-compose.installation-fixes.yml`.
Backup prévio da Central:
`/opt/ajustcam-management/backups/central-before-dguardian-20261002.dump`,
657.773 bytes, modo 0600; sem migrações do banco central.

Cadastro `dguardian`, cliente Dguardian, servidor informado `45.176.143.184`,
rede inicial permitida `192.168.100.0/24` descoberta no host. Isso não declara
que todas as câmeras pertençam a essa rede; redes adicionais precisam ser informadas.
Marca oficial do URL fornecido pelo usuário, WebP 523×416/41.480 bytes;
`facilityName=Dguardian`, cor principal `#ffb600`, fundo `#101010`.
Entrega por PATCH `/api/admin/installations/dguardian/app` e heartbeat real:
revisão 1, logo presente com 55.331 caracteres no banco da instalação.

| Tentativa pela Central | Commit | Resultado |
|---|---|---|
| `1790956853243-dguardian` | `eb61ad6021fbd876bb37cdddca19d1698f3f9a88` | done, exitCode 0; instalação limpa |
| `1790959765219-dguardian` | `0c32e33e49cba6c4953946b2354a430d290ec45d` | failed, exitCode 1 antes de trocar código; achou mudança somente de permissão criada pelo instalador |
| `1790959896064-dguardian` | `2ab1988073b201aafe94c3dda7b47cac2d962f70` | done, exitCode 0; reexecução, correções e administrador preservado |

SHA-256 do instalador final:
`9ce843825822a4f39d296eb183a36158fcb6ddd22c7f2bdb420767d16d307413`.
Piloto usa commit/hash imutáveis explícitos e auditoria; **não promove** uma
versão ainda sob validação para toda a frota. Release global anterior mantida.

## Defeitos corrigidos para novas instalações

| Defeito | Correção/evidência | Limite/risco |
|---|---|---|
| SSH remoto não elevava usuário sudo | Bootstrap estático `sudo -S`, sem PTY; senha só no canal SSH; teste real retornou ROOT_UID=0 | Mesmo password deve ser válido para sudo, conforme acesso fornecido |
| Credenciais no comando remoto/seed | Instalador e variáveis enviados pelo canal depois da elevação; seed recebe JSON por stdin | Segredos operacionais necessários continuam em configuração protegida, não Git/log |
| Senha inicial em arquivo/log | Instalação remota usa `DRAC_PERSIST_INITIAL_CREDENTIALS=false`; entrega única autenticada na resposta da Central; `.credenciais-iniciais` ausente | Ao recarregar a página, a resposta não é recuperável; usuário deve guardar/trocar senha |
| Redação incompleta entre chunks | Buffer/redação de segredos antes de log; teste de todas as divisões do segredo | Credenciais SSH/admin/licença mascaradas; não imprimir resposta completa da instalação |
| Ownership recursivo de /opt | Criar somente diretório dedicado; /opt permanece root:root 0755 | Não modificar ownership de outras instalações |
| Rede de câmera ausente travava em pergunta | Campo de redes na UI; rejeição prévia na API remota | Rede deve ser informada corretamente; não abrir CIDR universal |
| Reexecução recusava alteração criada pelo instalador | `drac-ops-agent.sh` agora versionado como executável | No host novo foi restaurado apenas o modo 0644 original antes de reaplicar; nenhum conteúdo descartado |
| WebRTC local restrito a loopback | UDP bind 0.0.0.0 e host anunciado do servidor; Gateway mantém IP privado | Não dispensa NAT/TURN ou certificação do domínio |
| Falso aviso de build-agent local | Readiness respeita `DRAC_BUILD_AGENT_EXPECTED`, padrão false | Build continua na Central |
| Instalador tolerava falha de HTTP/readiness | Falha de API `/health/ready` ou painel aborta conclusão | Readiness geral pode manter avisos honestos sobre ausência de câmera |
| Primeiro backup antes das migrations era aceito vazio | Gerar nova cópia depois de migrations/seed; restore exige migrations >0 e quatro tabelas críticas, retry 60 s e healthcheck | Proteção contra dump vazio; não garante restauração de mídia que ainda não existe |

## Validações executadas

- Central: 524 casos totais; primeira rodada 511 aprovados/13 pulados por ausência
  de Postgres de teste. Repetida com Postgres efêmero: código 0, todos os casos
  aprovados, sem marca de falha no reporter dot. Banco e rede de laboratório
  identificados com label `org.ajustcam.validation=dguardian-20261002`; removidos
  ao terminar, sem tocar produção.
- Testes shell do instalador aprovados, incluindo regras novas de mídia local,
  prontidão obrigatória, build opcional e ownership isolado. Bash/sh syntax e
  `git diff --check` aprovados. TypeScript API aprovou a alteração do seed.
- Login real do administrador: HTTP 201, token presente (não exibido);
  `/cameras`, `/role-permissions`, `/settings`: HTTP 200.
- `verificar-instalacao.sh` real: todos os checks passaram; 32 tabelas presentes,
  login, users/settings/audit-logs/cameras/role-permissions HTTP 200, watchdog
  issues vazio e revisão reportada corresponde ao checkout.
- Uma conta de administrador, zero câmeras; reexecução registrou
  `Banco ja tem 1 usuario(s); ... senha preservada`. Não habilitar exemplos.
- `drac-watchdog.timer` e `drac-ops-agent.timer` ativos; serviços Result success,
  ExecMainStatus 0; licença ACTIVE/heartbeat recebido pela Central.
- API, web, IA, MediaMTX, Postgres, Redis, RTMP/callback saudáveis; após patch,
  verificador de backup healthy. Nenhuma mudança aplicada à Vibe/IB nesta rodada.
- Primeira cópia foi restaurada pelo verificador antigo com `migrations=0` e
  não foi considerada validação correta. Nova cópia, após reexecução:

```text
2026-10-02T16:52:32Z backup_restore_verify=ok
file=drac-postgres-20261002T165216Z.dump migrations=65
```

Restore de verificação usou somente DB temporário `dg_install_check_20261002`.
O timeout de 20 s enviou término ao shell, mas o sleep filho atrasou seu trap;
foi encerrado somente esse sleep de diagnóstico (PID 67, PPID 44, identidade
conferida), liberando cleanup. Daemon de produção PID 1/sleep 900 preservados.
Não apresentar timeout de shell como garantia de encerramento de seus filhos.
Backup antigo
não foi apagado. Root ~17% usado; há espaço não alocado no volume físico/LVM,
mas não foi redimensionado sem dimensionamento de gravações.

## Pendências que exigem informação externa

1. Domínio definitivo e DNS apontando ao servidor local, ou outra estratégia
   explicitamente escolhida; não enviar tráfego para o gateway antigo por suposição.
2. Encaminhamento do acesso HTTPS do roteador ao host, mais estratégia de mídia
   WebRTC/TURN e eventual RTMP; não abrir API/banco/mídia de controle diretamente.
3. Plano/limite comercial e credenciais de câmera de homologação. Sem isso não
   declarar teste real de vídeo, gravação, reprodução, IA ou app como aprovado.

Não é uma instalação externa completamente entregue: backend instalado e fluxo
automático/reexecução validados; acesso público e teste de câmera dependem dos
itens acima. Senha SSH não foi persistida; acesso inicial do painel permanece
somente em memória no atendimento, sem ser reproduzido neste relatório.
