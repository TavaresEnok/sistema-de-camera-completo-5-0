# Retorno à grade em tela cheia

## Problema e evidência

Em `apps/web/src/pages/LiveViewPage.tsx`, o botão normal
`button-restore-grid` pertence à barra que fica escondida quando `wallMode`
está ativo. Os controles do mural tinham apenas a saída da tela cheia.

## Correção

O mural agora oferece `Voltar à grade` quando `focusedCameraId` está ativo.
O controle permanece visível durante a ampliação. Ele chama a mesma função
`restoreLayout`, restaurando a quantidade, as câmeras e as posições anteriores,
sem chamar a API de saída da tela cheia nem trocar de página.

## Validação

- 558 testes automatizados da interface passaram, incluindo uma nova regressão
  para o controle do mural e para a ausência de saída da tela cheia na restauração.
- Verificação TypeScript sem erros.
- Publicação limitada ao frontend da Vibe; API, IA, gravação e transporte de
  vídeo não precisam ser reiniciados.
- Os testes de regressão verificam código e estado; não substituem um teste
  manual da tela cheia no navegador do cliente.

## Implantação e reversão

Imagem nova: `drac-pipeline-web:20261002-wall-grid-return`.
Imagem anterior preservada: `drac-pipeline-web:20261002-overlay-fixes`.
O Dockerfile específico reutiliza as dependências instaladas e substitui apenas
os arquivos compilados do frontend, preservando o proxy de mídia do runtime.
O serviço `web` utiliza a nova imagem no override de produção da Vibe.
Para reverter, restaurar apenas a imagem anterior nesse override e recriar
somente `web` com `up -d --no-deps --no-build web`.
