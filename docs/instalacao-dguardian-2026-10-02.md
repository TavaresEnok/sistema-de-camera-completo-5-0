# Dguardian — instalação automática local, 02/10/2026

## Resultado e limite de conclusão

Instalada pela rota real de instalação remota da Central, não por substituição
manual do instalador. Servidor Ubuntu 24.04 x86-64, oito vCPUs Xeon E5-2680 v4,
16 GB RAM, 4 GB swap, volume raiz ~97 GB com ~77 GB livres após instalação.
Host local `192.168.100.166/24`, roteador `192.168.100.1`; acesso administrativo
autorizado `45.176.143.184:45222`, usuário `dguardian`, elevado com sudo.

**Ainda não liberado para uso externo pelo domínio.** Domínio confirmado pelo
usuário: `dguardian.s2cam.com.br` deve apontar a `45.176.143.184`. Os encaminhamentos
foram informados pelo usuário e testados nesta continuação. DNS público ainda
retorna `177.104.156.25`, não o servidor novo (Google, Cloudflare e VM, ~17:32 UTC).
HTTP instalado e alcançável pelo IP; página provisória 503 intencional até HTTPS.
Plano/limite e redes adicionais de câmeras ainda precisam de informação.
Nenhum DNS, NAT do roteador ou licença comercial foi inventado/alterado.
Não foram cadastradas câmeras fictícias como se fossem equipamentos do cliente.
Sem câmera e sem HTTPS público correto, transmissão/playback externo/app
**não foram aprovados**. TURN já configurado e preservado na reexecução, incluindo
UDP, TCP e TLS; isso não comprova a entrega de vídeo/relay para um cliente real.

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
| `1790962210656-dguardian` | `da267c32c315e5eb6bb3c9b63d8c3d0c137f7c69` | done, exitCode 0; TURN preservado e overlay aplicado, administrador mantido |

SHA-256 do instalador final:
`47a859ab1354292e0e44e42aa0ff38d8baaee231d696b85855afe762cf6bc7ff`.
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
| Reexecução local apagava HTTPS/TURN configurados depois | Preservar origem HTTPS e par TURN existente; aceitar origem HTTPS local sem confundir com Gateway; incluir overlay se TURN presente | Três testes novos aprovados; rejeitar configuração TURN parcial sem misturar chaves |

## Domínio, NAT e HTTPS — continuação às 17:26–17:35 UTC

Nginx/certbot instalados **somente na VM Dguardian**, sem reiniciar o servidor
nem modificar outros clientes ou o MikroTik. Nginx ativo/configuração válida;
certbot.timer ativo. Configuração HTTPS preparada (não carregada sem certificado):
`/etc/nginx/dguardian-https.prepared`. Renovações terão reload validado de Nginx.
Modelo completo validado com `nginx -t` em container isolado com certificado de
teste; esse certificado **não foi colocado em produção**.

| Teste externo desde Vibe | Evidência | Limite |
|---|---|---|
| 80/TCP | `--resolve ...:80:45.176.143.184`, `/api/health`: HTTP 200, service api; raiz responde mensagem Dguardian/503 | Confirma NAT e backend, não libera login HTTP |
| 443/TCP | Conexão aceita por listener diagnóstico temporário na VM; peer `192.168.100.1`; encerrado após uma conexão | Confirma encaminhamento TCP, **não** TLS; listener HTTPS ainda depende de certificado |
| 1935/TCP | Conexão TCP estabelecida ao IP público | Não comprova publicação RTMP/câmera autorizada |
| 45222/TCP | Conexão/SSH usados na instalação real | Administração confirmada |
| 8189/UDP | `tcpdump -nn -i ens18 -c 1`: `192.168.100.1.49667 > 192.168.100.166.8189: UDP, length 30` | Confirma chegada de um pacote externo; não confirma ICE/DTLS/vídeo nem sentido de volta |

**Observação de rede:** o tráfego de teste TCP/UDP chegou com endereço de origem
do roteador `192.168.100.1`, não da Vibe. A causa específica da tradução é
**hipótese** (regra de src-NAT/masquerade); não foi lida a configuração completa
do roteador. Se ocorrer com todo cliente, logs/limites por IP verão o mesmo
endereço. Não mudar NAT por suposição; revisar com o técnico futuramente.
8189/TCP adicional da imagem não foi usado como prova de WebRTC/UDP.

MediaMTX API real após a reexecução: três entradas `webrtcICEServers2` com
UDP 3478, TCP 3478 e TLS 5349, credenciais presentes (não exibidas),
`clientOnly=true`; `webrtcAdditionalHosts=[45.176.143.184]`.
Da VM, `openssl s_client` para `turn.s2cam.com.br:5349` validou TLS 1.3,
certificado e hostname (`Verification: OK`). Segredo transferido somente pelo
stdin SSH criptografado e salvo no `.env` 0600; backup protegido, nada em Git.
Alocação relay e vídeo externo permanecem não homologados.

Finalizador preparado em `/usr/local/sbin/dguardian-https-finalize`, fonte em
`infra/dguardian/finalize-https.sh`. Teste real com DNS atual encerrou antes de
qualquer mudança: `DNS ainda aponta para 177.104.156.25; esperado 45.176.143.184`.
**Não foi acionada emissão de certificado no IP antigo**, não houve certificado
autoassinado no painel nem desativação da validação TLS.

Depois da mudança pública do registro A, executar como root:

```bash
/usr/local/sbin/dguardian-https-finalize
```

O comando verifica o DNS, solicita certificado por HTTP-01/webroot, preserva
backup da configuração, valida/recarrega Nginx, ajusta somente URLs públicas no
`.env`, recria API/MediaMTX (não banco/IA/web), instala hook de renovação e testa
readiness HTTPS local com validação de certificado. Depois ainda verificar pelo
domínio desde a internet, renovação em staging e sessão de vídeo autorizada.
Não agendado para executar sozinho antes da confirmação da troca de DNS.

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

1. Alterar o registro A confirmado `dguardian.s2cam.com.br` de `177.104.156.25`
   para `45.176.143.184`; não há credenciais de administração DNS nesta sessão.
2. Após DNS: concluir certificado/HTTPS e homologar mídia bidirecional e TURN.
   Os encaminhamentos de entrada testados funcionam; não confundir isso com vídeo.
3. Plano/limite comercial e credenciais de câmera de homologação. Sem isso não
   declarar teste real de vídeo, gravação, reprodução, IA ou app como aprovado.

Não é uma instalação externa completamente entregue: backend instalado e fluxo
automático/reexecução validados; acesso público e teste de câmera dependem dos
itens acima. Senha SSH não foi persistida; acesso inicial do painel permanece
somente em memória no atendimento, sem ser reproduzido neste relatório.
