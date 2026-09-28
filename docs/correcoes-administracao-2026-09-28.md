# Administração — correções e melhorias

Data: 28/09/2026. Escopo: Minha conta, Novidades, Usuários, Grupos, Funções,
personalização e Configurações; revisão dos fluxos de rondas relacionados.

## Segurança e funcionamento

- Grupos agora retornam somente o resumo necessário das câmeras. Listagem e
  consulta individual filtram as câmeras autorizadas, inclusive para proteger
  câmeras particulares contra acesso indevido de administradores globais.
  Credenciais criptografadas, usuário de conexão e IP não fazem parte do resumo.
- A permissão `userManage` é aplicada à gestão global de usuários e concessões
  de acesso. A administração delegada por grupo continua limitada aos grupos
  administrados; não foi substituída por privilégio global. O administrador
  principal mantém sua proteção contra bloqueio administrativo.
- Minha conta consegue consultar as permissões do próprio usuário sem exigir
  que ele seja administrador de grupo. Consultar permissões de terceiros
  continua limitado ao escopo autorizado.
- Configurações valida todos os campos antes de iniciar uma única transação.
  Um campo inválido não deixa os campos anteriores parcialmente salvos.
- A personalização envia apenas os campos alterados. Edições feitas enquanto
  uma requisição está em andamento são preservadas no formulário.
- Transferir uma câmera de grupo exige confirmação da origem. A gravação é
  condicional ao vínculo atual, evitando sobrescrever uma transferência
  concorrente. Câmeras particulares não podem ser transferidas por esse fluxo.
- Remover uma câmera usa o vínculo atual como condição. Desativar um grupo
  separa suas câmeras e desativa o grupo dentro de uma transação.
- Funções rejeita matrizes incompletas ou inválidas e impede alterações da
  função principal; sua matriz de leitura corresponde ao acesso protegido.
- Rondas trata respostas HTTP de erro, falhas de rede e tempo de espera;
  impede gravações repetidas, confirma exclusão e mantém o erro visível no editor.
- Cadastro e alteração de senha mostram a política vigente. O login não
  impõe um tamanho diferente daquele permitido ao cadastrar senhas legadas.

## Interface e textos

- Menu, busca, rotas e atalhos administrativos consultam a mesma política de
  permissões. A busca inclui Minhas rondas e Mosaicos e rondas e respeita os
  itens ocultos por instalação.
- Renovar o token da mesma conta não apaga permissões nem desmonta o formulário
  administrativo. Uma falha temporária preserva os dados já verificados; a API
  continua sendo responsável por autorizar cada operação. Sem consulta inicial
  válida, a interface mostra a possibilidade de tentar novamente.
- Grupos ganhou buscas, apresentação adaptada a telas estreitas, aviso de dados
  desatualizados e proteção contra respostas antigas de carregamento.
- Funções ganhou operação por teclado, nomes acessíveis nos controles, tabela
  com rolagem horizontal e confirmação antes de descartar alterações.
- Configurações indica alterações não salvas e protege saída por links, busca,
  atalhos e fechamento da página. Confirmar saída por link recarrega o destino;
  o aviso de fechamento da aba é o mecanismo próprio do navegador.
- Logos inválidos ou excessivamente grandes são rejeitados antes de salvar.
  A conversão para PNG também respeita o limite de tamanho resultante.
- Mensagens de falha não mostram detalhes de infraestrutura, códigos HTTP ou
  mensagens internas. A validação de senha oferece orientação clara.
- Termos foram padronizados em Funções e Permissões; o texto diferencia
  aparência do app e do painel. Aceleração, prazo das gravações e novidades
  receberam explicações menos técnicas. Textos de 9–10 px nas páginas
  prioritárias foram ampliados.

## Verificação

- API: 1.679 testes, sendo 1.677 aprovados e 2 integrações ignoradas pelo
  conjunto existente. Não foram consideradas como aprovadas.
- Web: 548 testes aprovados e verificação TypeScript sem erros.
- Builds da API e web concluídos. O build web mantém o aviso preexistente de
  tamanho de alguns pacotes de bibliotecas.
- 13 verificações HTTP passaram em API e PostgreSQL isolados: login, escopo e
  resumo de grupos, proteção de câmera particular, consulta do próprio acesso,
  rejeição de salvamento parcial, personalização separada, transferência
  confirmada e bloqueio real de gestão de usuários/acessos.
- O laboratório não tinha servidor de IA; suas verificações HTTP não equivalem
  à aprovação de saúde de toda a infraestrutura de vídeo.

## Entrega e limites

As alterações são entregues no repositório. **Não houve implantação ou
reinicialização dos serviços de produção nesta etapa.** Não foi gerado APK,
pois as alterações estão no web e na API.

Falta validar visualmente os fluxos em navegador autenticado e publicar a
versão nos servidores. A imagem fornecida mostra o menu, não todas as páginas;
os testes realizados não substituem essa conferência visual.
