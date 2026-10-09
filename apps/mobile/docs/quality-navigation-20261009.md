# Qualidade e navegação do aplicativo

- O botão exibe a seleção atual: HD+ destacado; Economia sem o destaque de HD+.
- HD+ solicita `original`/`original-audio`; Economia solicita `grid`/`grid-audio`.
- A tela aguarda a resposta do perfil escolhido antes de montar o player. Falha
  não restaura silenciosamente a qualidade anterior; há nova tentativa.
- Respostas atrasadas são ignoradas após trocar qualidade, câmera ou desmontar.
- Ligar áudio renova a qualidade selecionada pelo mesmo controlador; não abre
  requisições concorrentes de qualidade pela tela e pelo App.
- Removido o pré-aquecimento automático do perfil reduzido ao abrir HD+.
- A recuperação de codec do layout antigo também usa HLS do mesmo original.
- A resolução/FPS da câmera não são apresentados como se fossem os do perfil
  reduzido, e valores 1080p/30 FPS desconhecidos não são inventados.
- Nome e avatar abrem Configurações em ambos os layouts. Aba: Config.; título e
  acessibilidade: Configurações. O identificador interno continua `ajustes`.
- Removidos aba, rota e polling de Ronda no app. O recurso web permanece intacto.

## Validação

TypeScript sem erros; 138 testes do app aprovados. Validação adicional com React
real e adaptadores nativos/vídeo simulados: 8 fluxos aprovados, incluindo troca
rápida, resposta atrasada, falha/nova tentativa, áudio, troca de câmera, URLs dos
players e navegação nos dois layouts. Evidência de manutenção na Management:
`runtime-artifacts/mobile-quality-{tests,ui-validation}-20261009.*`.

Esta alteração é somente do aplicativo. A publicação reaproveita exatamente os
mesmos arquivos e imagens de servidor do pacote anterior assinado; não exige
reiniciar câmeras, API ou IA. Não gerar APK automaticamente: o operador fará a
geração pela Central e instalará o novo aplicativo. A validação simulada não
substitui a conferência de reprodução em um aparelho Android real.
