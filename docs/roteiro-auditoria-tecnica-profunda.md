Quero que você realize uma **AUDITORIA TÉCNICA PROFUNDA, COMPLETA E SISTÊMICA em todo este projeto**.

Não quero uma revisão superficial, limitada a lint, erros de sintaxe ou arquivos isolados.

Quero que você pense e trabalhe como uma equipe formada por:

- Arquiteto de Software Sênior
- Engenheiro de Software Sênior
- Especialista em Backend
- Especialista em Frontend
- Especialista em Banco de Dados
- DevOps/SRE
- Especialista em Segurança
- QA / Engenheiro de Testes
- Especialista em Performance
- Especialista em Refatoração e Clean Code

O objetivo é **entender o sistema inteiro, verificar como suas partes se relacionam e encontrar qualquer problema atual ou potencial**.

# REGRA PRINCIPAL

**Não analise os arquivos de maneira isolada.**

Primeiro compreenda:

- arquitetura geral;
- estrutura de diretórios;
- módulos;
- serviços;
- banco de dados;
- APIs;
- frontend;
- backend;
- workers;
- filas;
- WebSockets;
- integrações externas;
- autenticação;
- permissões;
- armazenamento;
- processamento assíncrono;
- infraestrutura;
- Docker;
- variáveis de ambiente;
- scripts;
- migrations;
- dependências;
- fluxo completo dos dados.

Monte mentalmente o funcionamento do sistema antes de concluir que algo está correto ou incorreto.

Não confie cegamente em comentários, documentação, nomes de funções ou README.

**Valide o comportamento através do código real.**

---

# 1. MAPEAMENTO COMPLETO DO SISTEMA

Antes de procurar problemas, faça um inventário da aplicação.

Identifique:

- tecnologias utilizadas;
- frameworks;
- linguagens;
- bibliotecas principais;
- serviços;
- módulos;
- processos;
- bancos;
- tabelas;
- migrations;
- APIs;
- endpoints;
- rotas;
- middlewares;
- componentes;
- jobs;
- cron jobs;
- filas;
- workers;
- caches;
- WebSockets;
- integrações externas;
- serviços internos;
- armazenamento de arquivos;
- autenticação;
- autorização;
- infraestrutura;
- containers;
- configuração de produção;
- configuração de desenvolvimento.

Identifique também o fluxo principal do sistema.

Exemplo:

Cliente → Frontend → API → Serviço → Banco → Worker → Serviço externo → retorno → WebSocket → Frontend.

Faça isso para os fluxos relevantes do projeto.

---

# 2. PROCURE BUGS REAIS

Investigue possíveis:

- erros de lógica;
- condições incorretas;
- validações incompletas;
- valores `null` ou `undefined` inesperados;
- exceptions não tratadas;
- erros silenciosos;
- promises sem tratamento;
- race conditions;
- deadlocks;
- concorrência problemática;
- problemas assíncronos;
- estados inconsistentes;
- operações parcialmente executadas;
- erros de arredondamento;
- erros de timezone;
- problemas de data/hora;
- problemas de paginação;
- loops infinitos;
- recursão indevida;
- consultas incorretas;
- retornos inconsistentes;
- endpoints que podem quebrar;
- fluxos impossíveis;
- comportamentos diferentes do esperado.

Não considere apenas bugs óbvios.

Procure também bugs que aparecem somente:

- com muitos usuários;
- depois de várias horas/dias;
- durante reinicialização;
- em caso de queda de serviço;
- quando uma API externa falha;
- quando o banco fica lento;
- quando existe concorrência;
- quando duas requisições alteram o mesmo recurso;
- com dados incompletos;
- com banco parcialmente populado;
- após atualização de versão;
- durante deploy;
- após perda temporária de internet.

---

# 3. VERIFIQUE DIVERGÊNCIAS NO SISTEMA

Procure situações em que duas partes do projeto parecem esperar comportamentos diferentes.

Exemplos:

- frontend espera um campo que backend não retorna;
- backend retorna tipos diferentes;
- nomes diferentes para o mesmo conceito;
- banco aceita valor que API rejeita;
- API aceita valor que banco não suporta;
- schema diferente do model;
- migration diferente do estado esperado pelo código;
- documentação diferente da implementação;
- `.env.example` diferente das variáveis realmente utilizadas;
- Docker diferente do ambiente de desenvolvimento;
- código de produção diferente do comportamento esperado;
- endpoints antigos ainda sendo utilizados;
- versões de API misturadas;
- componentes duplicando regras de negócio;
- regras de validação diferentes em lugares diferentes.

Cruze informações entre arquivos.

Não avalie cada arquivo independentemente.

---

# 4. CÓDIGO MORTO, LIXO E RESÍDUOS

Procure:

- código morto;
- funções nunca utilizadas;
- classes nunca utilizadas;
- imports não utilizados;
- variáveis inúteis;
- componentes abandonados;
- endpoints antigos;
- APIs obsoletas;
- arquivos esquecidos;
- scripts antigos;
- migrations problemáticas;
- TODOs esquecidos;
- FIXMEs;
- mocks que chegaram à produção;
- dados fake;
- configurações antigas;
- feature flags abandonadas;
- bibliotecas não utilizadas;
- dependências duplicadas;
- versões conflitantes;
- logs temporários;
- `console.log`;
- código comentado;
- soluções temporárias;
- hacks;
- workarounds;
- arquivos de backup;
- funções duplicadas;
- implementações paralelas da mesma funcionalidade.

Classifique o que pode ser removido com segurança e o que precisa ser investigado antes.

---

# 5. DUPLICAÇÃO E COMPLEXIDADE

Procure:

- código duplicado;
- regras de negócio repetidas;
- funções quase iguais;
- componentes praticamente idênticos;
- consultas semelhantes espalhadas;
- validações duplicadas;
- tratamento de erros repetitivo;
- funções gigantes;
- arquivos excessivamente grandes;
- classes com responsabilidades demais;
- abstrações desnecessárias;
- acoplamento excessivo;
- dependências circulares;
- complexidade acidental.

Não recomende refatoração apenas por estética.

Só recomende quando houver benefício concreto em:

- manutenção;
- confiabilidade;
- legibilidade;
- desempenho;
- testabilidade;
- segurança;
- redução de bugs.

---

# 6. BANCO DE DADOS

Faça uma revisão profunda da camada de dados.

Analise:

- modelagem;
- relacionamentos;
- foreign keys;
- índices;
- constraints;
- unique constraints;
- tipos das colunas;
- campos nullable;
- defaults;
- cascade;
- soft delete;
- timestamps;
- migrations;
- queries;
- ORM;
- transações;
- concorrência;
- consistência.

Procure:

- N+1 queries;
- queries desnecessárias;
- consultas sem índice;
- full scans potencialmente perigosos;
- joins caros;
- duplicação de dados;
- inconsistência;
- possibilidade de registros órfãos;
- falta de constraints;
- possibilidade de duplicação;
- problemas de transação;
- migrations destrutivas;
- migrations que podem quebrar produção;
- problemas de rollback;
- crescimento ilimitado de tabelas;
- logs sem retenção;
- históricos crescendo indefinidamente.

Considere também o comportamento com:

- 1.000 registros;
- 100.000 registros;
- milhões de registros.

---

# 7. PERFORMANCE

Procure gargalos em:

- CPU;
- RAM;
- disco;
- banco;
- rede;
- frontend;
- backend;
- processamento de arquivos;
- workers;
- filas;
- APIs;
- serialização;
- consultas;
- loops;
- imagens;
- vídeos;
- streams;
- WebSockets.

Identifique:

- operações bloqueantes;
- processamento repetido;
- chamadas externas desnecessárias;
- polling excessivo;
- consultas repetidas;
- ausência de cache onde faria sentido;
- cache incorreto;
- objetos grandes mantidos em memória;
- memory leaks;
- conexões não fechadas;
- streams não liberados;
- arquivos temporários não removidos;
- listeners acumulando;
- timers abandonados.

Não proponha otimização prematura.

Priorize gargalos com impacto provável ou comprovável.

---

# 8. CONCORRÊNCIA E ESCALABILIDADE

Imagine o sistema funcionando com:

- 1 usuário;
- 10 usuários;
- 100 usuários;
- 1.000 usuários;
- múltiplos workers;
- múltiplas instâncias da aplicação.

Procure problemas relacionados a:

- estado mantido somente em memória;
- sessões locais;
- concorrência;
- locks;
- filas;
- jobs duplicados;
- cron executando em múltiplas instâncias;
- cache local;
- WebSockets;
- processamento duplicado;
- idempotência;
- retry;
- mensagens duplicadas;
- ordem de execução;
- consistência eventual.

Identifique o que impediria escalabilidade horizontal.

---

# 9. SEGURANÇA

Faça uma revisão de segurança procurando:

- SQL Injection;
- XSS;
- CSRF;
- SSRF;
- command injection;
- path traversal;
- upload inseguro;
- execução arbitrária;
- IDOR;
- autenticação incorreta;
- autorização incorreta;
- privilege escalation;
- tokens expostos;
- secrets no código;
- senhas;
- chaves privadas;
- API keys;
- JWT mal implementado;
- sessões inseguras;
- cookies inseguros;
- CORS incorreto;
- endpoints administrativos expostos;
- rate limit inexistente;
- brute force;
- enumeração de usuários;
- logs contendo informações sensíveis;
- mensagens de erro revelando detalhes internos.

Verifique também dependências vulneráveis ou abandonadas.

Não exponha segredos encontrados na resposta. Apenas indique o arquivo/local e o tipo de problema.

---

# 10. AUTENTICAÇÃO E AUTORIZAÇÃO

Rastreie o fluxo completo.

Verifique:

- login;
- logout;
- refresh token;
- expiração;
- recuperação de senha;
- criação de usuário;
- alteração de senha;
- permissões;
- roles;
- middleware;
- sessões;
- revogação;
- invalidação.

Tente encontrar maneiras de:

- acessar recurso sem autenticação;
- acessar recurso de outro usuário;
- elevar privilégios;
- utilizar token expirado;
- reutilizar token;
- contornar verificações pelo frontend.

A segurança deve existir no servidor.

Nunca considere validação apenas no frontend suficiente.

---

# 11. APIs E INTEGRAÇÕES

Analise:

- contratos;
- payloads;
- status HTTP;
- tratamento de erros;
- timeout;
- retry;
- backoff;
- circuit breaker;
- rate limit;
- autenticação;
- idempotência.

Verifique como o sistema reage se uma integração:

- demora;
- retorna 500;
- retorna dados inválidos;
- muda algum campo;
- fica indisponível;
- responde parcialmente;
- rejeita autenticação.

Nenhuma API externa deve ser tratada como 100% confiável.

---

# 12. FRONTEND

Analise:

- gerenciamento de estado;
- componentes;
- hooks;
- efeitos;
- requests;
- cache;
- loading;
- erros;
- formulários;
- validações;
- navegação;
- responsividade;
- acessibilidade;
- UX;
- renderizações desnecessárias;
- memory leaks;
- listeners;
- timers;
- WebSockets.

Procure:

- estados impossíveis;
- loading infinito;
- tela branca;
- dados antigos;
- race conditions entre requests;
- formulário enviado duas vezes;
- botão permitindo ações duplicadas;
- erro ignorado;
- informação do frontend diferente do banco.

---

# 13. BACKEND

Analise:

- controllers;
- services;
- repositories;
- models;
- DTOs;
- schemas;
- middlewares;
- jobs;
- workers.

Verifique:

- separação de responsabilidades;
- tratamento de erros;
- transações;
- concorrência;
- validações;
- consistência;
- logging;
- observabilidade.

Procure caminhos onde erros possam ser engolidos e o sistema continue funcionando em estado incorreto.

---

# 14. INFRAESTRUTURA E DEPLOY

Analise arquivos relacionados a:

- Docker;
- Docker Compose;
- Kubernetes, se existir;
- nginx;
- proxy;
- systemd;
- CI/CD;
- scripts;
- deploy;
- backups;
- storage;
- volumes;
- certificados;
- portas;
- redes.

Procure:

- portas expostas desnecessariamente;
- volumes incorretos;
- perda de dados ao recriar container;
- configuração incompatível com produção;
- dependência de ordem de inicialização;
- healthchecks ausentes;
- restart policies incorretas;
- serviços iniciando antes do banco;
- configurações hardcoded;
- problemas de permissões;
- usuário root desnecessário.

---

# 15. DEPENDÊNCIAS

Analise todos os gerenciadores existentes no projeto.

Por exemplo:

- npm;
- pnpm;
- yarn;
- pip;
- poetry;
- composer;
- cargo;
- go modules.

Procure:

- dependências obsoletas;
- abandonadas;
- vulneráveis;
- duplicadas;
- desnecessárias;
- versões incompatíveis;
- dependências muito pesadas para funções simples.

Não recomende atualizar tudo indiscriminadamente.

Considere risco de breaking changes.

---

# 16. CONFIGURAÇÕES E VARIÁVEIS DE AMBIENTE

Cruze:

- código;
- `.env`;
- `.env.example`;
- Docker;
- documentação;
- CI/CD.

Identifique:

- variáveis utilizadas mas não documentadas;
- variáveis documentadas mas não utilizadas;
- defaults perigosos;
- valores hardcoded;
- segredos;
- configurações conflitantes;
- configurações de desenvolvimento utilizadas em produção.

---

# 17. LOGS, MONITORAMENTO E OBSERVABILIDADE

Verifique se seria possível diagnosticar um problema real em produção.

Avalie:

- logs;
- níveis de log;
- contexto;
- IDs de requisição;
- erros;
- métricas;
- healthchecks;
- tracing.

Identifique situações em que uma falha poderia ocorrer sem deixar evidência suficiente.

Também procure logs excessivos que podem:

- consumir disco;
- degradar performance;
- expor dados sensíveis.

---

# 18. TRATAMENTO DE FALHAS

Simule mentalmente:

- banco indisponível;
- Redis indisponível;
- API externa indisponível;
- falta de internet;
- disco cheio;
- pouca memória;
- reinicialização do servidor;
- container reiniciado;
- processo morto;
- aplicação encerrada durante uma operação;
- arquivo corrompido;
- resposta inválida;
- timeout;
- serviço muito lento.

Explique o que aconteceria.

Identifique onde o sistema pode ficar em estado inconsistente.

---

# 19. TESTES

Analise os testes existentes.

Identifique:

- funcionalidades críticas sem testes;
- testes frágeis;
- testes falsos positivos;
- mocks demais;
- cobertura aparentemente alta mas pouco útil;
- ausência de integração;
- ausência de testes de concorrência.

Sugira testes específicos para os problemas encontrados.

Priorize testes que evitariam regressões reais.

---

# 20. DOCUMENTAÇÃO

Compare documentação com implementação.

Procure:

- comandos incorretos;
- endpoints antigos;
- variáveis ausentes;
- arquitetura desatualizada;
- configuração incorreta;
- instruções incompatíveis com o projeto atual.

---

# 21. CONSISTÊNCIA ARQUITETURAL

Procure padrões que começaram de uma maneira e posteriormente foram implementados de outra.

Exemplos:

`serviceA → repository → banco`

enquanto:

`serviceB → banco diretamente`

ou:

`endpoint A → validação centralizada`

enquanto:

`endpoint B → validação manual`.

Identifique essas divergências e avalie se representam:

- dívida técnica;
- risco de bugs;
- inconsistência;
- simples decisão válida de arquitetura.

---

# 22. PROCURE PROBLEMAS QUE NÃO ESTOU PEDINDO EXPLICITAMENTE

Não limite sua análise à lista deste prompt.

Se encontrar algo suspeito, investigue.

Pergunte internamente:

**"Como isso poderia quebrar?"**

**"O que acontece se isso falhar?"**

**"Isso continua funcionando com carga?"**

**"Isso funciona depois de reiniciar?"**

**"Existe outra parte do sistema implementando a mesma coisa de forma diferente?"**

**"Existe uma condição rara capaz de quebrar isso?"**

**"Existe risco de perda ou corrupção de dados?"**

**"Esse código realmente é utilizado?"**

---

# 23. EVITE FALSOS POSITIVOS

Muito importante:

Não marque algo como problema apenas porque não segue uma preferência pessoal.

Para cada problema encontrado, tente confirmar através do restante do código.

Diferencie claramente:

**BUG CONFIRMADO**

Existe evidência clara de comportamento incorreto.

**PROBLEMA PROVÁVEL**

Há fortes evidências, mas depende de determinada condição.

**RISCO**

Ainda não existe bug comprovado, mas a arquitetura permite que aconteça.

**MELHORIA**

O sistema funciona, mas existe uma implementação potencialmente melhor.

**DÍVIDA TÉCNICA**

Não é um problema imediato, porém dificulta manutenção futura.

---

# 24. NÃO MODIFIQUE O SISTEMA DURANTE A PRIMEIRA FASE

Primeiro faça a auditoria.

Não comece alterando arquivos assim que encontrar o primeiro problema.

Um problema aparentemente local pode existir devido a outra decisão arquitetural.

Primeiro:

1. descubra;
2. investigue;
3. confirme;
4. procure dependências;
5. determine impacto;
6. somente depois proponha alteração.

---

# 25. PARA CADA PROBLEMA ENCONTRADO

Informe:

**Título**

Descrição curta.

**Classificação**

Bug confirmado / problema provável / risco / melhoria / dívida técnica.

**Severidade**

CRÍTICA / ALTA / MÉDIA / BAIXA.

**Localização**

Arquivo, função, classe, módulo ou componente.

**Evidência**

Mostre exatamente por que considera aquilo um problema.

**Impacto**

O que pode acontecer.

**Como reproduzir**

Quando aplicável.

**Causa raiz**

Não apenas o sintoma.

**Correção recomendada**

Explique a solução.

**Impacto da correção**

Informe quais outras partes do sistema precisam ser verificadas depois.

**Teste necessário**

Explique como provar que a correção realmente resolveu o problema.

---

# 26. NÃO FAÇA REFATORAÇÃO DESTRUTIVA

Não:

- reescreva módulos inteiros sem necessidade;
- troque arquitetura apenas por preferência;
- introduza novas bibliotecas sem benefício claro;
- remova código sem verificar dependências;
- altere contratos de API sem avaliar consumidores;
- altere banco sem considerar migrations e dados existentes.

Prefira:

**menor alteração possível que resolva corretamente a causa raiz.**

---

# 27. ANÁLISE EM CAMADAS

Faça a auditoria em múltiplas passagens.

## Passagem 1 — Descoberta

Entenda todo o projeto.

## Passagem 2 — Arquitetura

Mapeie dependências e fluxos.

## Passagem 3 — Análise estática

Procure problemas diretamente no código.

## Passagem 4 — Análise cruzada

Compare módulos, contratos, banco, frontend e backend.

## Passagem 5 — Fluxos reais

Siga os principais casos de uso do início ao fim.

## Passagem 6 — Falhas

Simule situações anormais.

## Passagem 7 — Segurança

Realize revisão específica de segurança.

## Passagem 8 — Performance e escalabilidade

Analise gargalos e concorrência.

## Passagem 9 — Manutenibilidade

Procure lixo, duplicação, código morto e dívida técnica.

## Passagem 10 — Revisão da própria auditoria

Antes de finalizar, revise suas próprias conclusões procurando:

- falso positivo;
- problema duplicado;
- problema mal classificado;
- problema importante que passou despercebido.

---

# 28. PRIORIDADE

Classifique os achados nesta ordem:

### P0 — CRÍTICO

Pode provocar:

- perda de dados;
- corrupção de dados;
- comprometimento de segurança;
- indisponibilidade total;
- vazamento;
- falha grave do sistema.

### P1 — ALTO

Pode causar falha importante em produção.

### P2 — MÉDIO

Problema real, porém com impacto limitado ou workaround.

### P3 — BAIXO

Melhoria de qualidade, organização ou manutenção.

---

# 29. RESULTADO FINAL

Ao terminar a auditoria, apresente:

## 1. Resumo executivo

Estado geral do projeto.

## 2. Arquitetura encontrada

Explique como o sistema realmente funciona.

## 3. Fluxos principais

Mostre os fluxos mais importantes.

## 4. Problemas críticos

P0.

## 5. Problemas altos

P1.

## 6. Problemas médios

P2.

## 7. Problemas baixos

P3.

## 8. Código morto/lixo

Tudo que potencialmente pode ser removido.

## 9. Divergências

Inconsistências entre diferentes partes do sistema.

## 10. Segurança

Riscos encontrados.

## 11. Banco de dados

Problemas e melhorias.

## 12. Performance

Possíveis gargalos.

## 13. Escalabilidade

Problemas futuros.

## 14. Infraestrutura

Problemas de deploy/configuração.

## 15. Dependências

Problemas identificados.

## 16. Testes ausentes

Testes importantes que deveriam existir.

## 17. Melhorias arquiteturais

Somente melhorias justificáveis.

## 18. Plano de correção

Crie uma sequência segura de implementação:

FASE 1 → problemas críticos
FASE 2 → bugs importantes
FASE 3 → consistência
FASE 4 → segurança
FASE 5 → performance
FASE 6 → refatoração
FASE 7 → limpeza

Explique dependências entre correções.

---

# 30. RELATÓRIO RESUMIDO DOS ACHADOS

No começo do relatório final apresente também uma tabela:

| ID | Severidade | Tipo | Área | Problema | Impacto | Confiança |
|---|---|---|---|---|---|---|
| AUD-001 | P0 | Bug | Backend | ... | ... | Alta |
| AUD-002 | P1 | Segurança | API | ... | ... | Alta |
| AUD-003 | P2 | Performance | Banco | ... | ... | Média |

Use IDs para que possamos posteriormente solicitar:

`corrija AUD-003`

ou:

`investigue melhor AUD-017`.

---

# 31. IMPORTANTE: PROFUNDIDADE DA INVESTIGAÇÃO

Não quero algo como:

"Analisei o projeto e ele está bem estruturado, porém existem algumas melhorias."

Isso não serve.

Quero investigação técnica.

Abra os arquivos.

Siga imports.

Siga chamadas.

Procure quem chama cada função importante.

Procure quem consome cada endpoint.

Cruze schemas.

Cruze models.

Cruze migrations.

Cruze variáveis de ambiente.

Cruze frontend e backend.

Cruze documentação e implementação.

Rastreie os dados de ponta a ponta.

Se encontrar algo estranho, continue investigando até descobrir a origem.

Não pare no sintoma.

Procure a **causa raiz**.

---

# 32. NÃO PRESUMA QUE ALGO FUNCIONA

Sempre que possível valide através de:

- leitura do código;
- busca global;
- execução;
- testes;
- build;
- type checking;
- lint;
- logs;
- consultas;
- inspeção das dependências;
- testes automatizados.

Se tiver acesso ao terminal, execute verificações seguras que não modifiquem dados.

Pode utilizar ferramentas disponíveis para compreender o sistema.

Não execute ações destrutivas.

---

# 33. APÓS ENCONTRAR UM BUG

Antes de sugerir a correção, procure:

- todas as chamadas daquela função;
- consumidores;
- dependências;
- testes relacionados;
- schemas relacionados;
- endpoints relacionados;
- migrations relacionadas.

Uma correção não pode criar uma regressão em outra parte do sistema.

---

# 34. MODO INVESTIGATIVO

Durante toda a análise, comporte-se como se este sistema fosse ser colocado amanhã em produção para milhares de usuários e você fosse responsável tecnicamente por garantir que ele não:

- caia;
- perca dados;
- corrompa dados;
- exponha dados;
- apresente comportamentos inconsistentes;
- acumule problemas silenciosamente.

Não procure somente erros existentes.

Procure também **falhas latentes**, que ainda não aconteceram porque determinadas condições ainda não ocorreram.

---

# 35. NÃO PARE APÓS OS PRIMEIROS ACHADOS

Encontrar 5 ou 10 problemas não significa que a auditoria terminou.

Continue analisando o restante do projeto.

Cubra todos os módulos relevantes.

No final informe também:

- módulos analisados;
- módulos parcialmente analisados;
- módulos não analisados;
- limitações da auditoria.

Nunca afirme que todo o sistema está correto se alguma área não foi verificada.

---

# OBJETIVO FINAL

Quero sair desta auditoria sabendo:

1. O que está errado hoje.
2. O que provavelmente vai dar problema no futuro.
3. O que pode quebrar em produção.
4. O que pode causar perda de dados.
5. O que pode causar vulnerabilidade.
6. O que está inconsistente.
7. O que está duplicado.
8. O que está obsoleto.
9. O que não é mais utilizado.
10. O que está desnecessariamente complexo.
11. O que pode ser simplificado.
12. O que pode ser otimizado.
13. O que precisa de testes.
14. O que precisa ser refatorado.
15. Em qual ordem tudo isso deveria ser corrigido.

**Profundidade é mais importante que velocidade.**

Prefiro uma auditoria longa e tecnicamente fundamentada a uma resposta rápida e superficial.

Comece pela descoberta e mapeamento do projeto. Não altere nada ainda.
