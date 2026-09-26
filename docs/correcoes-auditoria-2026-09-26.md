# Correções da auditoria — 26/09/2026

Referência: [auditoria técnica](auditoria-tecnica-2026-09-26.md). Estado do workspace após a implementação; nenhuma implantação remota foi executada nesta etapa.

## Resultado por achado

| ID | Estado | Correção aplicada |
|---|---|---|
| AUD-001 | Corrigido | Instalação remota faz parse fora do lock e mutação serializada sobre snapshot fresco; host key segue a mesma regra |
| AUD-002 | Corrigido | Checkpoint depois do quiesce; banco só é restaurado se migration pode tê-lo alterado |
| AUD-003 | Corrigido | Push delega decisão à ACL real, exige usuário ativo e respeita câmera privada/grupo suspenso |
| AUD-004 | Corrigido no modo operacional | PostgreSQL virou default; dual exige opt-in transitório explícito; reconciliação inicial permanece |
| AUD-005 | Corrigido | Corpo é lido com limite/timeout fora da fila; fila tem teto; teste slow-body comprova isolamento |
| AUD-006 | Corrigido | Restore respeita profiles/overlays/bind, não força Central, usa retries e captura readiness com `||` |
| AUD-007 | Corrigido | Geração de sessão e intenção durável de logout impedem resposta pendente de reautenticar; logout propaga entre abas |
| AUD-008 | Corrigido | Consumo condicional e transacional do token, com revogação de sessões; concorrência tem um vencedor |
| AUD-009 | Corrigido | Purge global é bloqueado quando há legal hold/evidência; remoção de câmera já usava exclusão protegida |
| AUD-010 | Corrigido | Single-flight na aba e Web Lock entre abas serializam a rotação do cookie |
| AUD-011 | Corrigido | Host definitivo de virtual-host style é definido antes da assinatura SigV4 |
| AUD-012 | Corrigido | Flag do offload é reservada antes do primeiro `await` e liberada em `finally` |
| AUD-013 | Corrigido | Valor vazio de `COOKIE_SECURE` volta ao default seguro de produção |
| AUD-014 | Corrigido/mitigado | JSON recupera lock órfão comprovável no mesmo host; Management usa PostgreSQL/advisory lock por padrão |
| AUD-015 | Corrigido | `/api/ready` verifica datastore e fila; healthcheck de Management usa readiness |
| AUD-016 | Corrigido arquiteturalmente | Central mantém snapshot em memória sob singleton e persiste somente diffs; upserts idênticos não geram update |
| AUD-017 | Corrigido | Stop/reset/load bloqueantes da IA rodam em threads; stop-all usa concorrência controlada pelo executor |
| AUD-018 | Corrigido | API habilita shutdown hooks para SIGTERM/SIGINT |
| AUD-019 | Corrigido | Filtros SQL aplicáveis precedem paginação; filtros de metadata são aplicados antes do corte de 50 |
| AUD-020 | Corrigido | Teste acompanha `web_health_url` em vez do literal antigo |
| AUD-021 | Corrigido | Fixture RBAC fornece `username` obrigatório |
| AUD-022 | Corrigido | Redis usa volume nomeado e AOF `everysec` |
| AUD-023 | Corrigido | Imagem Central instala produção pelo lock pnpm congelado; build validado |
| AUD-024 | Corrigido | `python-multipart` atualizado de 0.0.12 para 0.0.20 |
| AUD-025 | Corrigido | Sintaxe shell verifica cada arquivo; CI ganhou regressões P0, Central/PG e build/vet/test do Go |
| AUD-026 | Mitigado, refatoração contínua | Regras duplicadas críticas foram centralizadas e datastore/coordenação isolados; decompor monólitos inteiros continua sendo trabalho incremental, sem reescrita arriscada |
| AUD-027 | Corrigido com preservação | Cache NumPy gerado removido e ignorado; backups/patches do usuário foram preservados por segurança |
| AUD-028 | Corrigido | Conversão Mb/s virou função pura com teste exato; integração não depende de faixa temporal estreita |

## Validações principais

- API: build/typecheck aprovado; suíte completa com 1.622/1.622 testes, incluindo reset concorrente, push/ACL, legal hold, S3, offload e scripts.
- Web: 528 testes aprovados; build de produção executado após a alteração de autenticação.
- IA: 323 testes aprovados na repetição final.
- Central: testes de concorrência, slow body, readiness, lock, datastore e performance; build com lockfile aprovado.
- Go: `go vet`, testes e build executados no estágio da imagem.
- Compose: configuração de produção validada.
- Shell: sintaxe dos scripts alterados e laboratório de falhas do update/rollback.

Resultados finais completos devem ser lidos junto dos logs da execução: testes que exigem Bash não rodam na imagem de produção minimalista sem instalar Bash no container efêmero; integrações PostgreSQL usam banco descartável. Nenhum teste destrutivo apontou para produção.

## Mudanças operacionais que exigem atenção no rollout

1. Redis passa a persistir em `redis_data`; o primeiro deploy cria o volume.
2. Central com URL PostgreSQL passa a `pg` por padrão. `dual` só funciona com `DRAC_CENTRAL_ALLOW_DUAL_READ=true` e deve ser temporário.
3. O healthcheck da Central usa `/api/ready`, podendo marcar unhealthy quando o datastore/fila realmente não estiver pronto.
4. Restore deixa de forçar `drac-central`; profiles e overlays precisam estar corretos no `.env` de cada host.
5. A nova imagem da Central usa o lockfile do monorepo.
6. O cache `services/ai-service-python/datasets/coco8/labels/val.cache` foi removido; é regenerável e agora ignorado.

## Limite honesto

AUD-026 é dívida estrutural, não um defeito binário. As causas de maior risco foram extraídas/centralizadas nesta rodada, mas os arquivos grandes não foram reescritos integralmente. Uma reescrita ampla junto de correções de segurança aumentaria muito o risco de regressão. A continuação segura é extrair módulos pequenos, com testes de caracterização, em mudanças separadas.
