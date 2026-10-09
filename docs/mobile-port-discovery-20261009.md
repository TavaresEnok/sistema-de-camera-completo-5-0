# Busca de portas no cadastro pelo aplicativo — 09/10/2026

## Causas verificadas no código anterior

- A lista automática não incluía 5540, usada em instalação real.
- O aplicativo não enviava ao servidor a escolha entre porta manual e automática.
- Porta TCP aberta era usada como sinal de disponibilidade RTSP, inclusive para outro serviço.
- A sonda podia repetir a porta informada e aguardar descoberta PTZ, perfis principal/sub e estimativa de bitrate antes de responder.
- O estado final considerava a porta original mesmo quando o vídeo foi confirmado em outra.

## Correção

- `rtspPortMode` opcional e validado somente no diagnóstico; não é persistido no cadastro.
- Endpoint privado do aplicativo usa fluxo limitado a 60 segundos. Prazo aplicado também aos sockets, processos ffprobe e consultas ONVIF; não é apenas timeout da tela.
- Manual testa exclusivamente a porta indicada. Automático verifica dez portas comuns, incluindo 5540, e até seis portas adicionais anunciadas pelo ONVIF, sempre no IP informado pelo usuário. Não varre 65.535 portas e não cria rotas/NAT.
- OPTIONS sem senha identifica RTSP e descarta HTTP. Aparelhos que ignoram OPTIONS ainda recebem teste de vídeo. Porta aberta não basta para aprovação: ffprobe deve confirmar codec e dimensões de vídeo.
- Até três verificações leves de portas em paralelo; somente um ffprobe por cadastro, inclusive para câmeras com limite de sessões.
- Caminho informado é tentado sozinho primeiro. Caminhos ONVIF são preferidos e a porta manual externa não é substituída pela interna do aparelho.
- Retorna assim que confirma vídeo, sem aguardar PTZ, bitrate ou separação de perfis. O provisionamento posterior ao cadastro permanece responsável pela descoberta completa.
- Recusa de credenciais interrompe tentativas de caminhos. Erros simples distinguem porta inacessível, serviço sem RTSP, acesso recusado, vídeo indisponível e prazo excedido.
- Diagnóstico legado do navegador também ganha 5540 e estado baseado no vídeo efetivamente confirmado. Demais operações, permissões, licença, gravação e IA não são alteradas.
- Revisão adicional do Wi-Fi: anúncios mDNS passam a preservar separadamente RTSP, HTTP e ONVIF; mesclar anúncios não perde essas portas. Ao selecionar um aparelho, a porta RTSP anunciada não é mais colocada em HTTP. Quando só há ONVIF/TCP, o aplicativo solicita descoberta automática de vídeo em vez de fixar incorretamente 554. A varredura local inclui 5540/10554/5544 e reduz a concorrência total de sockets (96 para 66), com um pouco mais de tolerância a respostas lentas.

## Validação

- Compilação TypeScript de API e aplicativo.
- Testes de orquestração e sockets reais (RTSP, HTTP e serviço silencioso), porta incomum anunciada por ONVIF, porta externa manual, senha recusada, limite de tempo e concorrência.
- Testes do aplicativo, payload distinto para diagnóstico/cadastro e mensagens simples.
- Renderização React do fluxo manual/automático, confirmação/salvamento, erros sem avançar, cancelamento e recuperação da cota.
- Laboratório Docker descartável com API/banco reais, proxy RTSP 5540, HTTP falso na 554, ONVIF em 8000 e ffprobe lendo vídeo sintético. Além disso, regressão das seis reproduções HLS, privacidade, avisos e IA.

Não equivale a teste físico no celular ou garantia de acesso a qualquer câmera. Um telefone na rede local pode encontrar um aparelho que o servidor não alcança; nesse caso é necessária conectividade real ou envio RTMP. Nenhum APK deve ser gerado por esta manutenção: o cliente solicita a geração na Central.
