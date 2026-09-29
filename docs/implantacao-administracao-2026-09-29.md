# Implantação das melhorias de Administração

Data: 29/09/2026, UTC. Complementa
[o relatório de implementação](correcoes-administracao-2026-09-28.md).

## Versão e instalações

Código implantado: `5391c4a0dc390025d05f756c1cbc80d07ec9da92`.

| Instalação | API iniciada | Web iniciada | Estado |
| --- | --- | --- | --- |
| Vibe | 00:20:55 UTC | 00:20:56 UTC | API/web saudáveis, readiness aprovado |
| IBTelecom | 00:24:31 UTC | 00:24:31 UTC | API/web saudáveis, readiness aprovado |

Git, `DRAC_VERSION` e versão informada pela API conferem nas duas instalações.
O checkout de produção permanece fixado nesse commit de código; commits
posteriores exclusivamente documentais não alteram a versão em execução.

## Procedimento

- Preservadas imagens anteriores de API e web e cópia do ambiente.
- Vibe recebeu as imagens previamente construídas e verificadas.
- IBTelecom buscou o commit publicado e construiu API/web no próprio servidor.
  O Git foi executado com privilégios de manutenção porque parte de seus
  objetos pertence a root; não foi alterada a propriedade do repositório.
- Foram recriados somente API e web. Não houve limpeza do banco, alteração
  manual de contas ou reinicialização de MediaMTX, SRS, Redis ou PostgreSQL.
- O MediaMTX manteve o início em 26/09 02:50:04 UTC na Vibe e em
  25/09 20:27:27 UTC na IBTelecom, ambos com zero reinícios.
- As 65 migrações existentes foram verificadas pela inicialização da API;
  esta entrega não acrescentou migrações.

## Verificação depois da implantação

- `scripts/verificar-instalacao.sh --dir /opt/drac` passou nas duas instalações.
- API e web apresentaram healthchecks saudáveis e zero reinícios dos novos
  contêineres. API de readiness retornou `ready: true` nas duas instalações.
- Site público da Vibe respondeu HTTP 200, incluindo a identificação do novo
  build web. Readiness público também retornou `ready: true`.
- Vibe: MediaMTX apresentou 32 caminhos prontos na amostra, dos quais 29 eram
  fontes RTMP. Isso é uma fotografia operacional, não garantia de que toda
  câmera esteja online. Não foram modificadas fontes para alterar essa contagem.
- Vibe conservou 34 registros de câmera, três grupos ativos e oito contas
  ativas na consulta de conferência; não houve redefinição desses dados.

### Limites e avisos

Os verificadores deixam dois avisos: a senha administrativa inicial já foi
alterada e, por isso, as rotas autenticadas não foram exercitadas pelo
verificador em produção. Não foi redefinida a senha nem criada uma conta para
contornar essa limitação. Os fluxos autenticados foram testados previamente
com 13 verificações HTTP em laboratório isolado.

Na Vibe, o readiness informa `ai.ok: true` com detalhe
`degraded_processors`. Isso é uma atenção operacional dos processadores de
análise, não uma aprovação de todas as análises de câmera. Não foi tratado
como parte destas alterações administrativas.

Ainda cabe conferência visual pelo usuário em navegador autenticado. A
interface nova deve ser carregada ao atualizar a página. Não foi necessário
gerar outro APK nesta entrega.

Não foram atualizadas outras instalações da frota nem promovida esta versão
como release global da Central: o gate de instalação limpa do commit
`5391c4a` não foi executado. Não se reutilizou evidência de outro commit para
declarar esse gate aprovado.

## Retorno preservado

Nas duas instalações:

- `drac-administration-rollback-api:20260929`
- `drac-administration-rollback-web:20260929`
- `/opt/drac/infra/.env.before-administration-20260929`
- Commit anterior: `78a4e8c32d6d1fce947c91c1f174d9b2c7af858e`.

Um retorno deve restaurar juntos as imagens, o ambiente e o checkout anterior,
recriando somente API/web. A cópia de ambiente contém segredos e não deve ser
incluída no Git ou compartilhada como relatório.
