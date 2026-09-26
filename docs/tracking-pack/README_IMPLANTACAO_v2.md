> **REGISTRO HISTÓRICO.** Este documento veio com o pacote de rastreamento.
> Os resultados descrevem a entrega original; os caminhos de repositório foram
> atualizados para `TavaresEnok/sistema-de-camera-completo-5-0`, o destino
> principal desde 26/09/2026.

# AjustCam — Pacote de Tracking (bottom-center, oclusão, estacionário, PTZ, rider)

Código do pacote, mantido no clone de `TavaresEnok/sistema-de-camera-completo-5-0`
e testado sinteticamente (resultados no fim). Dois jeitos de aplicar:

**Opção A — patch (recomendado se seu working tree está limpo):**
```bash
cd sistema-de-camera-completo-5-0
git apply --check PATCHES.diff   # simula; se não reclamar:
git apply PATCHES.diff
```

**Opção B — copiar arquivos:** tudo em `arquivos/` está no caminho exato do
repo. Novos podem ser copiados direto; os 5 alterados
(`object_detector.py`, `runtime_profiles.py`, `stream_processor.py`,
`LiveStreamPlayer.tsx`, `live-detections-poller.ts`) substituem os seus —
**atenção:** você adicionou hoje uma transição CSS local no
`LiveStreamPlayer.tsx` que não está no GitHub. Com o hook novo ela fica
desnecessária (a interpolação é feita em JS, por identidade de rastro); se
quiser preservar outros ajustes locais, aplique o diff manualmente nesse
arquivo em vez de sobrescrever.

## O que cada peça resolve

| Arquivo | O que faz |
|---|---|
| `trackers/__init__.py` | Registro de trackers. `GENERAL_TRACKER` **agora é validado** — valor inválido derruba o serviço com erro claro em vez de ser ignorado (item 2 do seu plano). |
| `trackers/base.py` | Contrato `TrackerBackend`/`TrackedBox` (numpy puro, 1 backend por câmera+classe). |
| `trackers/bytetrack_backend.py` | Adapter do sv.ByteTrack **idêntico** ao hardcoded (teste de caracterização prova bit a bit). |
| `trackers/ajustcam_tracker.py` | Tracker próprio: associação pelo **pé da caixa** normalizada por tamanho (item 3), Kalman de velocidade constante com amortecimento em misses, 2 estágios de confiança (fracas sustentam, não criam), **oclusão com recuperação do mesmo ID** (`recovered=True`), **objeto estacionário** estilo Frigate (histórico+mediana+IoU, com 3× de tolerância a misses), gate adaptativo e hook de compensação de câmera. |
| `trackers/camera_motion.py` | Movimento **global** da câmera (LK esparso em 320px, mediana) para PTZ/vibração — ~1–2 ms/frame. |
| `trackers/rider_association.py` | Item 4: pessoa fraca montada em moto/bicicleta forte é **promovida** com geometria plausível + confirmação em N frames. Dá função ao `riderVehicleProxy`. Heurística própria (o Frigate não tem isso nativo), por isso OFF por padrão e com contadores de auditoria. |
| `detectors/object_detector.py` | Usa o registro; valida tracker no init; retém pessoa fraca só p/ o rider; **funil por classe** `raw → conf_pass → to_tracker → from_tracker` no `/status` (responde na hora o caso "4 perto × 145 longe"); passa `frame` p/ compensação; `stationary`/`recovered` no extra. |
| `runtime_profiles.py` | Novas chaves/envs (tabela abaixo). |
| `stream_processor.py` | `stationary`/`recovered` chegam ao payload do overlay. |
| `apps/web/src/lib/use-smooth-tracks.ts` | Item 1: identidade **por `trackId`** (`track-${id}`, nunca `\|\|` — trackId 0 é válido) + **interpolação** entre amostras em rAF, TTL de 900 ms segurando a caixa em amostra perdida. Fim do remount/pisca. |
| `LiveStreamPlayer.tsx` | Usa o hook; `key={detection.renderKey}` no retângulo **e** no triângulo; caixa estacionária vira tracejada. |
| `live-detections-poller.ts` | Falha de rede segura o último payload bom por até 2 ciclos/1,6 s antes de limpar — a grade não pisca em soluço de rede. |
| `tools/test_tracker_synthetic.py` | 7 cenários (aproximação, oscilação, oclusão, cruzamento, estacionário, pan, rider). |
| `tools/test_bytetrack_characterization.py` | Prova adapter ≡ hardcoded. |
| `tools/track_ab_bench.py` | A/B bytetrack × ajustcam; aceita `--jsonl` com frames reais das suas câmeras. |

## Novas variáveis de ambiente (todas com default seguro)

| Env | Default | Efeito |
|---|---|---|
| `GENERAL_TRACKER` | `bytetrack` | `bytetrack` = comportamento atual; `ajustcam` = tracker novo. Inválido = erro na subida. |
| `GENERAL_TRACKER_LOW_CONF_FLOOR` | `0.10` | Piso do 2º estágio (fracas sustentam trilhas). |
| `GENERAL_TRACKER_RECOVERY_GRACE_MS` | `2000` | Janela p/ recuperar o MESMO ID após perda. |
| `GENERAL_STATIONARY_FRAMES` | `10` | Histórico p/ classificar estacionário. |
| `GENERAL_STATIONARY_IOU` | `0.88` | IoU c/ a mediana p/ ENTRAR em estacionário. |
| `GENERAL_STATIONARY_OUT_IOU` | `0.70` | IoU p/ SAIR (3 frames abaixo). |
| `GENERAL_CAMERA_MOTION_COMP` | `false` | Compensação global (ligar só em PTZ/câmera que treme; só age com tracker=ajustcam). |
| `GENERAL_RIDER_ASSOCIATION` | `false` | Liga a promoção de piloto. |
| `GENERAL_RIDER_PERSON_FLOOR` | `0.12` | Piso da pessoa fraca candidata. |
| `GENERAL_RIDER_VEHICLE_MIN` | `0.45` | Confiança mínima do veículo âncora. |
| `GENERAL_RIDER_CONFIRM_FRAMES` | `2` | Frames consecutivos p/ confirmar. |
| `GENERAL_PIPELINE_DEBUG` | `false` | (reservado p/ log por frame; contadores do funil ficam SEMPRE no /status). |

## Ordem de rollout (menor risco primeiro)

1. **Só o frontend** (hook + player + poller). Zero mudança de backend; o pisca
   morre e a caixa desliza. Rollback = reverter 3 arquivos.
2. **Backend com `GENERAL_TRACKER=bytetrack`** (default). Comportamento de
   produção idêntico (caracterização garante); você ganha o funil no
   `/status` → confirme nos números onde a pessoa perto se perde:
   `raw` baixo = modelo/pré-processamento (teste `GENERAL_IMGSZ=960` e
   `GENERAL_MIN_OBJECT_HEIGHT_PX` menor); `raw` alto e `conf_pass` baixo =
   threshold; `to_tracker` alto e `from_tracker` baixo = tracker.
3. **1 câmera piloto com `GENERAL_TRACKER=ajustcam`** por alguns dias,
   acompanhando trocas de ID e o `recovered` no /status.
4. Opcional: `GENERAL_RIDER_ASSOCIATION=true` (acompanhe `promotions` ×
   `geometry_rejects`) e, só em PTZ, `GENERAL_CAMERA_MOTION_COMP=true`.

Rollback total do tracking: `GENERAL_TRACKER=bytetrack` (sem redeploy de código).

## Resultados dos testes (rodados neste pacote)

- `test_tracker_synthetic.py`: **7/7 cenários passando**.
- `test_bytetrack_characterization.py`: adapter ≡ hardcoded em 22 frames/19 caixas.
- `track_ab_bench.py`: aproximação e cruzamento empatados (1 ID, 0 trocas nos
  dois); **oclusão de 7 frames: bytetrack = 2 IDs/1 troca, ajustcam = 1 ID/0
  trocas**. Rode com `--jsonl` nos seus vídeos para o veredito real.
- Achado relevante: supervision **0.28+ depreciou `sv.ByteTrack` (remoção na
  0.31)**. Seu pin em 0.27.0 protege hoje, mas a abstração + backend próprio
  deixa de ser opcional a médio prazo.

## Limites honestos

- Tudo acima foi validado com **cenários sintéticos** e caracterização — não
  com o modelo YOLO e as câmeras reais (não há como rodar OpenVINO aqui). O
  “superar o Frigate” se decide no `--jsonl` com seus vídeos.
- O TypeScript **não foi compilado** neste ambiente — rode `npm run build` do
  web antes de subir; o hook re-renderiza o player a 60 fps enquanto há caixa
  na tela (leve; se quiser espremer, o passo seguinte é isolar o overlay num
  componente filho memoizado).
- `scipy` é opcional (associação usa Hungarian se existir; senão greedy —
  suficiente para o volume típico de CFTV).

---

# V2 — Re-ID por aparência, zoom PTZ, coasting, overlay isolado

O pacote é CUMULATIVO (v1 + v2): o `PATCHES.diff` e os `arquivos/` desta versão
substituem os da anterior por completo.

## Novidades

| Peça | O que faz |
|---|---|
| `trackers/appearance.py` (novo) | Assinatura de aparência (histograma HSV 16×8 do **torso**, ~0,1 ms). **Confirma** recuperação de ID pós-oclusão e alimenta a **correção de troca** em cruzamentos. Nunca associa sozinha. |
| `ajustcam_tracker.py` (evoluído) | Aparência integrada com três salvaguardas aprendidas nos testes: (1) assinatura **suprimida quando detecções se sobrepõem** (caixa contaminada pela cor do outro não envenena a média); (2) **veto** de aparência só na RECUPERAÇÃO (no fluxo ativo veto fragmentava — medido); (3) **correção de troca** pós-associação com reset de velocidade (a geometria cruza os pares no encontro; a aparência desfaz na separação). Distância agora é `min(predição, última posição vista)` — quem dá meia-volta (ricochete) não perde o ID por inércia do Kalman. `apply_global_shift` ganhou **escala** (zoom). `min_hits` (paridade `min_initialized` do Frigate) e **coasting**: estacionária segue emitindo a última caixa durante falhas do detector. |
| `camera_motion.py` (evoluído) | Estima **zoom + pan** via `goodFeaturesToTrack` + LK + `estimateAffinePartial2D` (RANSAC), com rejeição de fit degenerado por fração de inliers (25%, piso 12). Cena sem textura → fallback seguro p/ translação mediana. |
| `SmoothDetectionOverlay.tsx` (novo) | O rAF de 60 fps agora re-renderiza SÓ o overlay; o `LiveStreamPlayer` volta ao ritmo do poller (2×/s). Mesma matemática de posicionamento, movida sem alteração. |
| `record_detections_jsonl.py` (novo) | Grava as detecções do SEU modelo num vídeo seu → alimenta `track_ab_bench.py --jsonl`. **Roda no seu ambiente** (requer OpenVINO/modelos; não executada aqui). |

## Novas envs (defaults seguros)

| Env | Default | Efeito |
|---|---|---|
| `GENERAL_TRACKER_APPEARANCE` | `true` | Aparência no tracker ajustcam (inerte no bytetrack e sem frame). |
| `GENERAL_TRACKER_APPEARANCE_VETO` | `0.10` | Similaridade mínima p/ aceitar RECUPERAÇÃO de ID. |
| `GENERAL_TRACKER_MIN_HITS` | `1` | >1 segura a 1ª emissão de trilha nova (mata blip de 1 frame). |
| `GENERAL_STATIONARY_COAST` | `true` | Estacionária continua na tela em miss do detector (budget 3×). |

## Resultados v2 (rodados aqui)

- Suíte v2: **6/6** — ricochete com pés na MESMA altura sem fragmentação e com
  identidades corretas ao separar; recuperação pós-oclusão aceita VERDE
  (mesmo ID, `recovered=true`) e rejeita VERMELHO (ID novo — re-ID errado é
  pior que ID novo); coasting emite a parada durante 4 misses e NÃO emite
  móvel; zoom de 25% + pan compensado mantém o ID; estimador mede zoom real
  1,15 → 1,149 e pan (12,−8) → (11,7,−7,5); `min_hits=2` segura blip.
- Suíte v1 (7/7), caracterização (adapter ≡ hardcoded) e A/B (oclusão:
  bytetrack 2 IDs/1 troca × ajustcam 1 ID/0 trocas) **revalidados** após tudo.
- Nota honesta: com a distância robusta a inversão, a geometria PURA também
  passou a segurar o ricochete simétrico do teste — a aparência fica como
  rede de segurança p/ encontros assimétricos e como **porteira da
  recuperação** (o teste 9 é ela sozinha decidindo certo).

## Sobre detecção de movimento

Auditei o `detectors/motion.py` antes de mexer: ele JÁ implementa o essencial
do Frigate (recalibração com `sceneChange` reportado, stretch de contraste por
percentis 4–96, congelamento de aprendizado com movimento recente, componentes
conectados proporcionais, sombras, zonas, via rápida p/ objeto grande) — com
calibração de campo própria. Reescrever seria regressão; nada foi alterado aí.
