# Cadastro de câmeras no aplicativo

## Fluxo

Escolher conexão → informar dados → conferir → adicionar. A entrada continua disponível pelos atalhos existentes do aplicativo e usa o mesmo componente nos temas claro/escuro e nas instalações white-label.

- A tela inicial explica endereço IP, busca no Wi-Fi, QR de integração e envio RTMP em linguagem simples.
- Indicador de três etapas, ações fixas no rodapé, conteúdo rolável, área de toque de 44 px no cabeçalho, largura limitada em tablet e ajuste acima do teclado.
- Portas e caminho podem ser informados antes do primeiro teste. A validação recusa IP, porta e caminho inválidos; preserva a senha exatamente como digitada.
- Colar IP/endereço RTSP e ler QR preenchem os campos. Credenciais de uma câmera anterior não são herdadas ao escolher outro dispositivo/importar outro endereço.
- Teste pelo servidor com até 90 segundos e cancelamento HTTP. Alterar dados de conexão invalida o resultado anterior; respostas atrasadas não avançam a jornada.
- Conferência com imagem inteira sem recorte, nome editável e explicação da câmera privada vinculada ao usuário atual.
- Localização do celular opcional, desligada inicialmente. A orientação Wi-Fi preserva configurações de equipamentos em uso.
- RTMP também exige conferência antes do POST; entrega endereço completo, servidor e chave com cópia individual. Endereço ausente na resposta é consultado novamente pelo endpoint do proprietário.
- Limite do plano verificado, falha com nova tentativa, bloqueio de clique repetido durante cadastro e confirmação ao descartar dados preenchidos.

## Limites e publicação

Usa os endpoints existentes `/cameras/mine`, `/cameras/mine/quota`, `/cameras/mine/test-connection`, `/cameras/mine/preview-frame` e `/cameras/mine/:id/rtmp-ingest`. O proprietário é definido pelo servidor. Cadastro via app continua sendo autoatendimento privado; as permissões administrativas do navegador não são transferidas ao cliente.

Busca local identifica candidatos; o servidor precisa alcançar a câmera para receber RTSP. Não há promessa de pareamento proprietário por Wi-Fi. Alertas e gravação não foram liberados por fora das permissões existentes.

Validação: TypeScript; 122 testes móveis e seis testes de manutenção do gerador, todos aprovados; renderizador React 19 com adaptadores nativos/HTTP simulados para RTSP, RTMP, cancelamento e falha de cota. Não equivale a uma validação física em Android/iOS. O APK será gerado pelo operador na Central; nenhum APK é produzido nesta tarefa.

A publicação móvel usa o commit aprovado pela Central. As imagens de API, web e IA permanecem idênticas à versão de câmeras privadas já publicada. O pacote completo é assinado novamente para associar o código móvel aprovado à mesma base de servidor, após verificar o pacote e executar o laboratório isolado.
