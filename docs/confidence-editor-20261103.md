# Controle de confiança da IA — 03/11/2026

- Substitui os presets invertidos de pessoas/objetos por uma barra de confiança
  mínima de 55% a 90%, em passos de 1%, nos avisos e na configuração da IA.
- A confiança fica disponível nos avisos da aba Geral, inclusive com gravação
  manual ou contínua. Não depende mais do modo de gravação para editar o campo
  correto. Movimento mantém sua própria sensibilidade, com nome explícito.
- O número representa um limiar de confirmação, não taxa de acerto nem potência.
- O ajuste continua sendo da IA da câmera, compartilhado com gravação por objeto.
  A interface avisa sobre esse efeito quando aplicável; não promete dois limites
  independentes que o motor ainda não possui.
- Mantém o valor já salvo; nenhuma câmera é reconfigurada pela atualização.
- Cadastro RTMP passa a persistir aiConfidence e aiSensitivity recebidos no DTO,
  preservando a invariante de gravação manual/desarmada na criação.
- Inclui o guia SGP de três páginas em /docs/guia-sgp-s2cam-vibe.pdf para download.

Verificações: TypeScript/build, renderização React dos controles, persistência da
confiança no cadastro RTMP com mocks e invariantes de gravação, assinatura e
integridade dos pacotes, prontidão das instalações e download público do PDF.
