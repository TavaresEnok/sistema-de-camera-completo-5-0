# Grid: texto do detector e CPU medida — 08/10/2026

Publicado em Vibe, Dguardian e IB Telecom. Versão da API: `41612cf9d25b35272ff7f290d06d51e43bafda02`; frontend: `grid-label-cpu-20261008`. Demo e APK fora do escopo.

## Opção visual por câmera

Cadastro/edição da câmera → Geral → Mostrar porcentagem do detector, abaixo do aviso de movimento. Valor padrão falso para câmeras existentes e novas, salvo no banco. A API valida booleanos reais; strings como `"false"` não podem virar verdadeiro por conversão implícita.

No grid, inclusive 1×1, o texto como “Pessoa 38%” fica oculto por padrão; quadrado, coordenadas, rastreamento e detecção permanecem. Ativar a opção exibe nome e porcentagem no grid. Ao ampliar uma câmera individual ou em outras páginas, o comportamento do texto é preservado. A decisão visual é separada do perfil de vídeo, pois uma grade 1×1 pode usar o perfil de resolução original e ainda ser grid.

O salvamento usa o PATCH de câmera já existente e envia apenas campos alterados. Esta opção não entra na lista de campos que reiniciam análise. Teste isolado confirmou alternância verdadeiro/falso, persistência na listagem e leitura individual, outras câmeras inalteradas, sem ligar IA nem gravação.

## Indicador de CPU

Antes, `PerformancePage.tsx` calculava CPU como `min(100, loadAverage[0] / cpuCount * 100)`. Baseline em Vibe: dez CPUs, carga 11,35 e CPU medida em 69,1%; a fórmula exibia 100%. Carga média não é percentual de CPU ocupada.

Agora `/health/system` fornece `cpuUsagePercent`, `cpuUsageSampledAt` e `cpuUsageWindowMs`, usando a diferença dos contadores de CPU em um intervalo de um segundo. Requisições simultâneas compartilham a medição e há cache de dois segundos. Não há processo adicional, laço permanente ou inferência extra. O frontend não usa carga como fallback e mostra “aguardando medição” quando o valor não existe.

Verificação após a publicação em Vibe: endpoint autenticado HTTP 200; CPU da API 81,37%, observação independente 82,03%, janela 1.135 ms. A fórmula antiga ainda exibiria 100%. Outra amostra retornou 82,89% versus 80,40% observado. Os intervalos não são perfeitamente sincronizados; não se promete igualdade entre amostras de ferramentas diferentes nem CPU fixa em 69%.

## Evidências e proteção

- Typecheck web e compilação API aprovados.
- 567 testes frontend aprovados. Suíte completa API: 1.732 aprovados, dois opcionais ignorados, zero falhas antes do último endurecimento do booleano; regressões finais CPU/DTO: três aprovadas. Testes do publicador: três aprovados.
- Ambiente novo isolado: 69 migrações, preferência por câmera persistida, entrada inválida recusada, leitura de CPU numérica com janela de 1.004 ms. Seis casos de vídeo HLS com sequências avançando; comportamento de áudio/compatibilidade e aviso de movimento manual preservados. Vídeos sintéticos, não teste físico.
- Arquivo assinado de imagens API/web, 22 camadas inspecionadas, nenhum arquivo-fonte proibido. Migração aditiva limitada a uma coluna booleana com padrão falso. Backup do banco e configurações antes de cada instalação; rollback mantém a coluna aditiva, sem apagar dados ou restaurar banco antigo.
- Nas três instalações o publicador confirmou API pronta, assinatura válida e IA/MediaMTX/ingestão RTMP sem mudança de imagem ou horário de início. Dguardian preservou o anúncio DDNS do vídeo.
- Vibe: 35 câmeras, modos 34 manual/1 objeto; digest dos campos de cadastro, credenciais de câmera e configuração de análise idêntico antes/depois: `fb4b517cb4d78000bf169dc53c925b7455c207363fd1eb4767a49c7045e397b1`. Nenhuma câmera iniciou com porcentagem habilitada.

Nesta rodada, os testes de renderização são verificações de lógica/código da interface; não houve nova inspeção visual completa em navegador. A tentativa de obter a ferramenta de navegador foi interrompida por demora no download. Não se afirma teste físico ou certificação de todos os aparelhos.

Código canônico atualizado na Management. Esta publicação incremental não altera o pacote completo padrão da Central nem gera APK. Backups e resultados ficam em `infra/backups/viewing-updates/`; laboratório e logs em `runtime-artifacts/grid-cpu-*` da Management.
