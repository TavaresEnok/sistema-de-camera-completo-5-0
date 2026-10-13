/** Public contract. No installation credentials or personal customer data are embedded. */
export function sgpOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const errorResponses = Object.fromEntries([400, 401, 403, 404, 409, 429, 503].map(code => [code, { description: ({ 400: 'Dados inválidos, plano não autorizado ou situação sem mapeamento.', 401: 'Chave inválida ou integração desativada.', 403: 'Acesso negado.', 404: 'Cliente/operação não encontrado nesta integração.', 409: 'Conflito de vínculo, data ou identificador de evento.', 429: 'Limite de solicitações. Aguarde antes de reenviar.', 503: 'Serviço temporariamente indisponível. Reenvie a mesma solicitação.' } as any)[code], content: json(ref('Error')) }]));
  const externalId = { name: 'externalId', in: 'path', required: true, description: 'cliente.id do SGP, não é o CPF.', schema: { type: 'string', maxLength: 150 } };
  const accepted = { description: 'Solicitação persistida. Consulte operation_id até COMPLETE; PENDING ainda aguarda confirmação dos serviços. IGNORED indica evento antigo.', content: json(ref('Accepted')) };
  return {
    openapi: '3.0.3', info: { title: 'S2Cam — Integração SGP', version: '1.0.0', description: 'API da instalação. O SGP envia eventos do Gateway Genérico. Cada chave acessa somente sua própria integração. Cadastro cria grupo e usuário VIEWER; CPF sem pontuação é login e senha inicial, com troca obrigatória antes de acessar câmeras. Reenvios não redefinem a senha. Uma situação ACTIVE mantém o cliente ativo enquanto houver serviço ativo. Arquivamento preserva câmeras, configurações e gravações, sujeitas à retenção normal.' },
    servers: [{ url: '/api', description: 'Domínio da instalação S2Cam' }], security: [{ SgpKey: [] }],
    paths: {
      '/integrations/v1/sgp/webhook': { post: {
        operationId: 'receiveSgpEvent', summary: 'Receber evento do Gateway Genérico',
        description: 'O mapeamento de situações e a lista de planos são configurados em Integrações. Eventos mais antigos são ignorados. Eventos diferentes com data idêntica são rejeitados. Preserve data e Idempotency-Key ao reenviar. Para arquivar use DELETE customers/{externalId}.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 150 }, description: 'Identificador único do evento. Reutilizar com conteúdo diferente retorna 409. Sem ele, a API deduplica os campos processados do evento.' }],
        requestBody: { required: true, content: { 'application/json': {
          schema: ref('Event'), example: { acao: 'cadastrar', data: '09/10/2026 10:00:00.123456', cliente: { id: 123, cpfcnpj: '52998224725', nome: 'Cliente de exemplo' }, contrato: { id: 456 }, servico: { id: 789, status: 'ATIVO', plano: { id: 10 } } },
        } } }, responses: { '200': accepted, ...errorResponses },
      } },
      '/integrations/v1/sgp/customers/{externalId}': {
        get: { operationId: 'getSgpCustomer', summary: 'Consultar vínculo e serviços do cliente', parameters: [externalId], responses: { '200': { description: 'Vínculo exclusivo desta integração, grupo, usuário e situações dos serviços.', content: json(ref('Customer')) }, ...errorResponses } },
        delete: { operationId: 'archiveSgpCustomer', summary: 'Arquivar grupo e suspender o cliente', description: 'Não apaga câmeras nem gravações. Bloqueia o usuário e pausa serviços de câmeras exclusivas. Câmeras compartilhadas continuam atendendo outros grupos. Novos webhooks são recusados até restauração explícita. Repetir a exclusão é seguro.', parameters: [externalId], responses: { '200': accepted, ...errorResponses } },
      },
      '/integrations/v1/sgp/customers/{externalId}/restore': { post: { operationId: 'restoreSgpCustomer', summary: 'Restaurar vínculo arquivado', description: 'Retoma o estado calculado pelos últimos eventos recebidos. Se o último estado era suspenso, continua suspenso até novo evento ativo.', parameters: [externalId], responses: { '200': accepted, ...errorResponses } } },
      '/integrations/v1/sgp/operations/{id}': { get: { operationId: 'getSgpOperation', summary: 'Consultar confirmação da operação', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Situação atual. Em PENDING, os serviços ainda não confirmaram a aplicação.', content: json(ref('Operation')) }, ...errorResponses } } },
      '/integrations/v1/sgp/capabilities': { get: { security: [], summary: 'Consultar versão e ações suportadas', responses: { '200': { description: 'Capacidades públicas da instalação.' } } } },
    },
    components: {
      securitySchemes: { SgpKey: { type: 'http', scheme: 'bearer', description: 'Chave gerada pelo administrador em Integrações → SGP. Envie Authorization: Bearer SUA_CHAVE.' } },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
        Event: { type: 'object', required: ['acao', 'data', 'cliente', 'contrato', 'servico'], properties: {
          acao: { type: 'string', enum: ['cadastrar', 'atualizar', 'alterar_plano', 'alterar_status'] }, data: { type: 'string', description: 'Data do evento dd/MM/yyyy HH:mm:ss.ffffff no fuso configurado, ou ISO 8601 com fuso. Até 6 casas decimais. Não use a data de entrega ao reenviar um evento antigo.' }, event_id: { type: 'string', maxLength: 150, description: 'Identificador opcional; Idempotency-Key tem precedência.' },
          cliente: { type: 'object', required: ['id', 'cpfcnpj', 'nome'], properties: { id: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, cpfcnpj: { type: 'string', description: 'CPF válido. Para CNPJ, é necessário definir o CPF do responsável antes da homologação.' }, nome: { type: 'string', maxLength: 150 } } },
          contrato: { type: 'object', required: ['id'], properties: { id: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } },
          servico: { type: 'object', required: ['id', 'status', 'plano'], properties: { id: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, status: { type: 'string', description: 'Situação configurada pelo administrador. Situação desconhecida retorna 400.' }, plano: { type: 'object', required: ['id'], properties: { id: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } } } },
        } },
        Accepted: { type: 'object', properties: { gateway_id: { type: 'string', format: 'uuid', description: 'Identificador do vínculo no S2Cam.' }, gateway_params_extra: { type: 'string', format: 'uuid', description: 'Identificador do grupo no S2Cam.' }, operation_id: { type: 'string', format: 'uuid', nullable: true }, status: { type: 'string', enum: ['PENDING', 'COMPLETE', 'IGNORED'] }, customer_status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] }, repeated: { type: 'boolean' } } },
        Operation: { type: 'object', properties: { operation_id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['PENDING', 'COMPLETE', 'IGNORED'] }, attempts: { type: 'integer' }, message: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
        Customer: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, externalCustomerId: { type: 'string' }, groupId: { type: 'string', format: 'uuid' }, userId: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] }, group: { type: 'object', properties: { name: { type: 'string' } } }, user: { type: 'object', properties: { username: { type: 'string' }, mustChangePassword: { type: 'boolean' } } }, services: { type: 'array', items: { type: 'object', properties: { externalServiceId: { type: 'string' }, externalContractId: { type: 'string' }, state: { type: 'string' }, sourceAt: { type: 'string', format: 'date-time' } } } } } },
      },
    },
  };
}
