# Proteção das instalações locais — implementação e publicação

Data: 05/10/2026. Base: `ea1e788b94ee6420632869392f109c200d58ee94`.
Branch isolado: `security/local-licensing-20261005`.

## Resultado e limite

Central, Vibe, IB Telecom e Dguardian estão com emissão/validação de licenças
Ed25519 em produção. As três instalações validaram uma autorização ACTIVE e
renovaram a licença depois da substituição da API, sem erro de contato.

Este é o perfil **standard**, não uma instalação protegida por hardware. Root
hostil ainda pode substituir o programa, clonar disco/chave do dispositivo ou
restaurar banco e relógio. Assinatura impede fabricar uma autorização válida;
não impede remover um verificador sob controle do próprio invasor.

Nenhuma gravação foi apagada. Modos das câmeras, TURN, modelos, resolução, FPS e
configuração de vídeo foram preservados. Só APIs e Central foram recriadas.

## Implementado

- Chave privada emissora somente na Management, diretório 0700/arquivo 0600,
  montada somente leitura. Clientes recebem apenas a chave pública.
- Chave Ed25519 exclusiva por instalação, prova assinada com nonce e prazo,
  vínculo do primeiro dispositivo na Central e recuperação auditada com nova
  geração. Nonces usados são persistidos; excesso de provas é recusado sem
  expulsar nonces ainda válidos.
- Documento assinado identifica instalação/dispositivo, plano, permissões,
  classes de objetos, limites, geração, sequência e datas.
- API verifica assinatura, identidade, prazo e sequência antes de aceitar.
  Alterar limites e permissões locais não aumenta os valores assinados.
- Verificação obrigatória permanece obrigatória; apagar o token ou o marcador
  não libera o processo já ativo. Variável obrigatória também está nos overlays.
- Política offline mantida: aviso em 7 dias, restrição em 10, suspensão em 15.
  Prazo deriva da autorização assinada, não de um contato local inventado.
  Reprodução, exportação e administração de dados existentes continuam
  disponíveis na suspensão; novas gravações/IA são interrompidas pelo conector.
- Verificação fora do processamento por frame; documento válido fica em cache.
  Não foi realizado benchmark controlado de CPU desta alteração.
- Backup cifrado/autenticado da chave emissora na área de dados da Central,
  verificado após publicação. O segredo de recuperação deve ter cópia separada
  em cofre da equipe; o backup sozinho não substitui essa custódia.
- Atualizador Git antigo recusa substituir instalações migradas por uma API
  sem licença assinada ou descartar os novos mounts/overlays.

## Produção: evidências finais, aproximadamente 02:27 UTC

| Instalação | Estado/assinatura | Renovação | Câmeras/modos observados |
| --- | --- | --- | --- |
| Vibe | ACTIVE / verified | 02:26:26, sequência 25, lastError vazio | 3 motion + 31 manual |
| IB Telecom | ACTIVE / verified | 02:26:45, sequência 7, lastError vazio | 28 manual |
| Dguardian | ACTIVE / verified | 02:27:21, sequência 17, lastError vazio | Nenhuma câmera cadastrada |

Em todas: `hardwareProtected:false`, ao vivo/gravação/reprodução/exportação
habilitados conforme a licença. Vibe mantém objeto liberado somente para
person/car/motorcycle/bicycle; IB e Dguardian mantêm objeto desligado.

Vibe: `/health/ready` HTTP 200, banco/schema/Redis/storage/MediaMTX/IA OK,
66 migrations aplicadas. IA: ready=true, três processadores motion rodando a
7 FPS configurados. Isso não é medição de FPS efetivo nem teste de alcance.

Após migração: IA/Web continuavam com aproximadamente 26 h de uptime; MediaMTX
com 2–3 dias. Portanto não houve recriação desses serviços nesta publicação.

IB usava `http://10.10.0.11:8080` para a Central. HTTPS pelo IP público não
conectava a partir dessa VM. Verificado Gateway em 10.10.0.10:443; requisição
HTTPS para central.s2cam.com.br por esse IP retornou HTTP 200 e a chave pública
esperada, com validação normal de certificado. Overlay da API usa HTTPS e
extra_hosts para essa rota. Não foi desabilitada validação TLS.

Central final: `drac-security-central:20261005-signed-runtime`, healthy,
`/api/ready`: ready/datastore=true/queuedMutations=0. Backup cifrado verificado.
API final em todas: `drac-security-api:20261005-signed-license`.

## Distribuição sem checkout: implementada, ainda não promovida

`scripts/security/build-runtime-package.py` constrói pacote de imagens
pré-compiladas, configurações e scripts operacionais, com manifest Ed25519.
Central oferece autorização temporária de download de uso único; bootstrap
fixado por hash confere assinatura/hashes/commit antes de executar o instalador.
Não há Git, build local, Central ou chave emissora no pacote do cliente.

O atualizador verifica pacote e versão de segurança, preserva overlays,
verifica backup do PostgreSQL antes da troca e retorna às imagens anteriores
se a saúde reprovar. Não restaura um banco antigo sobre dados novos. Mudança
de schema exige migração aprovada separadamente.

API candidata contém JS compilado e migrations, não TypeScript/mapas. IA
candidata contém módulos nativos Cython, não nossos `.py`/`.pyc`/C gerados.
Auditoria de TODAS as camadas das imagens: API 12, IA 8, arquivos proibidos=[]
em ambas. Código de terceiros/licenças permanece distribuído conforme seus
termos. Compilação dificulta engenharia reversa; não esconde código de root.

A IA nativa **não foi publicada**. As instalações existentes ainda possuem
checkout/IA antiga; nada disso foi apagado. O repositório público **não foi
fechado**, e cópias já distribuídas não podem ser recolhidas.

Não foi promovida uma nova release nem trocado o instalador padrão da Central.
Antes disso: confirmar direitos de distribuição, construir o pacote completo,
executar instalação/atualização em VM limpa sem GitHub e validar saúde, vídeo,
gravação e comportamento/performance da IA nativa. Testes com transporte e
Docker simulados abaixo NÃO são esse teste de VM real.

## Testes realizados

| Bateria | Resultado |
| --- | --- |
| API completa | 1703 total: 1701 aprovados, 0 falhas, 2 skipped; 148,3 s |
| Central completa | 531 total: 518 aprovados, 0 falhas, 13 skipped; 108,2 s |
| Pacote/assinatura/lifecycle isolado | 11 aprovados, 0 falhas |
| Rollback do atualizador anterior | 6 aprovados, 0 falhas |
| Instalador — bateria shell existente | Todos aprovados |
| IA nativa — matriz funcional | 168 total: 164 aprovados, 4 skipped |
| Casos fonte/reload não aplicáveis ao nativo, executados no fonte | 5 aprovados |
| TypeScript/build/sintaxe shell/Python/diff-check | Aprovados |

Matriz adversarial: assinatura alterada, emissor desconhecido, dispositivo/
instalação/nonce diferentes, repetição, inundação de provas, geração/sequência
antigas, expiração, limites/recursos malformados e adulteração do banco local.
HTTP real da Central foi exercitado em instâncias isoladas temporárias.

Quatro testes nativos pulados exigiam AST do `.py` ou reload de extension já
carregada; executados separadamente no fonte, com teste adicional do ambiente
em processo nativo novo. Não são quatro falhas ocultadas.

A suíte inicialmente encontrou um mock de permissões desatualizado para
`groupId: {in: [...]}`. Só o mock foi corrigido; lógica de acesso não foi alterada.

## Bloqueios que exigem informação/infraestrutura

1. **Acesso à Management:** os acessos fornecidos reutilizam a mesma senha em
   Central e clientes. Uma senha conhecida pelo cliente ameaça a própria chave
   emissora. Falta a chave pública SSH da equipe para validar acesso independente
   e então desativar senha e rotacionar credenciais sem bloquear a operação.
   Não houve alteração de SSH nem criação de senha universal.
2. **Direitos do YOLO:** confirmar licença Enterprise aplicável ou a distribuição
   sob AGPL. A [política oficial da Ultralytics](https://www.ultralytics.com/license)
   distingue os dois caminhos. Não foi presumido que existe contrato comercial.
3. **Hardware:** guest Vibe apresenta Xeon E5-2640 v2/KVM, sem dispositivo de
   atestação exposto no diagnóstico. Isso não inventaria o host físico.
   Não há evidência de TDX/SEV-SNP homologado na frota. Núcleo confidencial,
   atestação remota, chaves liberadas ao ambiente medido e proteção contra
   snapshot/relógio exigem plataforma compatível e piloto real.
4. **CI/cofre:** não foi criada infraestrutura externa de CI/registro nem acesso
   da equipe a cofre por falta de provedor/credenciais autorizadas. A entrega
   privada implementada usa a Central e sua autorização temporária, não um
   registro público. Chave de assinatura de release separada deve ficar no
   ambiente de build do fornecedor, nunca no cliente.

## Operação e recuperação

- Preservar diretórios protegidos de identidade e todos os overlays novos.
  Não restaurar banco antigo para tentar voltar apenas a imagem da API.
- Não voltar para uma API que ignore assinatura; isso reabre a vulnerabilidade.
- Nova matrícula exige administrador na Central, instalação confirmada e motivo
  registrado em `POST /api/admin/installations/:id/security/device-reset`.
  Uma máquina offline conserva autorização antiga até o vencimento; revogação
  remota instantânea não é prometida offline.
- Backups prévios e imagens anteriores foram mantidos. Cópias dos atualizadores
  antigos estão em `infra/backups/security-updaters-20261005` em IB/Dguardian.
- Atualizações Git automáticas dessas instalações agora são recusadas. Até
  promover o pacote novo, publicação deve seguir a migração controlada de
  imagens/overlays usada aqui, com pré-validação e backup. Isso deve ser
  comunicado à equipe; não há atualização automática silenciosamente liberada.

Conclusão: controle de licença real está publicado. Proteção forte contra root,
distribuição fechada completa e migração sem checkout ainda NÃO estão concluídas.
