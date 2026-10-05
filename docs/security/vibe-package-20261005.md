# Vibe: migração local para pacotes assinados

## Preparação (05/10/2026)

- Migração autorizada pelo proprietário. 34 câmeras, 7 usuários, 6 grupos; 3 câmeras em movimento, 31 em modo manual. Nenhuma sessão de gravação manual ativa na preparação.
- Pacote previamente validado em laboratório Docker isolado, vídeo sintético, captura/movimento/gravação/HLS; não representa validação física ou ICE do cliente.
- Release por instalação aprovada na Central: `66317dcf01e230a3e9bffa7fb6a69483c06c97e0`. Aprovação não promoveu a frota global.
- Schema atual e pacote idênticos: `57b29171f34c557f1bca565bef966f82b6a98ed966ca6ef13d8b04e7c7265295`, 66 migrações.
- Backup externo em `/opt/ajustcam-management/backups/vibe-pre-package-20261005`, Management, protegido. Inclui alterações locais não commitadas.
- Fonte/configuração antes da troca: SHA256 `4b9a1bbc10c60d3f2d819c855bea75c91c01b0fd4113708141c15af900976ab3`.
- Imagens anteriores da aplicação: SHA256 `02353ff58b7951997ace073d8e87f2330bab2b3128bb3fcc2fd16b15ab7d64d4`.
- Configuração das câmeras/grupos (exclui campos voláteis de estado/sonda): SHA256 `82a81da44312ea7770d2217cc9259ee4733cb11843b2cea6abcef7f05bb63e54`.
- Contas antes da troca: SHA256 `43f4a297c1fa1b09709e34c563796022b517dfca91428bfd405ac7d1f982ad35`.
- Identidade local: device.pem SHA256 `3a60e8fecacf9d3eb04a4209a3a9eec269034d1bb121ac4d626c9b756f5b9310`; chave privada emissora não foi distribuída.
- Ingestão antes da troca: MediaMTX 91 caminhos, 62 prontos, 66 leitores. Valores instantâneos, não contagem de câmeras online.
- Movimento efetivo antes: aproximadamente 6,84–6,90 FPS nas três análises; configurado 7 FPS.
- Testes de assinatura/ciclo/schema e confirmação explícita de câmeras: 14/14 aprovados.

## Limites

Compilação e retirada das fontes não impedem engenharia reversa ou adulteração por root. Interface e modelos continuam inspecionáveis. Histórico de sessões externas e cópias já obtidas não são apagados por esta migração. O backup não é restauração automática do banco: não restaurar licença/credenciais antigas para desfazer uma troca de imagem.

## Verificação após a troca

- API, web e IA saudáveis; frontend público 200; Chromium encontrou tela de login e zero erros JavaScript. Não foi feito login por senha nem teste físico do navegador do cliente.
- Licença ACTIVE, lastError vazio, assinatura obrigatória. Identidade SHA256 permaneceu idêntica.
- 34 câmeras/7 usuários. Hash de usuários (inclusive senhas) permaneceu idêntico. Comparação do COPY da tabela Camera do pg_dump com o Prisma atual confirmou que perímetros/modos/grupos/configuração permaneceram. Diferenças: estado, timestamps, medições de stream e recordingEnabled alternado pelo gerenciador de gravação. Não restauramos estes campos operacionais.
- Captura nativa ativa nas mesmas três câmeras; movimento efetivo 6,86–7,00 FPS na verificação após aquecimento. Nenhum erro de IA recente.
- Requisição autenticada de manutenção com token de 180 segundos mantido em memória: API de câmeras 200, licença 200/ACTIVE, entrega grid 200 e playlist HLS autenticada 200 nas três câmeras. Primeiro teste esqueceu o token da mídia e retornou 401; corrigido o teste para seguir o frontend, sem relaxar autenticação.
- Cinco gravações novas por movimento, distribuídas entre as três câmeras, cinco arquivos locais presentes.
- IDs/horários de início de MediaMTX, SRS, PostgreSQL e Redis idênticos aos anteriores. Na inicialização da API, proteção fail-safe de gravação foi acionada e encerrada quando os detectores voltaram; um pedido de ingestão recebeu 401 transitório na inicialização. Verificação posterior da API MediaMTX retornou 200, 91 caminhos/62 prontos.
- Atualizador assinado: `Runtime já está na versão aprovada.` Preservado conjunto completo de overlays, threads, FPS, tracking, TURN, configurações e volumes.
- Arquivo de cópias de desenvolvimento transferido e conferido na Management: SHA256 `8eeadfe489b89b8ee323698073f2ca6e74db63873aef2995bf113514cc63e37a`.
- Limpeza proposta/escopo exato em `scripts/security/clean-vibe-package-source.py` e 63 imagens identificadas em `tools/vibe-obsolete-images-20261005.json`. Nenhuma remoção de volume, câmera, gravação ou container de produção de vídeo/banco.
