/** Shared public contract: exported by the installation and documentation build. */
export const SGP_API_VERSION = '1.3.0';
export function sgpOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const id = { oneOf: [{ type: 'string', minLength: 1, maxLength: 150 }, { type: 'integer' }] };
  const uuid = { type: 'string', format: 'uuid' };
  const states = { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] };
  const operationStates = { type: 'string', enum: ['PENDING', 'COMPLETE', 'IGNORED'] };
  const date = { type: 'string', format: 'date-time' };
  const mode = { type: 'string', enum: ['continuous', 'manual', 'motion', 'object'], description: 'Consulta retorna nomes internos em inglês; envie os nomes portugueses documentados.' };
  const errorDescriptions: Record<number, string> = {
    400: 'Dados inválidos, plano não autorizado ou situação sem mapeamento.',
    401: 'Token inválido, substituído ou integração desativada.', 403: 'Acesso negado.',
    404: 'Cliente/operação não encontrado nesta integração.',
    409: 'Conflito de vínculo, política, data ou identificador de evento.',
    413: 'Corpo da solicitação excede o limite aceito pelo servidor.',
    423: 'Retenção ou detecção requerida não liberada na licença. Corrija o plano ou a licença antes de reenviar.',
    429: 'Limite de solicitações. Aguarde; respeite Retry-After quando presente.',
    503: 'Serviço temporariamente indisponível. Reenvie a mesma solicitação.',
  };
  const errors = Object.fromEntries(Object.entries(errorDescriptions).map(([code, description]) => [code, { description, content: json(ref('Error')) }]));
  const externalId = { name: 'externalId', in: 'path', required: true, description: 'cliente.id do SGP; não é o CPF.', schema: { type: 'string', minLength: 1, maxLength: 150 } };
  const accepted = { description: 'Solicitação persistida. Consulte operation_id até COMPLETE ou IGNORED. PENDING aguarda aplicação. COMPLETE confirma configuração aplicada; não garante sinal de uma câmera offline.', content: json(ref('Accepted')) };
  return {
    openapi: '3.0.3',
    info: { title: 'S2Cam — Integração SGP', version: SGP_API_VERSION, description: 'Contrato único para todos os provedores. Envie eventos à instalação com seu token exclusivo gerenciado pela Central. CPF é login e senha inicial; troca obrigatória no primeiro acesso. CNPJ numérico exige cliente.responsavel.cpf. Reenvios preservam senha. Retenção ausente: 3 dias; gravação ausente: manual. Políticas do serviço alteram somente câmeras exclusivas. Compartilhadas preservam suas configurações. Arquivamento preserva dados sujeitos à retenção normal.' },
    externalDocs: { description: 'Documentação oficial do conector S2Cam', url: 'https://s2cam.com.br/developers/sgp' },
    servers: [{ url: 'https://{installationDomain}/api', description: 'A instalação recebe os eventos; s2cam.com.br hospeda a documentação.', variables: { installationDomain: { default: 'vibe.s2cam.com.br', description: 'Hostname da instalação, sem protocolo ou barras. Exemplo: ibtelecom.s2cam.com.br.' } } }],
    security: [{ SgpKey: [] }],
    paths: {
      '/integrations/v1/sgp/webhook': { post: {
        operationId: 'receiveSgpEvent', summary: 'Cadastrar ou atualizar cliente e serviço',
        description: 'Envie estado completo em todas as ações. Eventos antigos são ignorados; dados diferentes com data idêntica retornam 409. Preserve corpo, data e Idempotency-Key ao reenviar. Mapeie situações e planos antes da homologação. Cotas de serviços não arquivados são somadas; suas políticas de retenção/gravação precisam ser iguais.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 1, maxLength: 150 }, description: 'Recomendado. ID único por evento e integração; conteúdo diferente com mesma chave retorna 409. Sem chave, deduplicação pelo conteúdo normalizado.' }],
        requestBody: { required: true, content: { 'application/json': { schema: ref('Event'), example: {
          acao: 'cadastrar', data: '2026-10-15T10:00:00.123456-03:00', cliente: { id: '123', cpfcnpj: '52998224725', nome: 'Cliente de exemplo' }, contrato: { id: '456' },
          servico: { id: '789', status: 'ATIVO', plano: { id: '10' }, limites: { cameras_privadas: 2, retencao_dias: 3 }, gravacao: { modo: 'objeto', classes_objeto: ['person'] } },
        } } } }, responses: { 200: accepted, ...errors },
      } },
      '/integrations/v1/sgp/customers/{externalId}': {
        get: { operationId: 'getSgpCustomer', summary: 'Consultar vínculo e políticas do cliente', parameters: [externalId], responses: { 200: { description: 'Cliente exclusivo da integração autenticada; não retorna senha nem hash de senha.', content: json(ref('Customer')) }, ...errors } },
        delete: { operationId: 'archiveSgpCustomer', summary: 'Arquivar vínculo', description: 'Bloqueia acesso e pausa câmeras exclusivas. Preserva câmeras e gravações sujeitas à retenção. Compartilhadas continuam atendendo grupos ativos. Novos webhooks são recusados até restauração. Repetição é segura.', parameters: [externalId], responses: { 200: accepted, ...errors } },
      },
      '/integrations/v1/sgp/customers/{externalId}/restore': { post: { operationId: 'restoreSgpCustomer', summary: 'Restaurar vínculo', description: 'Usa últimos estados dos serviços. Serviço suspenso requer novo evento ativo. Não redefine senha.', parameters: [externalId], responses: { 200: accepted, ...errors } } },
      '/integrations/v1/sgp/operations/{id}': { get: { operationId: 'getSgpOperation', summary: 'Consultar aplicação da operação', parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }], responses: { 200: { description: 'Consulte em intervalos de ao menos 2 segundos, aumentando a espera em PENDING. message explica pendência sem credenciais.', content: json(ref('Operation')) }, ...errors } } },
      '/integrations/v1/sgp/capabilities': { get: { security: [], operationId: 'getSgpCapabilities', summary: 'Consultar capacidades do contrato', description: 'Recursos suportados pelo contrato; não indica autorização comercial da instalação.', responses: { 200: { description: 'Versão e recursos públicos.', content: json(ref('Capabilities')) }, ...errors } } },
      '/integrations/v1/sgp/openapi.json': { get: { security: [], operationId: 'getSgpOpenApi', summary: 'Obter este contrato', responses: { 200: { description: 'Especificação OpenAPI 3.0.3.', content: json({ type: 'object' }) } } } },
    },
    components: {
      securitySchemes: { SgpKey: { type: 'http', scheme: 'bearer', description: 'Central → Clientes e servidores → instalação → Integrações → gerar token SGP. Aguarde aplicação. Envie Authorization: Bearer SUA_CHAVE. Nunca envie o token na URL.' } },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, code: { type: 'string', description: 'Código estável quando disponível.' } } },
        Event: { type: 'object', required: ['acao', 'data', 'cliente', 'contrato', 'servico'], properties: {
          acao: { type: 'string', enum: ['cadastrar', 'atualizar', 'alterar_plano', 'alterar_status'] },
          data: { type: 'string', maxLength: 50, description: 'dd/MM/yyyy HH:mm:ss.ffffff no fuso configurado (padrão UTC−3), ou ISO 8601 com fuso; até 6 casas decimais. Preserve data original nos reenvios. Mais de 5 minutos no futuro é rejeitado.' },
          event_id: { type: 'string', minLength: 1, maxLength: 150, description: 'Opcional. Idempotency-Key tem precedência.' },
          cliente: { type: 'object', required: ['id', 'cpfcnpj', 'nome'], properties: {
            id, nome: { type: 'string', minLength: 1, maxLength: 150 },
            cpfcnpj: { type: 'string', maxLength: 18, description: 'CPF válido ou CNPJ numérico válido, com ou sem pontuação. CNPJ exige responsavel.cpf. Login e senha inicial serão o CPF do responsável.' },
            responsavel: { type: 'object', required: ['cpf'], properties: { cpf: { type: 'string', maxLength: 18, description: 'CPF válido obrigatório para CNPJ. Alteração do responsável exige revisão administrativa do vínculo.' } } },
          } },
          contrato: { type: 'object', required: ['id'], properties: { id } },
          servico: { type: 'object', required: ['id', 'status', 'plano'], properties: {
            id, status: { type: 'string', minLength: 1, maxLength: 80, description: 'Situação mapeada no S2Cam; desconhecida retorna 400.' }, plano: { type: 'object', required: ['id'], properties: { id } },
            limites: { type: 'object', properties: { cameras_privadas: { type: 'integer', minimum: 0, maximum: 1000, default: 0 }, retencao_dias: { type: 'integer', minimum: 1, maximum: 3650, default: 3, description: 'Sujeito ao contrato da instalação. Redução pode remover vídeos antigos pela limpeza normal.' } } },
            gravacao: { type: 'object', description: 'Ausente: manual. Não altera política das câmeras compartilhadas.', properties: { modo: { type: 'string', enum: ['continua', 'manual', 'movimento', 'objeto'], default: 'manual' }, classes_objeto: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: ['person'] }, description: 'Aceito somente no modo objeto. Ausente nesse modo usa person.' } } },
          } },
        } },
        Accepted: { type: 'object', required: ['operation_id', 'status', 'customer_status'], properties: { gateway_id: { ...uuid, description: 'ID do vínculo. Presente no webhook.' }, gateway_params_extra: { ...uuid, description: 'ID do grupo. Presente no webhook.' }, operation_id: { ...uuid, nullable: true }, status: operationStates, customer_status: states, repeated: { type: 'boolean' } } },
        Operation: { type: 'object', required: ['operation_id', 'status', 'attempts'], properties: { operation_id: uuid, status: operationStates, attempts: { type: 'integer', minimum: 0 }, message: { type: 'string', nullable: true }, createdAt: date, updatedAt: date } },
        Customer: { type: 'object', properties: {
          id: uuid, externalCustomerId: { type: 'string' }, groupId: uuid, userId: uuid, state: states, archivedAt: { ...date, nullable: true }, revision: { type: 'integer' }, createdAt: date, updatedAt: date,
          group: { type: 'object', properties: { name: { type: 'string' }, maxPrivateCameras: { type: 'integer', minimum: 0 }, retentionDays: { type: 'integer', nullable: true }, _count: { type: 'object', properties: { cameras: { type: 'integer' } } } } },
          user: { type: 'object', properties: { username: { type: 'string', description: 'CPF sem pontuação. Não retorna senha.' }, mustChangePassword: { type: 'boolean' } } },
          services: { type: 'array', items: { type: 'object', properties: { externalServiceId: { type: 'string' }, externalContractId: { type: 'string' }, externalPlanId: { type: 'string' }, privateCameraLimit: { type: 'integer', minimum: 0 }, retentionDays: { type: 'integer', minimum: 1 }, recordingMode: mode, recordingObjectClasses: { type: 'array', items: { type: 'string', enum: ['person'] } }, state: states, sourceAt: date } } },
        } },
        Capabilities: { type: 'object', properties: { version: { type: 'string', example: SGP_API_VERSION }, actions: { type: 'array', items: { type: 'string' } }, limits: { type: 'array', items: { type: 'string' } }, recording: { type: 'array', items: { type: 'string' } }, objectRecordingClasses: { type: 'array', items: { type: 'string', enum: ['person'] } }, initialPasswordChangeRequired: { type: 'boolean', enum: [true] }, customerDocuments: { type: 'array', items: { type: 'string', enum: ['CPF', 'CNPJ_NUMERIC'] } }, sharedCameraPolicy: { type: 'string', enum: ['preserve_camera_settings'] }, tokenManagement: { type: 'string', enum: ['central_when_managed'] } } },
      },
    },
  };
}
