# Edição unificada de câmeras

Data: 27/09/2026.

## Decisão

A edição lateral passa a ser a única edição da câmera. A página `CameraDetailPage.tsx` foi removida após a migração das funções e a validação automatizada. O histórico Git permite recuperá-la, se necessário.

## Organização

- **Geral:** identificação, endereço, localização e habilitação da câmera.
- **Conexão:** acesso ao equipamento e publicação de vídeo, preservando geração de chave e vinculação existentes.
- **Vídeo:** imagem de conferência, teste da configuração salva, detecção de ajustes, verificação do vídeo, perfil de qualidade e áudio. Compatibilidade fica recolhida.
- **Gravação:** habilitação, modo, classes de objetos, prazo de armazenamento, política do grupo e alertas.
- **Ajustes do equipamento:** canais, perfis, ONVIF, limites de transmissão e resolução da gravação, recolhidos para evitar confusão no uso diário.
- **Funções operacionais:** câmera individual com vídeo original, áudio e ampliação no painel da lista; reprodução, desenho de perímetro, PTZ e ocorrências nas respectivas telas. A saída de alarme exige confirmação antes do acionamento.

Os ajustes continuam sujeitos à permissão de administrador já exigida pela API. “Instalador” é uma orientação de uso, não um novo papel nem uma concessão de acesso à Central. Relatórios brutos de infraestrutura e URLs internas não são apresentados pelos novos controles de verificação.

## Compatibilidade e proteção

Links `/cameras/:id` continuam funcionando por redirecionamento. `settings` abre a edição para administradores; operadores vão para a visualização. `ptz`, `playback`, `zones` e `events` levam às telas correspondentes, preservando a câmera selecionada. Ocorrências usam `/alarms`, o destino operacional atual.

O formulário não é reiniciado pela atualização periódica da lista. Fechar ou usar um de seus atalhos com alterações pendentes exige confirmação; recarregar a página também gera aviso. A gravação envia apenas campos alterados, preservando configurações não editadas. Isso reduz sobrescritas, mas não constitui bloqueio concorrente do mesmo campo.

Câmeras que publicam vídeo não recebem campos de conexão ativa ao salvar. A senha existente não é reenviada só por ter sido visualizada. A detecção pode reutilizar a credencial pela rota auditada, sem exibi-la; ajustes encontrados só entram no formulário mediante ação explícita e ainda precisam ser salvos.

A imagem usa os dados do formulário. Teste de conexão e verificação usam o cadastro salvo. Ações de publicação são imediatas e não são desfeitas ao cancelar a edição. Respostas antigas de conferência são descartadas quando a câmera ou os dados mudam.

## Validação e limites

- Suíte web executada em contêiner isolado: 531 testes passaram.
- Checagem TypeScript e build de produção executados em contêiner de validação.
- Cobertura atualizada para a remoção da página, redirecionamentos, perfis personalizados, modo publicação, validações, navegação e proteção de rascunhos.
- Nenhuma câmera real, saída de alarme ou configuração de produção foi acionada por esta validação. Não houve reinício de serviços, deploy ou geração de aplicativo.
- Ainda é necessário o aceite visual em navegador conectado ao ambiente, incluindo celular, equipamentos reais e alternância de permissões. Build e testes não substituem essa conferência.
