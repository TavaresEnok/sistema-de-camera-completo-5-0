# Auditoria exclusiva da página de Perímetro — 26/09/2026

Implementação posterior: [correções da página de Perímetro](correcoes-perimetro-2026-09-26.md).

## Escopo e conclusão

Análise do código atual do workspace: página, editor, simulação, permissões, persistência, recarga da análise, geometria Python, agrupamento de eventos e abertura de alarmes. Inclui as alterações locais ainda não publicadas. Nenhuma configuração de câmera ou servidor foi alterada nesta auditoria.

A página tem uma boa base de edição, mas ainda não oferece uma confirmação confiável de proteção ponta a ponta. Os maiores problemas são a diferença entre simulação e execução, a supressão de travessias independentes e a falta de confirmação de que o desenho salvo está aplicado no detector.

A avaliação visual é heurística, baseada no JSX/CSS e nos fluxos implementados. Não houve inspeção visual em navegador autenticado, medição de contraste renderizado ou teste com operadores. Não se atribui nota numérica de UX nem se declara conformidade de acessibilidade.

Prioridades: P1 = risco operacional alto; P2 = inconsistência funcional/usabilidade relevante; P3 = evolução. Nenhum P0 foi demonstrado nesta análise. Prioridade deste relatório não se confunde com a prioridade dos alarmes no produto.

## O que já está bem resolvido

- Desenho sobre imagem da própria câmera com coordenadas normalizadas e proporção do snapshot.
- Tipos de regra distintos, seta de direção e edição de vértices.
- Zoom e deslocamento, recuperação de rascunho, desfazer e aviso de alterações não salvas.
- Câmeras com busca, grupos, paginação e acesso rápido à seleção.
- Estado considera captura recente e inferência para linhas, indo além de um simples processo ligado.
- Detector de travessia usa identidade rastreada, base da caixa e segmento finito; limita e expira rastros.
- Interface informa que a simulação não produz gravação/sirene/notificação.

## Achados

### PER-01 · P1 · Simulação e detector discordam sobre áreas ignoradas

**Evidência:** `apps/web/src/lib/perimeter-test.ts`, funções `testTrajectory` e `describePerimeterPosition`, descartam objetos dentro de `exclude` e fora de `include`. `services/ai-service-python/detectors/tripwire.py`, `linhas_de`, extrai somente linhas. Em `stream_processor.py:1137`, o tripwire recebe as detecções de objetos sem aplicar essas máscaras. As máscaras de área são aplicadas no detector de movimento.

**Reprodução:** linha horizontal no meio da imagem e uma área `exclude` cobrindo todo o quadro. Objeto rastreado vai de y=0,3 para y=0,7. O Python devolve travessia proibida; o teste web retorna nenhuma travessia. Reproduzido isoladamente.

**Impacto:** o operador pode confiar em “objeto ignorado” no teste e receber um alarme real naquela região. “Apenas o interior será analisado” promete mais do que o caminho de objetos executa.

**Recomendação:** definir um contrato único de precedência e escopo das áreas. Se forem exclusivas de movimento, declarar isso e não simular supressão de objetos/linhas. Se forem globais, aplicá-las também ao tripwire/objetos. Compartilhar vetores de teste entre web e Python.

### PER-02 · P1 · Travessias independentes podem desaparecer antes de chegar à API

**Evidência:** `stream_processor.py:1211` chama `_agrupador.decidir(event_type, current_time)` para cada detecção. `detectors/agrupamento_de_evento.py` indexa estado somente por tipo, dentro do processador da câmera. `linhaId`, `trackId` e direção não fazem parte da chave.

**Reprodução:** duas chamadas `decidir('LINE_CROSSED', 1000)` retornam, respectivamente, emitir e não emitir. Duas linhas ou duas pessoas no mesmo quadro disputam o mesmo evento. Reproduzido isoladamente; o encadeamento está confirmado no código.

**Impacto:** perda de ocorrências distintas e de identificação da linha/objeto. Não é apenas redução de notificações: o evento pode nem chegar ao histórico. A deduplicação posterior dos alarmes também agrupa por câmera/tipo e substitui metadata.

**Recomendação:** preservar cada travessia válida no histórico, deduplicar ruído por câmera + linha + trilha + direção e controlar frequência de notificação separadamente. Se houver um incidente agregado, manter as ocorrências vinculadas.

### PER-03 · P1 · Salvar não confirma aplicação no detector

**Evidência:** `DetectionZonesEditor.tsx:359` salva por PATCH e considera sucesso HTTP como conclusão. `cameras.controller.ts:1000` inicia stop/start em tarefa assíncrona, com falhas capturadas sem retorno de aplicação à UI. Não há revisão desejada/aplicada comparada na página.

**Impacto:** desenho novo pode aparecer salvo enquanto a análise está parada ou ainda sem confirmação de uso daquela configuração. Salvamentos simultâneos não têm controle de revisão e podem sobrescrever alterações de outro operador.

**Recomendação:** revisão de configuração, estados “salvo”, “aplicando”, “aplicado” e “falhou”, confirmação pelo processador e serialização por câmera. PATCH condicional para detectar edição concorrente.

### PER-04 · P1 · “Monitorando” não comprova que haverá alarme

**Evidência:** `perimeter-state.ts:9` verifica processo/captura/inferência. Não verifica revisão aplicada, regras de alarme, silenciamento, classes efetivas ou entrega de notificação. `alarms.service.ts:210` em diante pode rejeitar abertura por alarmes desligados, regra inexistente/desligada ou mute. A página exibe apenas o booleano “Alertas ligados/desligados”.

**Impacto:** uma câmera pode estar analisando normalmente e não avisar ninguém. A palavra “Monitorando” precisa ser delimitada para não significar proteção completa. Até “Verificando análise” recebe estilo verde quando `attention=false`.

**Recomendação:** apresentar separadamente “Análise ativa”, “Regras aplicadas” e “Ações habilitadas”. Durante verificação usar estado neutro. Mostrar motivo e ação de recuperação quando a proteção não estiver pronta.

### PER-05 · P1 · Polígonos inválidos podem ser salvos como áreas válidas

**Evidência:** `cameras/helpers/validar-zonas.helper.ts` verifica quantidade de pontos, faixa e linha coincidente; não verifica área mínima, vértices distintos ou auto-interseção. O editor exige somente três pontos para polígonos.

**Impacto:** três pontos colineares passam pela validação, embora não definam uma área útil. Um `include` degenerado pode reduzir a região analisada a pixels residuais. Polígonos cruzados podem ter preenchimento diferente do esperado. O impacto exato da rasterização não foi medido nesta rodada.

**Recomendação:** rejeitar área quase nula, pontos repetidos e auto-interseções; alertar quando a combinação de máscaras deixa cobertura vazia ou desprezível. Mostrar a cobertura efetiva antes de salvar.

### PER-06 · P2 · Encostar na linha e voltar pode gerar travessias

**Evidência:** `_segmentos_cruzam` aceita mudança entre sinal negativo e zero; o estado guarda a posição seguinte sobre a linha. Não há faixa de tolerância espacial nem confirmação do outro lado.

**Reprodução:** sequência y=0,3 → 0,5 → 0,3 em linha y=0,5 produz duas travessias no detector, embora não haja passagem completa para o lado oposto. Reproduzido isoladamente. A emissão final ainda depende de agrupamento e regras de alarme.

**Recomendação:** guardar último lado confirmado, usar tolerância em torno da linha e só confirmar passagem ao lado oposto. Cobrir tremor de caixa, parada sobre a linha, oclusão e retorno.

### PER-07 · P2 · Teste visual não é diagnóstico ponta a ponta

**Evidência:** `DetectionZonesEditor.tsx:139` calcula mensagens a partir de overlays consultados pelo poller; não acompanha o evento confirmado, alarme aberto ou entrega de push. O histórico local expira em 2 s, enquanto o Python usa 5 s. Entrar em `include` recebe texto de “travessia”, embora a área funcione como máscara de movimento, não como regra equivalente de intrusão por entrada.

**Impacto:** “travessia observada” pode ser interpretada como alarme validado. Polling pode perder posições intermediárias; múltiplos objetos sobrescrevem a mensagem. O modo de teste mantém o processamento real: a garantia de ausência de ações se aplica à simulação pelo ponteiro, não necessariamente a pessoas passando fisicamente.

**Recomendação:** separar “Simular desenho” e “Validar com passagem real”. No segundo, exibir trilha de resultados: objeto detectado → regra reconhecida → evento persistido → alarme → notificação, conforme ações configuradas. Declarar se ações reais permanecem habilitadas e criar diário de teste por regra.

### PER-08 · P2 · Permissões de edição divergem entre tela e API

**Evidência:** a página libera edição para qualquer papel diferente de `viewer`; o PATCH exige ADMIN, `cameraConfig` e acesso administrativo à câmera. O endpoint de health exige OPERATOR e a página não o consulta para viewer.

**Impacto:** operador pode desenhar e só descobrir no salvamento que não tem permissão; viewer pode permanecer em “Verificando análise” indefinidamente. Não foi identificado bypass da autorização da API.

**Recomendação:** UI baseada em capacidades efetivas por câmera. Modo de consulta explícito e estado de análise consultável por quem pode visualizar, com resposta filtrada.

### PER-09 · P2 · Sensibilidade em área ignorada sugere um efeito que não existe

**Evidência:** editor oferece sensibilidade tanto para `include` quanto `exclude`. `motion.py:430` aplica máscara binária antes dos componentes e da avaliação de sensibilidade; a região excluída já foi removida.

**Impacto:** “ignorar + sensibilidade baixa” não significa ignorar folhas mantendo pessoas naquela região no detector de movimento. O ajuste vira controle sem efeito útil sobre os pixels excluídos.

**Recomendação:** ocultar sensibilidade em exclusões. Caso se queira “reduzir ruído sem excluir”, definir regra própria e explicar a diferença entre detecção de movimento e objetos.

### PER-10 · P2 · Proteção de rascunho não cobre toda mudança de contexto

**Evidência:** guard local intercepta cliques em links e seleções explícitas. O efeito de seleção automática em `PerimetroPage.tsx:141` troca/limpa câmera sem passar pelo guard quando ela sai da lista. Navegação pelo histórico do navegador não usa esse interceptador de links. Em desenho incompleto, “Salvar e continuar” encontra botão desabilitado e fecha o diálogo sem executar a ação.

**Impacto:** interrupção inesperada de edição e fluxo ambíguo. O rascunho em sessionStorage reduz perda, mas não substitui bloqueio consistente de transição.

**Recomendação:** um único bloqueio de navegação/transição; concluir ou cancelar desenho antes de oferecer salvar e continuar. Ao câmera ficar indisponível, preservar editor e explicar o motivo.

### PER-11 · P2 · A seleção esconde câmeras e mistura conceitos

**Evidência:** a lista inclui apenas câmeras habilitadas com IA ou gravação por movimento/objeto. Câmera contínua com IA desligada não aparece para iniciar configuração. O vazio se intitula “Nenhuma câmera ativa”, embora possam existir câmeras ativas sem análise. O seletor superior e a busca lateral seguem conjuntos diferentes; busca lateral só considera nome.

**Recomendação:** listar câmeras acessíveis, marcando “precisa ativar análise” quando aplicável. Ação guiada de habilitação conforme permissão/licença. Alinhar seletores, busca por nome/código/grupo e manter seleção visível.

### PER-12 · P2 · Densidade e acessibilidade do editor dificultam uso preciso

**Evidência:** fontes recorrentes de 10–12 px; círculos de arraste com raio de 1,1 unidades em viewBox 100; edição geométrica depende de ponteiro; seleção na frota não usa `aria-current`/`aria-pressed`; tela ampliada é um div fixo sem gerenciamento explícito de foco/Escape. O grupo não tem label acessível explícito no trigger.

**Impacto provável:** alvos pequenos, maior erro em tablet e dificuldade de operação por teclado. Em largura de 320 px, um vértice tem aproximadamente 7 px de largura visual. Necessário validar layout renderizado para dimensionar o problema.

**Recomendação:** ampliar área de interação sem engrossar o desenho, seleção com indicação semântica, edição por teclado e painel de propriedades. Tela ampliada com foco/restauração/Escape. Testar teclado, tablet, claro/escuro e zoom do navegador.

### PER-13 · P2 · Tela não fecha o ciclo “o quê, quando e o que fazer”

**Evidência:** regra salva contém nome, tipo, pontos, sentido e sensibilidade; a página não apresenta resumo de classes efetivas, agenda, resposta por regra ou última ocorrência. “Detecção e ações” abre a ficha ampla da câmera.

**Impacto:** desenhar fica fácil, mas compreender a proteção inteira exige navegar e conhecer configurações distribuídas. Uma linha no portão e outra no muro não têm, nesta página, ações próprias explícitas.

**Recomendação:** painel simples da regra: o que detectar, onde, quando e ações efetivas. Recursos não suportados devem aparecer como limitação real, não como opção fictícia. Ações avançadas sob expansão; padrões explicados em linguagem comum.

### PER-14 · P2 · Sobreposição e cobertura final não são explicadas visualmente

**Evidência:** polígonos coloridos são desenhados individualmente; o aviso de include diz que só seu interior será analisado. Não há composição visual explícita da união das inclusões menos exclusões nem alerta de regra anulada por outra.

**Recomendação:** sombrear o que ficará fora da detecção de movimento, indicar prioridade das exclusões e alertar sobre cobertura vazia. Vincular cada desenho a seu nome na imagem e à linha correspondente no painel, principalmente quando há sobreposição.

### PER-15 · P2 · Testes existentes passam sem provar a experiência completa

**Evidência:** 16 testes web de perímetro executados e aprovados; 20 testes Python de tripwire executados e aprovados. Parte dos testes web inspeciona strings do código. Os três cenários de regressão novos descritos em PER-01/02/06 continuam reproduzíveis.

**Recomendação:** testes de contrato web/Python com os mesmos trajetos e testes de interação reais para desenhar/salvar/aplicar/testar, permissões, concorrência, rascunho, falha do detector e câmeras com proporções diferentes. Aprovação das suítes existentes não basta para validar proteção.

## Experiência proposta, mantendo simplicidade

O fluxo principal deve ser: **escolher câmera → criar regra → conferir a resposta → salvar e aplicar → validar**.

1. Cabeçalho: nome da câmera, estado real da proteção e motivo de qualquer pendência. Contagem de regras é secundária.
2. Imagem como área principal, com três ações claras: “Detectar travessia”, “Limitar movimento à área” e “Ignorar movimento nesta área”, enquanto esse for o contrato real.
3. Ao selecionar uma regra, mostrar suas propriedades e ações efetivas. Direção por seta e opção “Inverter sentido”, preservando A/B como apoio técnico.
4. Resumo antes de aplicar: exemplo “Pessoas e veículos · travessia nesta direção · alarmes habilitados”. Somente afirmar ações verificadas.
5. Após salvar, mostrar progresso da aplicação e revisão confirmada pelo detector. Oferecer validação real e acesso à ocorrência registrada.
6. Na frota, ordenar problemas operacionais antes de câmeras configuradas e usar estados separados: sem regra, incompleta, aplicando, ativa, silenciada e falha.

Recursos avançados úteis após resolver a base: resposta e agenda por regra, permanência em área como regra distinta, histórico de versões, calibração de tamanho mínimo/perspectiva e aviso de mudança de enquadramento após PTZ. São propostas de evolução, não recursos existentes confirmados.

## Ordem recomendada e critérios de aceite

1. **Confiabilidade:** unificar simulação/detector, preservar travessias independentes, validar geometria e confirmar configuração aplicada.
2. **Compreensão:** separar análise de alarme, corrigir permissões, rótulos e controles sem efeito; explicar cobertura e classes.
3. **Operação:** revisão do teste real, navegação com rascunho, teclado/tablet e hierarquia visual.
4. **Evolução:** ações por regra, agenda e diagnóstico avançado conforme demanda.

Aceite mínimo: mesma trajetória produz mesma decisão na simulação e no detector; duas travessias independentes preservam duas ocorrências; tocar/recuar não confirma passagem completa; “aplicado” corresponde à revisão do processo; máscara inválida é recusada; operador entende se vai somente registrar, alarmar ou notificar; edição não permitida fica clara antes do desenho.

## Verificação realizada

- Leitura cruzada da página/editor e caminhos correspondentes da API/IA.
- 16/16 testes web específicos aprovados, executados em container efêmero sem rede.
- 20/20 testes Python de tripwire aprovados.
- Reproduções puras de divergência de máscara, toque/recuo e agrupamento por tipo, sem acessar câmeras ou gerar alarmes reais.
- Não foram medidos FPS, latência de alerta, precisão do modelo, contraste ou facilidade de uso com pessoas. Não houve implantação ou correção de código nesta etapa.
