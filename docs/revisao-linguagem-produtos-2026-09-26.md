# Revisão de linguagem dos produtos — 26/09/2026

## Público de cada produto

| Produto | Público | Linguagem esperada |
| --- | --- | --- |
| Aplicativo móvel | Cliente final e operadores comuns | Objetiva, orientada à ação e sem termos de infraestrutura. |
| Painel web da instalação | Cliente administrador, operador e visualizador | Clareza operacional; mostra o efeito e o próximo passo, sem expor serviços internos. |
| DRAC Central | Equipe técnica | Técnica e precisa; pode tratar instalação, versões, serviços e diagnósticos. |

## Ajustes realizados

- O aplicativo passa a converter falhas de rede, autorização, conflito e excesso de tentativas em mensagens de ação. A mensagem técnica original não é mostrada.
- Fluxos de login, recuperação de senha, câmeras, gravações, alarmes e fotos do aplicativo deixaram de reaproveitar texto bruto recebido do servidor.
- A tela de entrada do aplicativo chama o endereço opcional de “Endereço de acesso”, sem expor API, protocolo ou detalhes do servidor.
- O painel web passou a filtrar mensagens técnicas recebidas em fluxos que usam o helper compartilhado e sua tela de recuperação não mostra a exceção de renderização.
- Textos de recuperação de vídeo foram reescritos para indicar estado e alternativa ao usuário, sem WebRTC, WHEP, HLS, CPU ou transcodificação.
- A Central não recebeu simplificação: ela é o local intencional para a equipe técnica ver detalhes de instalação e operação.

## Regra de produto adotada

Em interfaces de cliente, uma falha deve dizer: o que não foi concluído, se os dados permanecem preservados e o próximo passo possível. Endereços internos, nomes de serviços, protocolos, códigos HTTP, tokens, rastros de exceção e dados de infraestrutura ficam nos registros e na Central.

## Limite consciente

O cadastro técnico de câmeras continua acessível apenas aos perfis que já o utilizam. Ele contém dados de equipamento porque esse fluxo exige configuração real; a recomendação é mantê-lo restrito a administradores/instaladores e não apresentá-lo como função de operação cotidiana.
