# Correções da revisão Ao vivo / câmera individual / grade

Data: 27/09/2026. Complementa e revisa a entrega parcial `618602a`.

## Cobertura dos achados retomados

| Achado | Correção entregue |
|---|---|
| REC manual altera/paralisa gravação contínua | API preserva a política contínua sem iniciar, parar ou instalar timer manual; botão indisponível nesse modo. |
| Cliques simultâneos e comandos concorrentes | Bloqueio na interface e fila por câmera na API; timer anterior não encerra uma solicitação nova. |
| REC vermelho divergente da gravação automática | API informa `manualRecordingActive`; interface reconcilia com esse campo. Estado provisório tem prazo e timers são limpos na desmontagem. |
| Movimento encerra sessão manual | Post-roll respeita sessão/comando manual; stop manual sem sessão vigente não para uma política automática. Falha na parada temporizada agenda nova tentativa. |
| Tentativa antiga limpa player novo | Guardas de cancelamento após limpezas assíncronas, descoberta ICE e importação HLS; callbacks saudáveis ignoram geração encerrada. |
| OPTIONS WHEP e renovação de token sem prazo | Prazos próprios, abort e limpeza; OPTIONS travado permite seguir a recuperação. |
| Cache recebe resposta antiga após invalidação | Publicação e remoção de requisição em voo exigem identidade da promessa; cache limpo na troca de usuário. |
| Autenticação da aplicação confundida com senha da câmera | 401 solicita revalidação; 403 informa permissão e tenta novamente quando o token muda; falha de autorização de mídia invalida cache e reconecta. |
| Mural omite indisponibilidade/reconexão | Status essencial independe da exibição de caixas de IA; reconexão informa que o quadro pode estar desatualizado. |
| Câmera focada removida / prontidão de outra câmera | Saída do foco quando câmera deixa a grade; callbacks conferem a câmera focada; todos os caminhos de ampliação preparam a imagem. |
| Seleção abre stream original desnecessariamente | Preparação do original ocorre ao ampliar, não em cada seleção simples. |
| Caixas de IA não acompanham zoom | Vídeo e caixas compartilham a transformação. |
| Vídeos ocultos consomem recursos | Suspensão após 10 segundos de rota/quadro inativo; retomada limpa do transporte. Aba oculta mantém seu mecanismo de suspensão. |
| IA continua consultando câmeras não visíveis | Polling e leases condicionados à rota, quadro e documento visíveis; sessão de lease única por ciclo. |
| Polling IA travado / resposta de sessão antiga | Timeout, abort, geração de requisição, verificação de usuário e descarte de cache sem assinantes. |
| Preferências duplicadas ou presas após falha | Requisição compartilhada, nova tentativa com intervalo e reset por usuário. |
| Mais de 200 miniaturas / rajadas de requisições | Emissão em lotes de até 200, requisição única em voo, timeout e cancelamento; lista progressiva em grupos de 100 e tokens apenas da parte exibida. |
| Layout offline desaparece quando servidor já tem layouts | Combinação de remotos e rascunhos, sincronização individual, retomada online e botão Sincronizar. Falha mantém o rascunho. |
| Migração duplicada em abas / resposta perdida de POST | `clientRequestId` produz ID determinístico por usuário no servidor; unicidade do banco impede duplicação. Removida falsa trava via sessionStorage. |
| Cache local entre usuários | Grade, retorno de foco, layouts e comunicação entre telas separados por usuário; respostas assíncronas de edição conferem sessão. |
| Layout recebido oferece edição proibida | `origem` e `podeEditar` preservados; renomear/apagar respeitam a autorização devolvida pela API. |
| Armazenamento do navegador indisponível | Grade permanece operável em memória; layouts distinguem salvamento remoto, local e somente na aba. |
| Transferência entre telas depende de 150 ms | Destino aguarda confirmação após remoção React na instância de origem; timeout visível. Comando identifica instância e nonce. |
| Restauração/adição concorrente duplica câmera em telas | Presenças resolvem disputa de forma determinística; layout informa conflitos e preserva os respectivos quadros vazios. |
| Grade estoura altura em telas pequenas | Removidas alturas mínimas dos tiles; largura calculada pela altura/largura disponível, preservando proporção 16:9. |
| Teclado, toque, rótulos e contraste | Ações disponíveis por seleção/foco; controles com nomes; alça do painel operável pelo teclado; presets numerados; status lateral sem truncamento obrigatório e sem opacidade reduzida. |
| Estados vazios e terminologia | Mensagem quando filtro não encontra câmeras; “quadro” uniforme; alerta de grade grande visível em telas pequenas; contagem diz “disponíveis”, sem afirmar reprodução comprovada. |
| Safari sem HLS nativo seguro | Bootstrap HTTPS de mesma origem com cookie HttpOnly por caminho de câmera, confirmação da versão do proxy e renovação; URL do vídeo não carrega token. |
| Áudio bloqueado silenciosamente | Falha de autoplay por política retoma vídeo mudo e orienta novo toque; botão de áudio informa estado acessível. |
| Informação técnica na interface de cliente | Removido detalhe técnico bruto do erro e endereço IP da linha secundária da câmera. |

## Verificações realizadas

- Web: 535 testes aprovados, incluindo cache concorrente, prazo de OPTIONS e bootstrap HLS nativo.
- API: 1.628 testes aprovados, incluindo gravação simultânea, proteção de contínua/post-roll e idempotência de layouts por usuário.
- TypeScript: checagem Web e API aprovada.
- Compilação Web de produção aprovada. Permanece o aviso de tamanho do pacote compartilhado de mapas, fora do carregamento específico desta página.
- Nginx Web: `nginx -t` aprovado em container isolado.
- `git diff --check` aprovado.

## Limites e implantação

Os testes foram executados em containers isolados, sem trocar os serviços em produção. Não foi executada homologação visual com câmeras reais, sessão longa de 36/64 streams ou dispositivo Safari físico; não há medição comparativa de CPU/FPS que permita prometer percentuais de ganho.

O HLS nativo exige atualização conjunta do Web e dos proxies fornecidos no repositório, com HTTPS. A verificação `X-S2Cam-Hls-Session: camera` evita usar cookies globais de uma instalação com proxy antigo.

Caches antigos sem identificação do proprietário não são atribuídos automaticamente ao usuário atual. Os dados antigos permanecem no navegador, e layouts já sincronizados são recuperados pela API. Essa escolha evita expor configurações de outro usuário em terminais compartilhados.

A serialização de gravação e seus timers pertencem ao processo da API, como no mecanismo existente; não representa coordenação distribuída entre múltiplas réplicas nem persistência do prazo através de reinício da API. Escalar a API horizontalmente requer uma sessão manual persistida e coordenação entre réplicas.
