# Correções P0 — 26/09/2026

Status: implementadas no workspace e validadas com testes dirigidos. Não implantadas nos demais servidores; não houve commit ou push nesta etapa.

## AUD-001 — concorrência da Central

- A leitura do corpo da instalação remota ocorre fora da fila de mutações.
- Autenticação, leitura fresca, preparação e salvamento ficam na mesma seção serializada.
- A persistência assíncrona da host key também recarrega e salva dentro da fila.
- SSH continua em background, sem manter o lock durante a instalação.
- Teste HTTP real da Central confirma que provisionamento concorrente não desaparece.

## AUD-002 — ponto de recuperação

- Fetch/build ocorrem antes do checkpoint do banco.
- O checkpoint é obrigatório, validado e capturado depois de parar a aplicação.
- A restauração de banco só é permitida quando a etapa de migração pode ter alterado dados.
- Falha de fetch/build não para a aplicação nem restaura banco; falha de dump não executa migração nem restaura dump incompleto.
- Alterações locais versionadas bloqueiam o update mesmo com ALLOW_DIRTY, evitando descarte por reset do rollback.
- Restore também captura seu dump de segurança somente após parar writers. Se o checkpoint falhar, mantém o banco original e informa explicitamente que os writers estão parados, exigindo retomada operacional.

## Validação

17 testes dirigidos aprovados: 1 de concorrência HTTP, 6 de checkpoint/rollback e 10 de segurança operacional. Sintaxe Bash e `git diff --check` passaram.

O teste de rollback executa o script completo com Docker/Git/curl simulados e injeta falha em fetch, build, dump e migration, além do caminho de sucesso. Não executa restore real. O teste de ordenação do restore é estático. O teste HTTP usa datastore JSON temporário; a mesma proteção de serialização envolve o backend PostgreSQL, mas essa corrida não foi reexecutada em PostgreSQL nesta correção.

Comandos para repetir em ambiente com Node e Bash:

```sh
node --test scripts/tests/p0-update-rollback.test.cjs
cd apps/central
node --test tests/remote-install-concurrency.test.js
```

O teste HTTP entra no glob existente da suíte Central. O novo teste operacional pode ser executado pelo comando acima; sua inclusão no workflow não foi realizada porque o arquivo local `.github/workflows/ci.yml` está sem permissão de escrita para o usuário atual. O workflow permaneceu inalterado.

Também foi ajustada a expectativa antiga de bind no teste operacional (AUD-020), necessária para validar a suíte relacionada. Os demais P1/P2/P3 não foram tratados. A auditoria original permanece como registro do estado anterior.

Antes da implantação: revisar diff, versionar somente os arquivos da correção, executar o gate disponível e promover a Central/instalações com backup e janela adequados. Não executar os cenários de falha contra produção.
