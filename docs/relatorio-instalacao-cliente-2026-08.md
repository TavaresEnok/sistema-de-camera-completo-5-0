# Relatório: o que quebrou na primeira instalação de cliente

**Instalação:** D-GUARDIAN Segurança Eletrônica, VM 168.194.13.20, 07/08/2026.
**Resultado:** sistema no ar, ONLINE na Central, HTTPS válido — mas ao custo de
**12 defeitos corrigidos durante a instalação** e 4 lacunas ainda abertas.

---

## 1. O achado central

Os 12 defeitos não são 12 problemas independentes. **Todos têm a mesma causa
raiz: o instalador nunca tinha sido executado numa máquina limpa.**

Ele foi escrito e validado na máquina de desenvolvimento, onde:

- `/home/flashnet/Drac` existe e o usuário `flashnet` existe;
- a Central já roda, então um `depends_on` para ela sempre resolve;
- o banco já tem todas as tabelas — inclusive as que chegaram por `db push` e
  não têm migração;
- as portas já estão ligadas de um jeito só, porque nunca se sobem os dois
  arquivos de Compose juntos;
- `brandUseDefaultColors` está ligado, então a paleta do cliente nunca é exercida.

**Nenhum dos 12 defeitos aparece nesse ambiente. Todos aparecem numa máquina
limpa.** É por isso que a instalação virou uma sequência de consertos: não houve
descuido pontual, houve ausência de um teste que exercitasse o caminho real.

O número de defeitos, portanto, não é a informação mais importante. A informação
importante é que **não existia nada capaz de encontrar nenhum deles** antes do
cliente.

---

## 2. Inventário do que foi encontrado

Gravidade: 🔴 impede a venda / expõe o cliente · 🟠 quebra função · 🟡 ruído.

### 🔴 1. A API inteira ficou exposta na internet, sem HTTPS

O instalador gerava `.env` com `0.0.0.0` para API, web, HLS, sinalização WebRTC
e RTSP. O Docker escreve regras de DNAT que são avaliadas **antes** do ufw — ou
seja, o firewall estava configurado e mesmo assim não valia.

Varredura feita **de fora** mostrou abertas as portas **3000 (API inteira,
contornando o nginx e o HTTPS), 8888 e 8889**, embora o ufw só liberasse
2211/80/443/1935/8189.

*Por que não apareceu antes:* na máquina de desenvolvimento não há ufw nem
varredura externa; tudo "funciona".

**Regra adotada:** só é publicado o que **não** passa pelo nginx (8189/udp e
1935). Todo o resto liga em `127.0.0.1`. — commit `e6ac372`

### 🔴 2. Porta duplicada: uma classe de defeito, três ocorrências

O `docker-compose.yml` base fixava `127.0.0.1:PORTA` e o overlay de produção
publicava `${DRAC_*_BIND}:PORTA`. **O Compose SOMA as listas de portas em vez de
substituir** — com o `.env` do instalador usando `0.0.0.0`, a mesma porta era
ligada duas vezes.

O sintoma engana: `address already in use` **com a porta livre no host**. `ss`
vazio, bind manual funciona. Só `docker inspect` revela as duas ligações. Perdi
tempo real perseguindo containers velhos e `userland-proxy` antes de achar.

Atingiu MediaMTX 8888 (`43aa314`), depois API 3000 e web 5173 (`265b397`).

**Regra adotada:** base e overlay usam **as mesmas variáveis**, nunca porta crua.

### 🔴 3. Tabela no schema sem migração que a criasse

`model RolePermission` existia no `schema.prisma` e a tabela existia no
desenvolvimento — mas **nenhuma migração a criava**. Ela tinha chegado lá por
`prisma db push`.

Numa base nova, `prisma migrate deploy` aplica as 48 migrações, imprime
*"Database schema is up to date!"* e a tabela continua ausente. `/role-permissions`
respondia 500 e a tela de Funções e Permissões estava quebrada — **em toda
instalação de cliente**, enquanto funcionava perfeitamente para quem desenvolve.

Comparação tabela a tabela entre as duas bases: era a única das 27 ausente.

**Corrigido** com a migração `20260807220000` **e um teste que compara
`model` × `CREATE TABLE`** em todas as migrações — este defeito não volta em
silêncio. — commit `e7bd56f`

### 🟠 4. O instalador apontava para o repositório errado

Na instalação original, `DRAC_REPO_URL` apontava para um repositório histórico
sem os commits aprovados, causando `upload-pack: not our ref`. O destino atual
de instalação e atualização é `TavaresEnok/sistema-de-camera-completo-5-0`.

### 🟠 5. Os padrões eram os da máquina de desenvolvimento

`DRAC_INSTALL_DIR=/home/flashnet/Drac` e `DRAC_OPERATING_USER=flashnet` — um
caminho e um usuário que não existem em nenhum servidor de cliente. Passaram a
`/opt/drac` e `${SUDO_USER:-drac}`. — commit `cffb2fe`

### 🟠 6. A Central subia no servidor do cliente

Sem `profiles`, o `drac-central` era iniciado em toda instalação e entrava em
loop de crash. A Central é o painel mestre; **não pode existir na máquina do
cliente**. Agora está sob `profiles: ["central"]`.

Efeito colateral que isso revelou: o `web` não pode ter `depends_on:
drac-central`, senão o Compose fica inválido sem o perfil. — commit `0be772b`

### 🟠 7. O web nem subia sem a Central

O nginx do container usava `proxy_pass http://drac-central:9765` **literal**. O
nginx resolve nome literal na inicialização — sem a Central no ar, ele se recusa
a subir. Corrigido com `resolver 127.0.0.11` + variável, que adia a resolução
para o momento da requisição. — mesmo commit

### 🟠 8. O nginx do container estava atrás do nginx do host

Faltavam os `proxy_redirect` do MediaMTX (verificação de cookie no `/hls/` e
encerramento de sessão WHEP) e o `access_log off` no HLS. O cliente herdaria
sessões WebRTC órfãs — medi **128 por dia** no mestre antes da correção — e o
log encheria o disco com uma linha por segmento de vídeo. — commit `66fa7d0`

### 🟠 9. Tema escuro com caixas brancas sob a marca do cliente

Só aparece em instalação com marca própria. A classe `dark` fica no `<html>`, o
mesmo elemento que `:root` casa, e ambos pesam igual na cascata; como o `<style>`
da marca é injetado depois da folha do app, o bloco do tema **claro** vencia o
`.dark` base em toda variável que o bloco escuro não redeclarasse.

O gatilho é o próprio formulário de Aparência: ele entrega o tema claro inteiro
preenchido, então quem escolhe só "minha cor" e "meu fundo" salva exatamente o
caso ruim. Medido no cliente: `--card`, `--popover`, `--secondary`, `--muted` e
`--accent` chegavam como `#FFFFFF` no tema escuro.

*Registro honesto:* fui eu quem aplicou a paleta parcial ao configurar a marca —
mas o produto não podia transformar isso numa tela quebrada. — commit `7f46376`

### 🟠 10. Duas marcas na mesma tela

"AjustCam" aparecia sob "D-GUARDIAN" na barra lateral, e também no rodapé, no
login, na paleta de comandos, no 404 e no título da aba: a nossa marca dentro do
produto que o cliente comprou. — mesmo commit

### 🟡 11. O watchdog morria no primeiro disparo

`storage` pertence ao root (quem cria são os containers) e o watchdog roda como
usuário operador — o `mkdir -p` falhava **em silêncio**. Agora tenta `sudo -n` e
aborta com mensagem clara.

### 🟡 12. Dois alertas falsos perpétuos

O watchdog acusava `build-agent:unreachable` (o agente só existe no mestre — virou
opt-in por `DRAC_BUILD_AGENT_EXPECTED`) e o backup registrava `FALHOU
db=drac_central` a cada ciclo (`POSTGRES_EXTRA_DATABASES` passou a ter padrão
vazio).

Alerta que nunca apaga é pior que alerta nenhum: ensina o operador a ignorar o
painel. — commit `23a9e35`

---

## 3. Lacunas ainda abertas

Estas **não** foram corrigidas. São o que ainda torna a instalação difícil.

| # | Lacuna | Consequência hoje |
|---|--------|-------------------|
| A | **O instalador não semeia o banco** | A instalação termina **sem nenhum usuário**. Ninguém consegue entrar. Precisei rodar `npx tsx prisma/seed.ts` à mão. O `docs/clean-install.md` documenta isso como passo manual 5 — ou seja, é conhecido e aceito. |
| B | **O watchdog não chegou a ser provisionado** | A instalação interativa terminou antes desse passo; provisionei o systemd timer à mão. Uma instalação "bem-sucedida" pode ficar sem monitoramento e ninguém percebe. |
| C | **Modo não-interativo não documentado** | São 9 prompts. Para rodar sem intervenção é preciso `DRAC_AUTO_YES=true` mais 6 variáveis (`DRAC_CUSTOMER_NAME`, `INSTALLATION_ID`, `LICENSE_KEY`, `SERVER_IP`, `CENTRAL_URL`, `CAMERA_ALLOWED_CIDRS`) que não estão escritas em lugar nenhum. |
| D | **O comando de uma linha exige token no stdin com `\n` final** | Sem o `\n` o instalador **sai em silêncio**, sem erro. Foi o primeiro sintoma que enfrentei e não havia como diagnosticar sem ler o código. |

---

## 4. Por que a instalação não é "um comando" hoje

O `docs/clean-install.md` descreve **nove passos manuais**, incluindo "crie o
primeiro administrador", "cadastre uma câmera de homologação e valide live,
poster, gravação, thumbnail e playback" e três *gates* separados.

Isso não é um instalador — é um roteiro para quem já conhece o sistema. Um
roteiro depende de quem executa lembrar de tudo, e não tem como falhar de forma
visível quando um passo é pulado (foi o que aconteceu com o watchdog).

---

## 5. O que fazer para não repetir

Em ordem de impacto. **O item 1 é o único que realmente impede recorrência** — os
demais são consequências dele.

### 1. Teste de instalação limpa, automatizado

Um job que, a cada release, sobe uma VM ou container limpo e roda o instalador
do zero, sem intervenção, e ao final verifica:

- todos os containers `healthy`;
- login funciona com o admin semeado;
- **varredura de portas de fora** — só 80/443/1935/8189 respondem;
- `migrate deploy` numa base vazia produz **todas** as tabelas do schema;
- o watchdog está ativo e com `issues: []`;
- as telas principais respondem 200, incluindo Funções e Permissões.

**Os 12 defeitos deste relatório seriam pegos por esse job.** Todos. É o único
investimento que muda a categoria do problema em vez de tapar mais um buraco.

### 2. O instalador termina com um sistema utilizável

Semear o banco e criar o primeiro administrador deixam de ser passo manual e
passam a ser parte do instalador, que ao final imprime a URL, o usuário e a
senha inicial. Se ele terminou sem erro, dá para entrar. (Lacuna A.)

### 3. Um arquivo de respostas em vez de nove perguntas

`install-drac.sh --config cliente.env`, com um exemplo versionado e comentado no
repositório. O modo interativo continua existindo para quem quiser, mas deixa de
ser o caminho padrão. (Lacunas C e D.)

### 4. Falhar alto, nunca em silêncio

Os dois piores momentos da instalação foram falhas silenciosas: o instalador
saindo sem mensagem por falta de `\n` no token, e o `mkdir` do watchdog falhando
sem avisar. Toda saída não-zero precisa dizer o que faltou.

### 5. Provisionar o watchdog antes de declarar sucesso

E verificar que ele respondeu uma vez. Instalação sem monitoramento não deveria
poder ser reportada como concluída. (Lacuna B.)

---

## 5-bis. Situação: os cinco itens foram implementados (10/08/2026)

A instalação passou a ser **dois comandos** (`docs/clean-install.md`), e o gate
do item 1 existe: `scripts/teste-instalacao-limpa.sh` sobe uma máquina virgem
(Ubuntu com systemd em PID 1), roda o instalador **com stdin fechado** — o que
prova que nada depende de alguém respondendo — e passa a bateria de verificação.

**Na primeira vez que rodou de verdade, encontrou cinco defeitos.** Todos da
mesma família dos doze originais: invisíveis onde se desenvolve, fatais numa
máquina nova.

| # | O que o gate achou | Por que era invisível |
|---|--------------------|------------------------|
| 13 | **Docker instalado ≠ Docker rodando.** A única checagem era `docker compose version`, que lê o binário e passa com o daemon parado. A instalação seguia e morria minutos depois em "failed to connect to the docker API". | Na máquina de quem desenvolve o daemon está sempre de pé. |
| 14 | **O watchdog não conseguia escrever seu diretório de estado.** A correção nº 9 (fallback `sudo -n`) era **incompleta**: o operador não tem sudo sem senha. No cliente contornei à mão, então o defeito seguiu vivo no produto. Agora quem cria e dá o dono é o instalador, que tem privilégio para isso. | Só aparece com usuário operador sem sudo livre e `storage` recém-criado pelo root. |
| 15 | **O watchdog exigia `node` no host.** Usava node só para montar um JSON. Não existe node no host de um servidor — o Node mora nos containers, é essa a arquitetura. Reescrito em shell puro. | Quem desenvolve tem node instalado. |
| 16 | **`verify_watchdog` reprovava instalação saudável.** O watchdog termina em `[ ${#issues[@]} -eq 0 ]`: sai não-zero quando o *sistema* está degradado (disco cheio, câmera fora). Isso é diagnóstico, não defeito dele — a verificação abortaria a instalação por disco em 86%. Agora compara o mtime do arquivo de estado; problema vira aviso. | Defeito meu, do dia anterior. Nunca teria aparecido sem uma execução real. |
| 17 | **O check de porta duplicada estava cego.** Achado pelo `test-checks-pegam-defeito.sh`, que injeta cada defeito de volta e exige reprovação. | Check verde que não enxerga nada parece um check bom. |

Dois desses (14 e 16) eram **correções minhas já dadas como concluídas**. Sem uma
máquina virgem, "corrigido" era só uma afirmação.

Resultado final do gate: instalação limpa **passa**, 6/6 na bateria — containers,
exposição de portas, 27 tabelas, login do administrador criado pelo instalador,
todas as rotas em 200 (inclusive `/role-permissions`) e watchdog gravando.

## 6. O que já ficou protegido por teste

Nem tudo depende do item 1. Estes já não voltam em silêncio:

- **tabela sem migração** — teste compara `model` × `CREATE TABLE` em todas as migrações;
- **paleta parcial embranquecendo o tema escuro** — teste com a paleta exata do cliente;
- **marca do fornecedor na tela do cliente** — teste varre o fonte e proíbe `{PRODUCT_NAME}` no JSX.

---

## 7. Fora do nosso alcance

Registrado para não ser confundido com defeito do produto: a VPN L2TP/IPsec até a
LAN das câmeras do cliente está **instalada e funcionando do nosso lado** — o
IPsec fecha com a chave fornecida e o túnel L2TP sobe. O MikroTik do cliente
recusa o PPP com `E=691 — bad username or password`. Usuário e senha conferidos
byte a byte. Depende de correção no roteador deles.
