# Carro/moto e modelo de objetos — Vibe

## Causa comprovada

- GET HTTPS `/api/ai/simulation-capabilities`: HTTP 200,
  `classes=[person,car,motorcycle,bicycle]`, `motionAllowed=true`.
- Perfil carregado no ai-service tinha `detect_vehicles=false`, apesar de
  `active_class_ids=[0,1,2,3,5]` e do modelo COCO conhecer veículos.
- `ObjectDetector._detect_raw` chamava `classe_liberada(cls)` antes de
  registrar a previsão, confiança ou enviar ao tracker. A função bloqueava
  classes de veículos quando o flag legado `GENERAL_DETECT_VEHICLES` era falso.
- Antes da correção: `carro` e `moto` com todos os contadores zerados; pessoa
  tinha 119526 entradas raw, 1418 acima de confiança e 742 saídas do tracker.

Portanto havia um veto anterior ao rastreamento, não apenas uma hipótese de
modelo fraco ou falta de configuração na Central.

## Correção publicada

O processador passa as classes atuais da política recebida da API ao detector
de objetos, antes do filtro legado. Permissões ficam locais a cada chamada,
sem modificar listas globais de um detector compartilhado entre câmeras.
Lista vazia bloqueia todas e evita inferência. Sem política explícita, callers
legados continuam obedecendo os flags anteriores.

Filtros posteriores também removem itens antigos de cache/região e tracking
cuja classe tenha sido revogada. O pós-filtro original do processador continua
ativo. Modo face não recebe restrições de classes de objetos. Não ligados
flags amplos de veículos nem incluído ônibus na política.

Imagem Vibe `drac-pipeline-ai:20261002-object-policy`, override persistente;
recriado somente ai-service. API, web e MediaMTX mantiveram os uptimes.
Imagem anterior `drac-pipeline-ai:20261002-small-motion` preservada para
reversão pelo override e `up -d --no-deps --no-build ai-service`.
Nenhuma mudança em modos das câmeras, política da Central, confiança,
rastreador, resolução, FPS, pesos ou instalações externas/demo.

## Validação

69 testes passaram, incluindo dez regressões novas: classes autorizadas com
flag legado desligado, plano pessoa-only mesmo com flag amplo ligado,
lista vazia/desconhecida, aliases, isolamento entre chamadas, cache, coast
do tracking e ligação da política no processador. Testes de região, movimento
e política também aprovados.

Teste isolado com **os pesos reais instalados**, volume somente leitura,
uma CPU, imagens públicas COCO128 baixadas apenas em memória; sem acesso às
câmeras. Mesmo quadro, mesma confiança e modelo: chamada legada com veículos
desligados versus chamada com as quatro classes da política.

| Imagem pública | Classe anotada | Saída autorizada |
|---|---|---|
| 000000000650.jpg | carro | carro 0,288 / 0,264 |
| 000000000064.jpg | carro | carro 0,596 / 0,287 |
| 000000000359.jpg | carro | carro 0,682 |
| 000000000073.jpg | moto | moto 0,883 / 0,299 |
| 000000000529.jpg | moto | moto 0,940, pessoa 0,780 |
| 000000000086.jpg | moto | moto 0,838, pessoa 0,845 |

Todas as chamadas legadas eliminaram veículos; a política nova preservou
carro e moto. Teste passou. Isto é um smoke test, não uma avaliação de alcance
ou recall das câmeras do cliente. Script: `tools/validate-vehicle-policy.py`.
Fonte pública do dataset e URL do arquivo:
[COCO128 oficial](https://docs.ultralytics.com/datasets/detect/coco128).

Produção, durante simulação do operador na NOBRE FRENTE: inicialmente carro
apareceu e moto entrou no tracker sem sair. Conferência posterior confirmou
as duas classes; não foi necessário mudar limiares ou algoritmo:

| Classe | Acima da confiança | Enviadas ao tracker | Saídas do tracker |
|---|---:|---:|---:|
| pessoa | 271 | 270 | 111 |
| carro | 213 | 198 | 89 |
| moto | 55 | 55 | 22 |
| bicicleta | 18 | 18 | 0 |
| ônibus | 0 | 0 | 0 |

Contadores são previsões/saídas por quadro, não objetos únicos. A presença de
previsões não garante confirmação pelo tracker ou visibilidade no navegador;
saídas comprovam a passagem desse filtro. Não realizado teste visual manual
do browser. O ByteTrack instalado exige confiança de nascimento 0,10 acima
da ativação: veículos entram com 0,25 mas uma nova trilha exige 0,35; o matching
também pode rejeitar entradas. Esse comportamento foi inspecionado, não
alterado com base apenas em contadores intermediários.

## Modelo efetivamente utilizado e escolha

Registry/health confirmou `yolo26n`, OpenVINO CPU, INT8, entrada selecionada
640, arquivo `/app/models/yolo26n_int8_640_openvino_model/yolo26n.xml`.
Metadata do modelo: YOLO26n treinado em COCO, task detect, classes 0 pessoa,
1 bicicleta, 2 carro e 3 moto; export Ultralytics 8.4.54 de 25/05/2026.
Não foi substituído o modelo. Movimento segue MOG2, não YOLO.

Servidor: dez CPUs visíveis, Intel Xeon E5-2640 v2 @ 2 GHz; sem dispositivos
NVIDIA ou render GPU expostos ao container. Por isso o Nano é uma escolha
conservadora de custo. Inferência avançada na câmera, segundo health, tinha
média ~277 ms sob a carga observada; valores de benchmark de outros hardwares
não se aplicam diretamente à VM.

O YOLO26s tem melhor resultado global no COCO publicado (48,6 contra 40,9
mAP; variante end-to-end 47,8 contra 40,1), mas mais operações e custo que o
Nano. Isso não prova superioridade nas cenas locais nem justifica troca sem
medir CPU/recall/FPS na mesma instalação. Comparar N versus S e eventualmente
modelo ajustado às cenas é recomendação, não teste já executado.
[Benchmarks oficiais YOLO26](https://docs.ultralytics.com/models/yolo26).

YOLO27 tem preview com promessas de melhor qualidade/velocidade, mas a página
oficial consultada informa que pesos/código ainda não estão disponíveis e
resultados são preliminares; não é candidato de implantação hoje.
[Status oficial YOLO27](https://docs.ultralytics.com/models/yolo27).

SHA256 em produção igual ao código testado:

- object_detector.py: `bac8abeecf7401b8cfed84e453c085ea3503928b984785963625dfcb365dbd01`
- stream_processor.py: `2475c2184b30fdb011b4d4af140ed03b4080fa2e0ddb9c882626a7675c48ec87`

IA pronta, três processadores de movimento com 7 configurado; NOBRE FRENTE
mantém o ajuste de movimento pequeno anterior. A consulta autenticada de
capacidade usou credencial administrativa de 60 segundos apenas em memória,
sem registrar token/chave e sem criar conta ou senha nova.
