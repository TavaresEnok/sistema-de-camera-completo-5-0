# Alarmes sonoros de segurança — 30/10/2026

O som Atenção mantém os quatro pulsos, frequências, ganho e envelopes anteriores.
As escolhas urgent, siren, intrusion e rapid mantêm seus identificadores salvos,
mas passam a usar alarmes encorpados de evacuação, emergência, invasão e pulsação.
Todos continuam com um segundo de duração, conforme a escolha do produto.

A sirene recebe a maior prioridade quando há vários eventos no mesmo lote.
Os sinais combinam harmônicos, tons simultâneos, corpo grave e textura de ar.
Há limitador suave e fades curtos nas extremidades para evitar clipping e cliques.
O volume do dispositivo e o botão global de silenciar continuam sob controle do
operador; a prévia explícita continua disponível na edição da câmera.

Geração PCM local e determinística, com cache limitado a doze sinais. Não há
downloads, permissões de mídia ou serviço externo para reproduzir os sons.

Verificação: duração e amplitude em quatro frequências de amostragem, sinais
distintos, preservação exata do Atenção, silenciamento, prévia e encerramento do
AudioContext. TypeScript e build da interface. Implantação assinada somente da
interface, conservando a API, o banco e os processos de vídeo em execução.
