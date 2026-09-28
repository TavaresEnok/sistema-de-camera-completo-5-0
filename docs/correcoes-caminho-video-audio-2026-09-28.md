# Correções do caminho de vídeo/áudio — 28/09/2026

Referência: `auditoria-caminho-video-audio-2026-09-28.md`.

## Implementado no código (não implantado)

- Áudio preserva vídeo H.264 da fonte selecionada, inclusive RTMP 1080p. HEVC continua convertido na grade de compatibilidade; original com áudio preserva HEVC. Isso pode consumir mais banda que a antiga redução a 360p, mas não mais que o mesmo H.264 repassado sem áudio, exceto pela trilha de som.
- Grade e variante com áudio seguem a mesma política de fonte e de proporção da imagem.
- Web e app mantêm a variante preparada ao mutar/desmutar. Primeira ativação pode negociar nova sessão. A sessão é liberada pelo ciclo normal ao fechar/sair da câmera.
- Contagem reconhece publicadores RTSP dos caminhos de entrega; caminho apenas cadastrado não recebe isenção do limite.
- Limite real adicional por locks do kernel no início de cada FFmpeg. Partidas concorrentes disputam slots; término/crash libera o lock. Exige `flock`, disponível na imagem MediaMTX examinada; falha fechada se ausente. Caminhos antigos só recebem esse controle quando reconciliados.
- Ajustes de política no mesmo publicador aguardam ausência de leitores; consultas de runtime inconclusivas preservam sessão. Mudança explícita da origem não é mascarada. O bitrate instantâneo da cena não recalcula o comando.
- FPS usa delta de quadros apresentados, reinicia janela por câmera/modalidade e deixa de mostrar número antigo quando não recebe frames.
- Diagnóstico da API separa encode de áudio e vídeo; não anuncia limite de resolução quando faz cópia; remove multiplicador fixo de CPU apresentado como custo.
- RTMP identifica ausência de áudio e Opus pelas trilhas reais: evita conversor sem áudio conhecido e copia Opus conhecido. RTSP sem metadado continua conservador; não adivinha codec pelo cadastro.
- URL de sessão WHEP web restrita à mesma origem; limpeza limitada por timeout e sem seguir redirecionamento.
- Sondagens de estatísticas dos players mobile sem chamadas simultâneas sobrepostas.
- Captura de poster não abre fonte de câmera explicitamente desativada.
- Modelo SRS da Gateway bloqueia RTMP PLAY em todos os seus vhosts, preservando publish/forward. A configuração remota não foi substituída: contém particularidades, inclusive demo-04, que devem ser preservadas.
- Evento local `s2cam:live-receiver-sample` com contadores de vídeo, perda, jitter, buffer, tempo de decode, congelamentos, RTT e relay; sem SDP, URLs ou endereços ICE. Nenhum envio automático ao servidor.

## Cobertura do relatório e pendências reais

| Achado | Estado |
|---|---|
| V01/V02 | Corrigidos no código; primeira negociação de áudio continua possível. Falta ensaio no aparelho do usuário. |
| V03/V04 | Contagem, exceção por prontidão e admissão no processo corrigidas. Orçamento ponderado por codec/resolução ainda não implementado; limite atual é conservador por processo. |
| V05/V06 | Contador e diagnóstico corrigidos; precisam chegar à versão servida. |
| V07 | Receptor já vigia quadros de vídeo; instrumentação ampliada. Watchdog servidor continua por bytes, sem prova por trilha; não foi inventada métrica ausente na API. |
| V08 | Bitrate estável e proteção de leitores implementados. Migração totalmente versionada de grafo não implementada. |
| V09/V10 | Consolidação de fontes RTSP/IA/gravação não executada: exige preservar main/sub, fonte original das gravações, autenticação e recuperação. Alterar só o nome do caminho quebraria limpeza/reconciliação. RTMP já compartilha entrada. |
| V11 | Codec/ausência tratados quando runtime informa. Falta probe de áudio RTSP compartilhado e validação HLS/HEVC/Opus nos aparelhos suportados. |
| V12 | Seleção/mute corrigidos; matriz completa de dispositivos ainda não executada. |
| V13 | Proteções implementadas; nenhuma exploração foi realizada. |
| V14 | Template corrigido e sintaxe validada com SRS 6 local. Gateway SRS 5 efetiva ainda requer validação/aplicação cuidadosa e teste de acesso. |
| V15/V16 | Instrumentação de receptor adicionada; medições A/B, origem/PTS/GOP, TURN e carga ainda pendentes. Nenhuma alteração especulativa de timestamp. |
| V17 | Captura bloqueada para desativadas; origem exata dos pedidos antigos ainda deve ser rastreada. |
| V18 | Git não equivale a implantação: API/web/APK/Gateway não foram atualizados nesta etapa. |

## Validação

- API: compilação TypeScript aprovada. Bateria ampla inicial: 1.631/1.633; uma falha de fixture (campos omitidos versus câmera explicitamente desativada) corrigida, outra era ausência de arquivos operacionais no contêiner de teste. Reexecução direcionada da regressão RTMP passou; dez testes operacionais passaram após montar os arquivos corretos.
- Testes comportamentais novos exercitam cópia H.264 com áudio, HEVC por modalidade, proteção de leitores ativos, identificação de áudio e admissão concorrente/liberação de slot.
- Web: 541 testes aprovados após incluir telemetria; testes de origem WHEP e cálculo de FPS incluídos.
- App: TypeScript aprovado e 115 testes aprovados com os mocks nativos oficiais do repositório.
- SRS: configuração validada em processo isolado (`-t`), sem rede e sem reiniciar produção; versão local de teste 6.0.191, não confundir com Gateway 5.

## Ensaio de produção ainda necessário

Identificar cliente/navegador; implantar API/web com rollback e publicar novo APK conforme o fluxo da Central. Drenar a sessão antiga da sala para aplicar a política sem expulsar leitores. Medir mesma câmera/qualidade/rede com e sem áudio: FPS origem/saída/receptor, CPU por processo, banda, perda, RTT e sincronismo A/V. Testar HLS e HEVC antes de declarar compatibilidade geral.

Captura local temporária das métricas pelo técnico no navegador:

```js
const samples = [];
const collect = ({ detail }) => {
  samples.push(detail);
  if (samples.length > 300) samples.shift();
};
window.addEventListener('s2cam:live-receiver-sample', collect);
// Ao terminar:
window.removeEventListener('s2cam:live-receiver-sample', collect);
console.table(samples);
```

Não declarar todas as 18 linhas concluídas nem prometer 20 FPS: a economia e a estabilidade precisam ser comprovadas em execução.
