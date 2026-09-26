# Handoff: DRAC — Redesign do App Mobile (cliente final)

## Visão geral
Redesign completo do **app mobile do DRAC** (o app que o cliente final do provedor usa
para monitorar as câmeras contratadas). Cobre: Login, Início, Câmeras (lista + mural),
Câmera ao vivo (áudio, falar, captura, gravação local, PTZ, tela cheia), Gravações
(servidor + local, timeline 24h), Eventos e Ajustes — com tema claro/escuro.

Público: usuário residencial ou pequeno comércio (não é console de operador). Prioridade
para clareza, respiro e toque grande, mantendo densidade útil.

## Sobre os arquivos deste pacote
Os arquivos em `prototype/` são uma **referência de design feita em HTML** — um protótipo
interativo que mostra a aparência e o comportamento pretendidos, **não** código de produção
para copiar direto. A tarefa é **recriar este design no ambiente do app existente**
(React/React Native / Flutter / nativo — o que o projeto DRAC já usa no mobile), seguindo
os padrões, a navegação e as bibliotecas já estabelecidas no repositório.

O protótipo é um **Design Component** (`.dc.html`). Para abri-lo, sirva a pasta `prototype/`
por um servidor estático e abra `DRAC Mobile.dc.html` (ele carrega `support.js` e
`ios-frame.jsx` que estão na mesma pasta). O `ios-frame.jsx` é apenas a moldura de iPhone
para visualização — **não** faz parte do app; ignore-o na implementação.

## Fidelidade
**Alta fidelidade (hi-fi).** Cores, tipografia, espaçamento, raios, sombras e interações
são finais. Recriar pixel-perfect usando o design system/atoms do app; onde o app já tiver
um componente equivalente (botão, campo, sheet, switch), usar o existente com estes tokens.

## Mapa para o repositório (TavaresEnok/sistema-de-camera-completo-5-0)
O monorepo tem `apps/web` (console React+Vite+Tailwind). Este redesign é do **app mobile**.
Sugestão de correspondência de telas → rotas/screens do mobile:

| Tela do protótipo | Rota/Screen sugerida | Observação |
|---|---|---|
| Login | `/login` · `LoginScreen` | e-mail/senha + biometria + status do servidor |
| Início | `/` · `HomeScreen` | resumo, câmera em destaque, carrossel, atividade |
| Câmeras | `/cameras` · `CamerasScreen` | busca, filtro por grupo, Lista/Mural, favoritos |
| Câmera (detalhe) | `/cameras/:id` · `CameraScreen` | Ao vivo / Gravações, PTZ, tela cheia |
| Tela cheia | modal/rota imersiva | overlay sobre a câmera |
| Eventos | `/events` · `EventsScreen` | filtros, agrupado por dia; toca → abre gravação |
| Ajustes | `/settings` · `SettingsScreen` | perfil, plano, armazenamento, tema, notificações |

**Grupos = clientes:** cada cliente do provedor tem um grupo com suas câmeras. Os "filtros"
(Externa/Interna/Loja) representam áreas/grupos — na produção, vêm da API de grupos do cliente.

## Telas / Views

### Login
- Logo (quadrado 86px, gradiente azul, raio 26px, ícone de câmera), wordmark "DRAC" (Sora 34/800),
  subtítulo, chip do provedor.
- Campos e-mail e senha (superfície `--sf`, borda `--bd`, raio 16px, ícone à esquerda,
  olho na senha). Link "Esqueci minha senha".
- Botão primário "Entrar" (54px, gradiente `--ac→--ac2`, sombra azul). Botão secundário
  "Entrar com biometria". Rodapé com status "servidor conectado" (mono).
- Ação: qualquer botão → Início.

### Início
- Header: saudação (por hora do dia) + nome do cliente (Sora 26/800); à direita sino de
  eventos (badge) e avatar com iniciais (→ Ajustes).
- 3 pills de resumo: online / gravando (ponto pulsante) / offline.
- Card "câmera em destaque" (214px): imagem ao vivo, badge AO VIVO, relógio (mono), nome +
  área, botão expandir. Toque → detalhe.
- "Suas câmeras": carrossel horizontal de cards 150px (thumb 92px + nome/área, ponto de status).
- "Atividade recente": 3 linhas (thumb 52px + título + câmera·hora + chevron).

### Câmeras
- Header com título + contagem; toggle **Lista / Mural** (segmented, 2 ícones).
- Busca (campo com lupa + limpar).
- Chips de grupo com contagem (Todas/Externa/Interna/Loja).
- **Lista:** linhas (thumb 104×70, badge AO VIVO / ícone offline; nome com estrela se favorita;
  status + barras de sinal; botão estrela à direita). Favoritas sobem para o topo.
- **Mural:** grid 2 colunas, tiles 126px ao vivo (badge, estrela, nome/área em gradiente).
- Estado vazio "Nenhuma câmera encontrada".

### Câmera (detalhe)
- Header: voltar, nome (elipse) + "área · 1080p · 30 fps", badge AO VIVO ou data (em gravações).
- Player 16:10, raio 20px: imagem com filtro; transform `scale(zoom) translate(panX,panY)`
  para PTZ digital; overlays de relógio/REC/zoom; botão **tela cheia** (canto inf. direito);
  flash branco ao capturar.
- Segmented **Ao vivo / Gravações**.
- **Ao vivo** — barra rolável de ações (56px, raio 19px): Áudio, **Falar** (áudio bidirecional,
  anel pulsante ativo), Capturar, **Gravar** (grava *no aparelho* — local), PTZ, Qualidade
  (Auto/HD/SD). Painel **PTZ**: joystick circular (↑↓←→ + home), Zoom −/+ (1×–2.4×) e
  **predefinições** (Início/Portão/Rua) que aplicam zoom+pan.
- **Gravações** — segmented de **fonte**:
  - **Servidor** (nuvem): chips de data (7 dias), timeline 24h clicável (contínua azul +
    movimento âmbar) com cursor; transporte −15s / play / +15s / velocidade (1/2/4×);
    "Baixar este trecho".
  - **Neste aparelho** (local): aviso explicativo + lista de trechos gravados pelo app
    (thumb, duração, tamanho, data) com reproduzir e excluir; estado vazio.

### Tela cheia
- Overlay imersivo (z alto, fundo preto), imagem edge-to-edge com o mesmo transform de PTZ.
- Topo: badge AO VIVO + nome + relógio + fechar. Joystick PTZ à esquerda (quando ao vivo).
- Base: Áudio, Falar, Capturar, Gravar, PTZ (toggle do joystick).

### Eventos
- Título "Atividade"; chips Todos/Movimento/Sistema.
- Agrupado por "HOJE"/"ONTEM"; linhas (thumb 56px + ponto de tipo, título, câmera·hora, hora mono).
- Toque em evento de câmera online → abre a **gravação (servidor)** naquele instante.

### Ajustes
- Card de perfil (avatar iniciais, nome, e-mail, chevron).
- Card do provedor/plano com selo "Ativo".
- Preferências: **Tema escuro** (switch), **Notificações de movimento** (switch).
- Armazenamento na nuvem (barra de uso 34,2/50 GB, retenção 7 dias).
- Lista: Câmeras e grupos / Compartilhar acesso / Ajuda e suporte.
- Botão "Sair da conta" (→ Login). Versão do app.

## Interações & comportamento
- Navegação por tab bar flutuante (Início/Câmeras/Eventos/Ajustes) com blur; badge em Eventos.
- Transições de tela: fade+slide 12px (`scrIn`, .3s ease). Toque: `scale(.955)` (.12s).
- Pontos "ao vivo"/REC pulsam (`blk`, 1.4–1.6s). Toasts sobem do rodapé (.25s) e somem em ~1.9s.
- PTZ digital: zoom 1×→2.4×; pan limitado a `±(zoom-1)*22%`. Predefinições e "home" resetam/aplicam.
- Câmera offline: toque mostra toast "Esta câmera está offline" e não abre.
- Timeline: clique posiciona o cursor (proporcional à largura) e inicia o play; play avança
  o cursor conforme a velocidade.

## Estado (mínimo a reproduzir)
`theme` (dark/light) · `screen`/`tab` · `camId` · `mode` (live/rec) · `recSource` (server/local) ·
`camFilter` · `camQuery` · `camView` (list/mosaic) · `favs[]` · `evFilter` · `audioOn` · `talkOn` ·
`recOn` (gravação local) · `ptzOpen`/`fsPtz` · `zoom`/`panX`/`panY` · `ptzPreset` ·
`playing`/`phPct`/`speed`/`dateIdx` · `fsOpen` · `delClips[]` · `notif` · `toast`.

## Design tokens
Fontes: **Sora** (600/700/800 — títulos/números), **Instrument Sans** (400–700 — texto/UI),
**JetBrains Mono** (500/600 — horários, tamanhos, técnicos).

### Escuro (padrão)
- bg `#0A0D13` · superfície `--sf` `#12161F` · superfície2 `--sf2` `#1A2029`
- borda `rgba(255,255,255,.07)` · borda2 `rgba(255,255,255,.13)`
- texto `#F1F4F9` · secundário `#96A0B0` · terciário `#5C6779`
- acento `#3E8BFF` → `#2E5EEF` (gradiente) · acento-dim `rgba(62,139,255,.13)` · acento-borda `rgba(62,139,255,.35)`
- ok `#33C481` · perigo `#F05B52` · aviso `#F0A33C` (+ fundos a ~.13 alpha)

### Claro
- bg `#EFF2F7` · `--sf` `#FFFFFF` · `--sf2` `#E7EBF2`
- borda `rgba(16,24,40,.09)` · texto `#131A28` · secundário `#57657A` · terciário `#9AA6B7`
- acento `#1F6FEB` → `#1A53C7` · ok `#17945C` · perigo `#D9453E` · aviso `#B57414`

### Forma
- Raios: campos/cards 14–20px · botões-ícone 10–19px · pills 999px · player 20px · tab bar 23px.
- Sombras: elevação suave `0 16–24px 32–44px -12…-24px rgba(6,12,24,.18–.6)`; botão primário com sombra do acento.
- Alvos de toque ≥ 44px. Grid/flex com `gap` (sem margens soltas).

## Assets
- Sem assets proprietários. Ícones são **SVG inline** (stroke, 1.7–2.2px) — reimplementar
  com o icon set do app (Lucide/Feather equivalentes).
- Imagens das câmeras são **placeholders** do Unsplash (`images.unsplash.com`) apenas para
  demonstração; na produção usar os streams/snapshots reais. Substituir todas as URLs.

## Arquivos
- `tokens.css` — **variáveis CSS prontas** (cores escuro/claro, fontes, raios, sombras, keyframes) + `@import` das fontes. Ponto de partida do styling.
- `prototype/DRAC Mobile.dc.html` — protótipo (template + lógica de estado).
- `prototype/ios-frame.jsx` — moldura de iPhone (só visualização; ignorar na implementação).
- `prototype/support.js` — runtime do Design Component (necessário só para abrir o protótipo).
