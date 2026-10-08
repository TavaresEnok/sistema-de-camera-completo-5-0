# Avisos independentes e versão unificada — 08/10/2026

Versão de aplicação: `980a16c353f13d9a3f5dfc7b78886bb67d778cf8`. Interface: `independent-notices-20261008`. Instalações de produção em escopo: Vibe, Dguardian e IB Telecom; demo e geração de APK excluídas.

## Uso

Editar câmera → Geral ou Gravação → **Avisar na tela**. Escolher movimento, pessoas/veículos ou ambos. Tipos de objeto podem ser selecionados individualmente, limitados ao plano. Seleção vazia significa todos os tipos atualmente disponíveis no plano. O mesmo controle existe no cadastro RTSP e RTMP.

Avisos discretos no canto inferior direito, inclusive em tela cheia. Exemplos: “Portaria detectou movimento.”, “Portaria detectou uma pessoa.”, “Portaria detectou uma moto.” Não mostram porcentagens, não iniciam gravação e não enviam Telegram/e-mail. Dependem de sessão aberta no navegador, câmera ativa e conexão disponível. Gravação manual e gravação desativada são preservadas. Permissões de acesso a câmeras privadas continuam aplicadas.

## Implementação

- Dois campos aditivos por câmera: `objectNoticeEnabled` (padrão falso) e `objectNoticeClasses` (padrão vazio). Migração `20261008210000_camera_object_notice`, total de 70 migrações.
- Aviso por objeto mantém o processador da câmera ativo no início, reinício e watchdog, mesmo sem gravação. Não abre um segundo pipeline. Reutiliza detecção, confirmação e acompanhamento existentes. Habilitar objetos em uma câmera antes sem essa análise aumenta o trabalho do detector; não se promete custo zero ou capacidade ilimitada.
- Tipos independentes dos usados na gravação. A API valida os tipos contra o plano e filtra novamente na leitura, inclusive após mudança de licença. Simulação de perímetro preservada.
- Um único feed autenticado `/cameras/detection-notices`, a cada três segundos somente quando necessário. Sem repetição de histórico ao entrar. Avisos limitados por câmera/tipo/classe a um a cada 30 segundos, no máximo três visíveis por seis segundos; janela recente de 30 segundos e memória limitada. Aviso de movimento não oculta um aviso de pessoa que chega logo depois.
- O endpoint antigo de movimento foi preservado para compatibilidade. A flag de alertas já configurados e os modos de gravação não foram substituídos pelo aviso na tela.

## Evidências

- API: compilação aprovada; 1.741 testes aprovados, dois opcionais ignorados, zero falhas. Interface: checagem de tipos, build e 570 testes aprovados. Publicação/empacotamento: 22 testes aprovados.
- Renderização React real do controle confirmou estados desligado, plano somente movimento, somente pessoas e pessoas/veículos, sem oferecer classes não liberadas. Não é uma nova bateria visual completa de navegador/aparelhos.
- Ambiente Docker novo e isolado: 70 migrações, API pronta, login HTTP 201, IA compilada sem fonte Python; seis reproduções HLS reais com sequências avançando e isolamento de áudio inválido. Vídeos sintéticos, não teste físico em cliente.
- YOLO executou duas chamadas de modelo sem erro no teste de aviso por objeto. Eventos controlados de pessoa/carro validaram o caminho evento → API → seleção; carro foi filtrado quando somente pessoa estava escolhida. Isso não é uma nova medição de precisão do detector.
- Gravação manual e por movimento com gravação desativada permaneceram sem arquivos após avisos; tipo fora do plano retornou 403, booleano inválido retornou 400, leitura sem autenticação retornou 401. Ao desligar avisos e manter manual, o detector foi encerrado.
- Inspeção de imagens API/web e pacote completo não encontrou arquivos-fonte proibidos. Assinatura e integridade verificadas antes da atualização. Backups do banco e configuração foram preservados; IA, MediaMTX e ingestão RTMP mantiveram imagens e horários de início.
- Configurações existentes comparadas antes/depois por digest: Vibe 35 câmeras, Dguardian três, IB Telecom 27. Inclui credenciais cifradas de câmera, chaves/caminhos RTMP, modos de gravação e preferências anteriores; nenhum segredo é registrado no relatório.

## Publicação e instalação

Pacote completo assinado da Central: `980a16c353f13d9a3f5dfc7b78886bb67d778cf8.tar.gz`, SHA-256 `81c879a8015b56beb3ef6d693ef09ddee439ddb44a9422c10723207f0df89746`, 955.934.674 bytes. Instalador SHA-256 `62c8d5b5c801294e3a05a42bea9332a76120d9186561b2185db2e79e82711c28`.

A versão foi aprovada para as três instalações e como padrão de novas instalações. As imagens API/web efetivamente instaladas e a imagem de IA existente foram comparadas com o pacote completo; metadados e nove arquivos de instalação/atualização assinados foram alinhados, sem reiniciar os serviços de vídeo. Código canônico da Management atualizado. Nenhum APK foi gerado.

Na Dguardian, a transferência lenta foi reduzida por reaproveitamento de arquivo: 137.092.344 bytes correspondentes e 63.306.504 novos em um arquivo de 200.398.848 bytes. Variante de transporte sem gzip assinada na Management; mesmas imagens imutáveis e mesma migração. O checksum integral foi verificado antes de importar as imagens. Nenhuma chave de assinatura privada saiu da Management.

Backups por instalação: `infra/backups/viewing-updates/980a16c353f13d9a3f5dfc7b78886bb67d778cf8/` e `infra/backups/independent-notices-20261008/`. Evidências de testes, assinatura e promoção na Management: `runtime-artifacts/independent-notices-*`.
