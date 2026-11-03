# Horários dos avisos de detecção

Os períodos controlam apenas avisos em tela, som e notificações no computador.
Não alteram a execução da IA, gravações, perímetros ou o módulo de alarmes.

## Operação

Em **Grupos → Horários dos avisos**, escolha 24 horas, períodos ou sem avisos
automáticos. A programação se aplica às câmeras cujo **grupo principal** é esse
grupo e que não possuem programação própria.

No sino do tile da câmera em **Ao Vivo**, use:

- **Seguir programação**: automático.
- **Ativar agora**: mantém os avisos ativos até retornar ao automático.
- **Pausar avisos**: mantém os avisos pausados até reativar.
- **Programar horários…**: herdar o grupo ou definir períodos exclusivos.

O mesmo editor está disponível na edição da câmera. O controle manual tem
prioridade sobre os horários, mas não habilita modalidades de aviso que estejam
desativadas na câmera. Os controles exigem permissão de configuração e acesso
administrativo à câmera. Os horários de grupo exigem administrador.

O sino verde indica avisos ativos; o relógio indica fora do horário; o sino
desligado indica pausa ou avisos não configurados. O texto do controle distingue
esses estados.

Cada período possui dias da semana, início, fim e fuso horário explícito.
Início é inclusivo e fim exclusivo. Segunda 22h–6h termina na terça às 6h.
São permitidos até 14 períodos. Para 24 horas, escolha Sempre.

## Compatibilidade e segurança

Sem configurações novas, os avisos previamente habilitados continuam 24 horas.
Nenhuma câmera ou grupo é reconfigurado automaticamente na atualização.
Notificações no computador continuam dependendo da permissão local do navegador.

As políticas são persistidas em SystemSetting, no namespace versionado
`detection.notice-policy.v1.camera.<id>` / `group.<id>`. Não há migração de schema.
Gravação transacional serializável, controle otimista por versão e auditoria
protegem alterações concorrentes. O servidor filtra os eventos pelo horário
atual e pelo horário do evento; a interface remove avisos pendentes ao pausar
ou fechar um período e bloqueia cliques em notificações antigas pausadas.

API autenticada: GET `/notice-policies`; GET/PATCH
`/notice-policies/camera/:id`; GET/PATCH `/notice-policies/group/:id`.
PATCH exige `expectedVersion` retornada no GET. Os campos são `manualMode`
(`auto`, `on`, `off`, apenas câmera) e `schedule` (`null` para herdar, apenas
câmera, ou `{mode, timezone, periods:[{days, start, end}]}`). Dias: domingo=0.

Testes: `apps/api/tests/notice-periods.test.ts` e fixture isolada de navegador
em `apps/web/tests/browser/desktop-notices-fixture.tsx`. Não geram eventos reais.
