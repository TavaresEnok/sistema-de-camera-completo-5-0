# Câmeras privadas pelo navegador — validação e publicação

Versão da aplicação: `e5a3ea66fae1dd270c02cd7848721665b5ce87ee`. Interface: `private-cameras-20261008`.

Uso: administrador → cadastro de câmera RTSP/RTMP ou Editar câmera → Geral → Câmera privada. Escolher proprietário ativo e, opcionalmente, outras pessoas autorizadas. Mudanças na privacidade exigem confirmação; também afetam o acesso às gravações antigas. Câmeras comuns continuam com permissões normais, não ficam públicas na internet.

## Evidências

- API: compilação aprovada, 1.750 testes aprovados, dois opcionais ignorados, zero falhas. Interface: checagem de tipos, build e 574 testes aprovados. Renderização React real: opção comum, opção privada, proprietário obrigatório, usuários adicionais opcionais e rótulos acessíveis. Não foi uma rodada de cliques em navegador/aparelho físico.
- Laboratório Docker novo, separado de produção: API/banco reais, 70 migrações e nenhuma migração nova de privacidade. Cadastro RTSP e RTMP por HTTP; proprietário/delegado acessam; administrador e grupo sem concessão individual não acessam conteúdo. Lista do seletor revela apenas ID, nome e login.
- Gravações, eventos, avisos e miniaturas bloqueados para quem não tem acesso. Tokens antigos de vídeo e reprodução deixam de autorizar após retirar usuário. Uma sessão RTSP real aberta foi encerrada ao converter comum em privada. Troca de proprietário revoga o anterior; alteração concorrente de permissões retorna 409. Confirmação ausente retorna 400.
- Modo manual, gravação desativada, registro de gravação existente e chave de publicação RTMP preservados no laboratório. Sem alteração de resolução, FPS ou modelo.
- Seis reproduções HLS reais com quadros avançando (fontes sintéticas: vídeo normal, B-frames e áudio inválido, cada um em grid e individual). Avisos anteriores de movimento/objeto repetidos, duas inferências YOLO reais sem erro. Isso não mede precisão física de câmeras de clientes.
- Imagens API/web e pacote completo tiveram todas as camadas verificadas: nenhum arquivo-fonte proibido. Publicação usa a imagem API protegida, não o Dockerfile legado de desenvolvimento. Tentativa de pacote com seed.ts foi rejeitada pela auditoria, nunca distribuída; o pacote final passou após usar o construtor protegido.
- Pacote completo assinado e verificado, aprovado via API da Central para Vibe, IB Telecom e Dguardian e como padrão para novas instalações. Central não foi reiniciada/recompilada; seu catálogo de pacote foi atualizado. Demo e APK excluídos.

## Preservação em produção

Publicação concluída nas três instalações. API pronta e seletor de usuários respondendo 200 em Vibe, IB Telecom e Dguardian; interface pública com `private-cameras-20261008`. Digests antes/depois idênticos e assinaturas completas verificadas. A transferência para a Dguardian foi concluída antes de aplicar o pacote (200.406.016 bytes, aproximadamente 206 KB/s).

Baseline e resultado em `infra/backups/private-cameras-20261008/`. Backups completos do banco e sobreposições de imagens em `infra/backups/viewing-updates/e5a3ea66fae1dd270c02cd7848721665b5ce87ee/` (ou sufixo de nova tentativa).

- Vibe: 35 câmeras, zero privadas antes da publicação; digest de cadastro/permissões `8c9cd686c56585ab16d6d62bc488a3cebdc738d9fb0e6a4dae42abfc2fe7c320`.
- IB Telecom: 27 câmeras, zero privadas antes da publicação; digest `6cc618b1fa6b54e6babbd02d196d2fc2a09acc6da8bab110724fb8406bc635d9`.
- Dguardian: três câmeras, zero privadas antes da publicação; digest `7eaaa10c2a8dd1cc1ca7e451c7221c644d3a46cfe6949b9fdae06a924bbb1d70`.

Os digests incluem credenciais cifradas, chaves RTMP, modo/permissão de gravação, detecção, permissões individuais/de grupo e proprietário; nenhum segredo é impresso. IA, MediaMTX e recebimento RTMP mantêm identidade de imagem e horário de início. Nenhuma câmera foi tornada privada automaticamente.

Evidências completas na Management: `runtime-artifacts/private-api-tests-20261008.log`, `private-web-tests-20261008.log`, `private-react-render-20261008.log`, `private-fresh-lab-20261008.json`, `private-packages-20261008.log` e `private-central-approval-20261008.log`.

Limite: privacidade é controle de acesso no sistema, não proteção contra root/controle total do servidor. Administrador ainda pode alterar acessos explicitamente, com auditoria. Conteúdo já recebido ou copiado não pode ser recolhido.
