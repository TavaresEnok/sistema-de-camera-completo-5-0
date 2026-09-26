Resumo executivo

Os sistemas não são concorrentes diretos em todos os aspectos:

Frigate é superior como motor NVR com IA: detecção, rastreamento, objetos estacionários, aceleração por hardware, PTZ automático e integrações.
AjustCam/DRAC é superior como produto comercial de videomonitoramento: aplicativo nativo, central de instalações, usuários e permissões, evidências, white-label e operação para múltiplos clientes.
Para unir os pontos fortes, a melhor arquitetura seria AjustCam como plataforma comercial e Frigate como motor local de IA/NVR.

A análise foi feita em 14/08/2026 sobre o main do AjustCam/DRAC e o dev do Frigate. Não foi realizado benchmark físico de câmeras, CPU ou GPU.

Comparação geral
Característica	AjustCam / DRAC	Frigate	Vantagem
Objetivo principal	VMS comercial completo, com central, clientes, usuários e aplicativo	NVR local especializado em IA	Depende do uso
Arquitetura	NestJS, React, React Native/Expo, PostgreSQL, Redis/BullMQ, MediaMTX, FFmpeg e serviço Python	NVR multiprocessado, FFmpeg, go2rtc, SQLite, web/PWA e MQTT	AjustCam em modularidade comercial
Instalação	Docker Compose, com vários serviços	Docker/HAOS, geralmente mais consolidado	Frigate em simplicidade operacional
Configuração de câmeras	Cadastro e descoberta ONVIF mais orientados pela interface	Configuração mais técnica e centrada em YAML/UI	AjustCam
Vídeo ao vivo	WebRTC/WHEP via MediaMTX, HLS como fallback	go2rtc, MSE, WebRTC, jsmpeg e restream RTSP	Frigate em flexibilidade
Perfis de câmera	Perfis separados para gravação, live e análise	Streams com funções record, detect e áudio	Empate
Gravação	Contínua ou movimento, retenção, proteção de disco, evidências e S3	Cópia direta do stream, retenção contínua/movimento/alerta/detecção e exportação	Frigate em maturidade; AjustCam em fluxo comercial
Aplicativo móvel	Aplicativo nativo React Native/Expo, com possibilidade de white-label	PWA instalável	AjustCam
Multi-instalação	Central, heartbeat, provisionamento e licenciamento	Cada instalação é principalmente independente	AjustCam
Home Assistant e automação	Integrações próprias/API	Integração madura com Home Assistant, MQTT, WebPush e Prometheus	Frigate
Evidências	Investigação, exportação e integridade SHA-256/HMAC	Exportação de gravações e eventos	AjustCam
Licença	Não há licença pública declarada no repositório	MIT, com regras separadas para a marca	Frigate
Maturidade pública	Projeto recente, sem releases ou tags estáveis	Milhares de commits, centenas de contribuidores e releases frequentes	Frigate

A arquitetura comercial do AjustCam está documentada no seu README. A arquitetura de vídeo e processamento do Frigate está descrita na documentação principal e no pipeline de vídeo.

Comparação de IA e rastreamento
Item	AjustCam / DRAC	Frigate	Avaliação
Detecção de movimento	OpenCV MOG2, normalmente em baixa resolução e cerca de 2 FPS	Movimento adaptativo utilizado para gerar regiões que alimentam a IA	Frigate possui integração mais madura
Detecção de pessoas/objetos	YOLO26n com OpenVINO, normalmente INT8; classes padrão incluem pessoa e veículos	Vários modelos, formatos e detectores configuráveis	Frigate
Funcionamento padrão	O perfil padrão é motion; IA semântica está desativada no Compose atual	Detecção de objetos é parte central do pipeline	Frigate
Tracker	ByteTrack da biblioteca Supervision	Norfair customizado com filtro de Kalman e parâmetros próprios por classe	Frigate para vigilância
Objetos estacionários	Há implementação de regiões, cache e rechecagem, mas o recurso fica desativado por padrão	Recurso nativo e integrado ao pipeline	Frigate
Oclusão e continuidade de ID	Dependente do ByteTrack e da frequência de inferência de 1–4 FPS	Histórico, distância customizada, classificador estacionário e mecanismos adicionais para PTZ	Frigate
Bounding box no live	Existe para eventos OBJECT e FACE; não é desenhado para movimento simples	Boxes e trajetória aparecem em debug/revisão; existe ajuste temporal entre streams	Depende da interface desejada
Transporte da box	Frontend consulta as detecções por HTTP aproximadamente a cada 500 ms	Metadata integrada ao pipeline de objetos e revisão	Frigate tende a ter maior consistência
Aceleração	Objetos implementados principalmente em OpenVINO CPU/GPU/NPU; CUDA existe para face	Coral, OpenVINO, Nvidia/TensorRT/ONNX, AMD, Hailo, Rockchip, MemryX e outros	Frigate
Reconhecimento facial	O código atual implementa principalmente detecção facial; reconhecimento não está ativo por padrão	Reconhecimento facial integrado	Frigate
Leitura de placas	Não encontrei pipeline completo equivalente	LPR integrado	Frigate
Busca semântica	Não equivalente	Busca por linguagem e embeddings	Frigate
Áudio inteligente	Limitado	Detecção de eventos sonoros	Frigate
PTZ por IA	Controle PTZ manual, sem autotracking completo encontrado	Autotracking ONVIF com retorno a preset e busca do objeto perdido	Frigate

O suporte de hardware do Frigate está detalhado na documentação de detectores. Ele também possui recursos próprios para objetos estacionários, autotracking PTZ, reconhecimento facial e leitura de placas.

Diferença prática entre ByteTrack e o tracker do Frigate

O ByteTrack não é um tracker ruim: ele é rápido e eficiente. Porém, no AjustCam ele é usado com inferência relativamente baixa e a box chega ao navegador por polling. Isso pode produzir:

Pequeno atraso visual da box em relação à pessoa.
Saltos quando a pessoa muda rapidamente de direção.
Troca de ID em oclusões.
Desaparecimento da box entre inferências.

Além disso, embora exista uma variável GENERAL_TRACKER, o código atual instancia diretamente sv.ByteTrack; portanto, o tracker não é realmente selecionável hoje. Isso pode ser verificado no detector de objetos e nos perfis de execução.

O Frigate utiliza uma implementação Norfair adaptada para vigilância, incluindo Kalman, histórico de posições, tratamento de objetos estacionários e reidentificação por histograma em alguns cenários PTZ. Isso aparece no tracker Norfair do Frigate.

Ponto importante sobre a IA do AjustCam

O código possui detecção de objetos e pessoas, mas a configuração operacional atual não equivale a dizer que essa IA está ativa por padrão:

O modo padrão salvo é motion.
O Compose define MOTION_SEMANTIC_CONFIRM=false.
Movimento MOG2 serve principalmente para armar gravações.
O frontend deliberadamente não desenha boxes de movimento.
As boxes aparecem apenas quando o modo avançado produz eventos OBJECT ou FACE.

Esses comportamentos podem ser conferidos no Compose, no gerenciador de IA e no player ao vivo.

Usuários e segurança
Recurso	AjustCam	Frigate
Papéis	Super admin, administrador, operador e visualizador	Admin, viewer e papéis customizados
Permissões granulares	Sim, incluindo acesso por câmera	Sim, principalmente por papel e câmera
Câmera privada	Implementação específica para restringir conteúdo	ACL por câmera
Auditoria	Mais orientada ao contexto empresarial	Logs e eventos operacionais
Evidência assinada	SHA-256/HMAC	Não é o foco principal
Autenticação interna	API autenticada	Porta 8971 autenticada; porta 5000 interna não possui autenticação

No Frigate, a porta interna 5000 deve ficar isolada porque equivale a acesso administrativo. Isso está explícito na documentação de autenticação. A versão estável Frigate 0.17.2 corrigiu diversos problemas de segurança, mas ainda documenta alguns itens pendentes.

O AjustCam possui um modelo empresarial mais elaborado, porém o próprio projeto ainda mantém uma checklist de prontidão para produção com testes prolongados, restauração e validação de dispositivos ainda necessários.

Veredito por cenário
Cenário	Escolha indicada
Melhor detecção e rastreamento de pessoas hoje	Frigate
NVR residencial ou empresarial integrado ao Home Assistant	Frigate
Grande variedade de GPU, TPU e aceleradores	Frigate
PTZ seguindo automaticamente uma pessoa	Frigate
Produto white-label para vender a clientes	AjustCam
Aplicativo móvel nativo	AjustCam
Gestão central de várias instalações	AjustCam
Permissões empresariais, auditoria e cadeia de evidência	AjustCam
Melhor solução completa combinada	AjustCam + Frigate

Minha conclusão: o Frigate está consideravelmente à frente no núcleo técnico de IA/NVR, enquanto o AjustCam está construindo uma camada comercial e operacional que o Frigate não pretende oferecer. Para o AjustCam, eu manteria a central, aplicativo, usuários e evidências, mas consideraria integrar o Frigate via MQTT/API ou incorporar seus conceitos maduros de regiões, objetos estacionários, sincronização temporal e tracking.

fale para uma IA de produção de desenvolvimento o que ela precisa fazer especificamente para o ajustcam alcançar o frigate em Melhor detecção e rastreamento de pessoas hoje , Detecção de movimento  , Detecção de pessoas/objetos  , Tracker  , Objetos estacionários  , Oclusão e continuidade de ID  , Transporte da box  

Copie e envie o texto abaixo para a IA responsável pelo desenvolvimento do AjustCam:

Você atuará como engenheiro sênior de visão computacional, vídeo em tempo real, backend e frontend. Trabalhe diretamente no repositório:

https://github.com/TavaresEnok/sistema-de-camera-completo-5-0.git

Objetivo

Evoluir o pipeline de IA do AjustCam para alcançar ou superar o Frigate na:

Detecção de movimento.
Detecção de pessoas e objetos.
Qualidade do tracker.
Tratamento de objetos estacionários.
Continuidade de ID durante oclusões.
Estabilidade visual da bounding box.
Latência e sincronização do transporte da box até o navegador.

Use o Frigate como referência arquitetural:

https://github.com/blakeblackshear/frigate.git

Não faça apenas uma análise ou proposta. Implemente as alterações, testes, métricas, documentação, configuração de produção e mecanismo de rollback.

Diagnóstico inicial a ser validado

Antes de modificar o código, confirme no HEAD atual do AjustCam:

O modo padrão está configurado como motion.
A confirmação semântica está desativada no ambiente de produção.
A detecção avançada usa YOLO26n com OpenVINO.
object_detector.py instancia diretamente sv.ByteTrack.
A variável GENERAL_TRACKER não troca efetivamente o tracker.
O processamento prioriza o frame mais recente e descarta frames atrasados.
region_proposal.py já possui parte da lógica de regiões e objetos estacionários, mas o recurso está desativado por padrão.
O frontend recebe boxes por polling HTTP aproximadamente a cada 500 ms.
As boxes expiram rapidamente e usam timestamp/índice em vez do track_id como identidade visual.
As boxes de movimento MOG2 não são mostradas no vídeo ao vivo.

Se o código atual estiver diferente, documente as diferenças antes de implementar.

Arquivos prioritários

Analise e modifique, quando necessário:

services/ai-service-python/runtime_profiles.py
services/ai-service-python/stream_processor.py
services/ai-service-python/detectors/object_detector.py
services/ai-service-python/detectors/region_proposal.py
services/ai-service-python/detectors/runtime_registry.py
services/ai-service-python/detectors/face_detector.py
apps/api/src/ai/ai-manager.service.ts
apps/web/src/lib/live-detections-poller.ts
apps/web/src/components/LiveStreamPlayer.tsx
infra/docker-compose.yml
Testes correspondentes do serviço de IA, API e frontend.
1. Criar um benchmark antes das alterações

Não declare que o AjustCam alcançou o Frigate sem comparação mensurável.

Crie um conjunto de vídeos reais das quatro câmeras já utilizadas no ambiente de testes, contendo:

Pessoa andando lentamente e rapidamente.
Duas ou mais pessoas se cruzando.
Pessoa parcialmente escondida por porta, carro ou parede.
Pessoa parada por vários minutos.
Pessoa saindo e voltando ao enquadramento.
Ambiente diurno, noturno e infravermelho.
Chuva, sombras, árvores, insetos e mudança brusca de iluminação.
Pessoa pequena ao fundo e pessoa próxima à câmera.
Câmera com substream e stream principal em resoluções diferentes.

Execute AjustCam e Frigate nos mesmos vídeos e no mesmo hardware.

Colete:

Precisão e recall para pessoas.
Falsos positivos por câmera/hora.
Pessoas não detectadas.
IDF1, HOTA, fragmentações e trocas de ID.
Tempo até a primeira detecção.
Latência entre captura e inferência.
Latência de transporte da metadata.
Atraso visual entre a pessoa e a box.
FPS de detecção e FPS visual do tracker.
Consumo de CPU, GPU/NPU, RAM e VRAM.
Frames descartados e tamanho das filas.
2. Melhorar a detecção de movimento

O detector de movimento não deve apenas gerar um evento. Ele deve produzir regiões confiáveis para orientar a detecção de objetos.

Implementar:

Processamento em frame reduzido e preferencialmente em escala de cinza.
Threshold adaptativo configurável por câmera.
Filtros morfológicos para remover ruído.
Área mínima e máxima de contornos.
Agrupamento de regiões próximas.
Expansão das regiões para incluir a pessoa completa.
Máscaras de movimento.
Zonas de inclusão e exclusão.
Compensação de contraste em imagens noturnas.
Detecção de mudança global de iluminação.
Período de aquecimento após iniciar a câmera.
Congelamento temporário do aprendizado de fundo quando houver objeto válido.
Descarte de sombras, chuva, árvores e ruídos repetitivos.
Métricas de quantidade e área das regiões por câmera.

O movimento deve ativar inferência nas regiões relevantes, mas não pode ser a única forma de encontrar objetos. Execute também uma varredura completa periódica para detectar:

Pessoas que entraram durante falha de movimento.
Pessoas que permaneceram paradas.
Objetos não encontrados inicialmente.
Alterações ocorridas durante perda de frames.

Mantenha uma opção de fallback para MOG2 e permita ajustar os parâmetros por câmera.

3. Melhorar a detecção de pessoas e objetos

Separar claramente:

Detector de movimento.
Gerador de regiões.
Detector de objetos.
Tracker.
Classificador de estado estacionário.
Publicador de eventos.

O detector de objetos deve retornar detecções puras, sem controlar diretamente todo o ciclo do tracker.

Implementar:

Inferência por regiões geradas pelo movimento.
Mesclagem de regiões sobrepostas.
Região quadrada com margem ao redor do objeto.
Conversão correta das coordenadas da região para o frame original.
Varredura completa periódica.
NMS configurável.
Confiança mínima por classe.
Área, largura, altura e proporção mínima/máxima por classe.
Máscaras específicas para objetos.
Regras por zona.
Modelos e resolução configuráveis por câmera.
Perfis diferentes para grade e câmera selecionada.
Preservação da estratégia “latest frame”, evitando acumular frames antigos.

Não considere somente mAP do modelo. Avalie o conjunto completo no vídeo real.

Teste pelo menos:

YOLO26n INT8.
YOLO26s INT8.
YOLO26s FP16 quando houver GPU/iGPU adequada.
Modelo utilizado pelo Frigate no mesmo hardware.

A calibração INT8 não deve depender apenas de coco8. Crie um dataset representativo com imagens reais das câmeras, incluindo dia, noite, infravermelho, diferentes distâncias e oclusões.

4. Criar uma interface real de trackers

Remova o acoplamento direto com sv.ByteTrack.

Criar uma interface semelhante a:

TrackerBackend
ByteTrackBackend
NorfairTrackerBackend
Possibilidade futura de outro tracker.

A configuração GENERAL_TRACKER deve selecionar efetivamente o backend. Se o valor for inválido, a aplicação deve falhar com erro de configuração claro.

Utilize o ByteTrack como fallback, mas implemente um tracker de produção inspirado no comportamento do Frigate, com:

Filtro de Kalman.
Predição de posição entre inferências.
Associação por IoU.
Distância normalizada entre centroides.
Comparação de largura, altura e proporção.
Validação por classe.
Parâmetros diferentes para pessoa, carro, moto e placa.
Estados tentative, confirmed, lost, stationary e deleted.
Quantidade configurável de detecções para confirmar um objeto.
Tempo configurável antes de remover um objeto perdido.
IDs únicos e estáveis por câmera.
Histórico de posições e bounding boxes.
Velocidade e direção estimadas.
Reidentificação em situações ambíguas.

A detecção pode trabalhar entre 5 e 10 FPS, conforme o hardware, mas a box precisa ser atualizada visualmente entre inferências por predição e interpolação.

5. Implementar objetos estacionários como função de produção

A lógica existente em region_proposal.py deve ser revisada, testada e integrada ao pipeline principal.

Um objeto deve ser classificado como estacionário quando:

Permanecer com IoU elevado durante um período configurável.
O centro da box variar abaixo de uma tolerância.
Sua largura e altura permanecerem estáveis.
A imagem interna da box continuar semelhante.

Quando uma pessoa ou objeto ficar estacionário:

Não executar inferência completa em todos os frames.
Manter o mesmo track_id.
Manter a última box conhecida.
Guardar um recorte de referência.
Fazer rechecagens periódicas.
Reativar a inferência quando houver movimento próximo ou sobreposto.
Reativar se o recorte atual diferir significativamente da referência.
Executar uma varredura completa em intervalos configuráveis.
Detectar corretamente quando a pessoa sai do local.
Não criar um novo ID apenas porque houve uma pequena mudança corporal.

Crie configurações por câmera e classe:

Tempo para considerar estacionário.
Intervalo de rechecagem.
Máximo de tempo sem inferência.
IoU mínimo.
Distância máxima do centro.
Limiar de semelhança da imagem.
Quantidade máxima de boxes mantidas no histórico.

Meta: reduzir significativamente as inferências em cenas estáticas sem aumentar a perda de pessoas.

6. Melhorar oclusão e continuidade de ID

Implemente associação em múltiplas etapas:

Associar detecções de alta confiança aos tracks confirmados.
Associar detecções de menor confiança aos tracks restantes.
Usar posição prevista pelo Kalman.
Usar aparência somente quando houver ambiguidade.
Manter temporariamente tracks perdidos.
Fazer reidentificação se o objeto reaparecer em uma região compatível.

Para pessoas, utilize de forma controlada:

Histograma de cor.
Recorte de referência.
Embedding leve de aparência, se o hardware permitir.
Comparação de tamanho e trajetória.
Direção e velocidade anteriores.

O modelo de aparência não deve ser executado em todos os frames. Use-o principalmente quando:

Duas pessoas se cruzarem.
Houver boxes sobrepostas.
Um track reaparecer após oclusão.
Existirem dois candidatos possíveis para a mesma detecção.

Critérios obrigatórios:

Uma falha de inferência isolada não pode apagar a box.
A box deve continuar por predição durante uma pequena oclusão.
Pessoas se cruzando não devem trocar de ID com frequência.
Um objeto parado não deve receber IDs novos continuamente.
Um track perdido deve expirar de forma controlada.
Não publicar dois tracks para a mesma pessoa sem justificativa.
7. Substituir o polling da box por WebSocket

O polling atual não é adequado para tracking visual em tempo real.

Implemente no NestJS um canal WebSocket, preferencialmente utilizando a infraestrutura já existente no projeto.

Requisitos:

Uma conexão por sessão do usuário.
Inscrição e cancelamento por câmera.
Respeitar as permissões de acesso por câmera.
Enviar somente o estado mais recente.
Não acumular mensagens antigas.
Descartar metadata atrasada.
Reconectar automaticamente.
Ressincronizar o estado após reconexão.
Manter o endpoint HTTP antigo temporariamente como fallback.

Cada mensagem deve transportar, no mínimo:

cameraId
streamId
streamEpoch
sequence
frameId
captureTimestamp
sourcePts
processedTimestamp
publishedTimestamp
Dimensão do frame analisado.
Lista de tracks.

Cada track deve conter:

trackId
label
confidence
bbox normalizada.
velocity
direction
state
stationary
lastDetectionTimestamp
Indicação se a posição é detectada ou predita.
8. Sincronizar a box com o vídeo

Não basta entregar a metadata rapidamente. Ela precisa corresponder ao frame exibido.

Implementar:

Propagação de frame_id, PTS e timestamps desde o decoder.
Relógio monotônico no serviço de IA.
Identificador de época para cada reconexão do stream.
Buffer curto de metadata no navegador.
Seleção da box temporalmente mais próxima do frame exibido.
Uso de requestVideoFrameCallback quando suportado.
Interpolação entre duas posições conhecidas.
Extrapolação limitada a aproximadamente 100–200 ms.
Campo annotationOffsetMs configurável por câmera.
Interface de calibração do offset.
Tratamento do atraso diferente entre stream de análise e stream ao vivo.

O frontend deve:

Usar trackId como chave do elemento, nunca timestamp ou índice.
Manter a mesma box durante uma falha isolada.
Animar posições com requestAnimationFrame.
Evitar piscar a box.
Remover a box somente quando o estado do track expirar.
Aplicar corretamente object-fit, letterbox e mudanças de proporção.
Converter a box normalizada para qualquer resolução do player.
Tratar tela cheia, grade, rotação móvel e redimensionamento da janela.
Exibir opcionalmente ID, classe, confiança e estado estacionário.
9. Aceleração por hardware

Transforme runtime_registry.py em registro real de backends, sem apresentar como implementado aquilo que ainda é apenas planejado.

Implementar e testar progressivamente:

OpenVINO CPU.
OpenVINO Intel iGPU/NPU.
ONNX Runtime CUDA.
TensorRT para Nvidia, quando aplicável.
Futuramente Coral e Hailo.

O backend deve informar:

Dispositivo selecionado.
Modelo carregado.
Precisão utilizada: INT8, FP16 ou FP32.
Tempo médio e p95 de inferência.
Utilização do dispositivo.
Erro claro quando o runtime não estiver disponível.

A aceleração de transcodificação NVENC não deve ser apresentada como aceleração da detecção de objetos.

10. Observabilidade

Adicionar métricas por câmera:

FPS recebido.
FPS analisado.
FPS descartado.
Tempo de decodificação.
Tempo de movimento.
Tempo de inferência.
Tempo do tracker.
Tempo de publicação.
Latência total.
Quantidade de regiões.
Objetos ativos, perdidos e estacionários.
Trocas de ID.
Tamanho das filas.
Reconexões.
Mensagens WebSocket descartadas.

Disponibilize métricas para Prometheus e logs estruturados, sem registrar credenciais ou URLs RTSP completas.

11. Critérios de aceite

A implementação somente poderá ser considerada equivalente ao Frigate quando, no mesmo hardware e conjunto de vídeos:

Recall de pessoas for igual ou superior ao Frigate.
Precisão for igual ou superior ao Frigate.
IDF1 e HOTA forem iguais ou superiores.
Trocas de ID forem iguais ou menores.
Falsos positivos por câmera/hora forem iguais ou menores.
A box não piscar por falha isolada de detecção.
Pessoas paradas mantiverem o mesmo ID.
Pessoas cruzando tiverem continuidade aceitável.
A metadata não acumular atraso progressivo.
Latência de transporte WebSocket p95 ficar abaixo de 100 ms na LAN.
Erro de sincronização box/vídeo p95 ficar abaixo de 150 ms, após calibração.
O sistema suportar pelo menos sete dias contínuos nas quatro câmeras piloto.
Não houver crescimento contínuo de RAM, filas ou conexões.
A gravação, WebRTC, HLS, aplicativo e permissões existentes não sofrerem regressão.

Caso algum objetivo dependa do hardware, documente claramente o hardware utilizado e não invente resultados.

12. Estratégia de implantação

Não substituir todo o pipeline de uma vez.

Implementar por fases:

Benchmark e instrumentação.
Timestamps, frame IDs e contrato de metadata.
Interface de tracker e tracker Norfair/Kalman.
Continuidade de ID e oclusão.
Regiões e objetos estacionários.
Modelos e aceleração por hardware.
WebSocket e novo overlay.
Testes com gravações.
Piloto nas quatro câmeras.
Ativação gradual em produção.

Criar feature flags por câmera:

Pipeline antigo ou novo.
Tracker ByteTrack ou Norfair.
Regiões ativadas.
Estacionários ativados.
Polling ou WebSocket.
Modelo e runtime.
Interpolação visual.
Reidentificação por aparência.

Deve ser possível retornar ao pipeline anterior sem restaurar banco ou reinstalar o sistema.

Entregáveis obrigatórios

Ao concluir, entregue:

Código implementado.
Testes unitários, integração e end-to-end.
Relatório comparativo AjustCam × Frigate.
Tabela de métricas antes e depois.
Configuração recomendada por perfil de hardware.
Migrações e variáveis de ambiente.
Documentação operacional.
Procedimento de ativação e rollback.
Lista de limitações restantes.
Evidências dos testes de sete dias.
Vídeos curtos mostrando box, continuidade de ID, oclusão e objetos estacionários.

Faça commits pequenos por fase. Não altere módulos comerciais sem necessidade. Preserve compatibilidade com câmeras e instalações existentes. Se reutilizar código do Frigate, cumpra a licença MIT, mantenha os avisos e documente claramente a origem.

Não encerre o trabalho apenas com uma proposta. Implemente, valide e somente declare paridade quando os resultados medidos comprovarem.