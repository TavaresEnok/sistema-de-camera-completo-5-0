# Correções do aplicativo e endpoints — 28/09/2026

Base: auditoria `docs/auditoria-app-endpoints-2026-09-27.md`. Esta entrega altera código, não instala APK nem substitui automaticamente serviços em produção.

## Rastreabilidade

| Achado | Implementação / limite restante |
|---|---|
| APP-01 | Rotas canônicas de gravação; estado desconhecido desabilita a ação. |
| APP-02–04 | Invalidação por geração, abort das requisições, renovação por origem/credencial, persistência serializada; indisponibilidade não equivale a revogação. |
| APP-05 | Alarmes e ações protegidos por identidade e cancelamento. |
| APP-06 | Removida atribuição automática de clipes/grupos/favoritos legados. Originais preservados. Recuperação assistida com prova de propriedade ainda pendente. |
| APP-07 | Download não destrutivo e repetível, tamanho declarado e conferido no aparelho. Não há confirmação de recebimento com hash nem suporte Range nesta entrega; retenção controla a limpeza. |
| APP-08 | Catálogo atômico em `RECORDINGS_ROOT/.mobile-clips`, recuperação após restart e retenção de aproximadamente 24 horas após o limite de captura. App encerra retries em 403/404/410. Servidor ainda usa 404 para indisponível/expirado, sem tombstone 410. Clipes anteriores no diretório temporário não têm catálogo recuperável. |
| APP-09 | Foto não usa fallback local. `capture=1` exige imagem live gerada após o início do pedido; cache antigo no backend é recusado. Publicar API antes do novo APK. |
| APP-10 | Estado manual separado do automático, reconciliação periódica, limite de dez minutos, bloqueio de dupla ação, contínua protegida e controle restrito ao papel permitido. |
| APP-11–12 | URLs e downloads usam renovação coordenada; transferências canceláveis e verificação de tamanho. |
| APP-13 | Reserva de vaga antes dos awaits e liberação em erro. Cota adicional por usuário ainda não implementada; permanece limite global. |
| APP-14 | Download revalida liveView, ACL de câmera e plano. Política adotada: clipe remoto acompanha revogação; cópia já salva no aparelho não pode ser revogada. |
| APP-15–16 | Polling sequencial com backoff e abort; sem IA durante playback/background; gate liveView nas rotas de detecção e leases. |
| APP-17–19 | Índice de posters e reparo de clipes serializados; hidratação verifica geração da sessão; download de poster malsucedido limpa arquivo parcial. |
| APP-20 | Ack/resolve só muda estado após confirmação do servidor. |
| APP-21 | Filtro de eventos antes da paginação, total de abertos no servidor, paginação e indicação de quantidade carregada. Consulta com zero câmeras não se torna global. |
| APP-22 | Prévia identificada como não histórica; botão de ocorrência busca segmento que cobre o instante e informa ausência. Push leva à lista de eventos, sem abrir automaticamente outra cena ao vivo. |
| APP-23 | Abort e verificações de fechamento entre awaits; fechamento local imediato; deadlines de negociação e remoção WHEP. Requer ensaio no WebView real. |
| APP-24 | Sonda com deadline/cancelamento; 401/403/rede não disparam conversão. Retry manual reemite autorização. |
| APP-25 | Indisponibilidade de push no iPhone declarada na interface. APNs continua não implementado/homologado: exige credenciais e aparelho. |
| APP-26 | Recibo assinado permite remover apenas um cadastro push, sem preservar login após saída; fila em SecureStore, retry ao reconectar e validade de sete dias para cadastros inativos. Não é revogação instantânea sem rede. Recibo antigo não remove novo cadastro. |
| APP-27 | Confirmação explica que saída recebida pelo servidor é global e saída offline é local. Não foi alterada a política do endpoint. |
| APP-28–29 | Mute valida ACL e booleano; GPS auxiliar tem prazo de oito segundos e continua sem posição. |
| APP-30 | FlatList/SectionList nas câmeras, mosaico e eventos; projeção/paginação de câmeras no servidor com lotes limitados de ACL. App ainda reúne metadados da frota em memória para busca/grupos. Medição física 50/200/500 câmeras pendente. |
| APP-31 | Erros de rondas preservam estado e avisam; somente 404 vira ausência compatível. Relógio não avança fora do primeiro plano. |
| APP-32 | Downloads, consulta de ocorrência, listagem de câmeras e revogação push extraídos para serviços; gravação manual também disponível no redesign para operador autorizado. Decomposição completa de App.tsx ainda pendente. |
| APP-33 | Stop single-flight; remux em saída temporária, probe assíncrono com prazo, validação antes de promover; falha preserva TS. |

## Validação e publicação

- Typecheck da API e do aplicativo em containers isolados.
- Suíte mobile: **115 testes aprovados**, executados com mocks explícitos de armazenamento nativo; testes não equivalem a execução de APK.
- API: **34 testes direcionados aprovados**: isolamento de câmera, mute, captura atual, perda de remux, concorrência, recuperação de catálogo, ACL de push e recibos de revogação.
- Não houve teste de interrupção real de download em aparelho, falta de espaço real, carga de frota, geração de APK/IPA ou homologação Android/iOS.
- Implantação deve manter `RECORDINGS_ROOT` em volume persistente e gravável, publicar API antes do APK e gerar os aplicativos na Management. O catálogo de clipes pressupõe uma instância de API proprietária dos processos, não coordenação multi-réplica.
- Rollout de push: APK antigo não guarda recibos; registros sem revalidação deixam de receber após sete dias. Comunicar a necessidade de abrir/atualizar o app.

Não declarar todos os critérios de aceite encerrados: as pendências descritas na tabela são reais e não foram substituídas por testes estáticos.
