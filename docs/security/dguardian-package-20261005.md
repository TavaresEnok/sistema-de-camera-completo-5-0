# Dguardian: primeiro cliente local por pacote

Aplicado em 05/10/2026, 13:18–13:20 (America/Fortaleza).

## Resultado e evidências

- Runtime aprovado exclusivamente para Dguardian: `0d2e53f6f30882bd85f025856e0c3f5a59ae2ea5`.
- Pacote: 935436871 bytes, SHA-256 `6a3e187083ff36aa81078d184aa4b8abdc005b1c7c0b48d03af25b7732927b54`.
- Assinatura Ed25519 verificada antes da importação; chave privada de publicação somente na Management, com backup criptografado verificado.
- Auditoria: 61 camadas de imagens, zero arquivos proibidos encontrados.
- Migração verificou compatibilidade de schema e backup `pg_dump`/`pg_restore --list`; não restaurou nem alterou contas.
- Schema efetivamente distribuído: `57b29171f34c557f1bca565bef966f82b6a98ed966ca6ef13d8b04e7c7265295`, 66 migrações.
- HTTPS `/`: 200. `/api/health/ready`: ready, seis verificações OK. `/api/cameras` sem autenticação: 401.
- Um usuário ativo, nenhuma câmera; fingerprint das contas e senhas antes/depois idêntico: `d4449b3b29f33585cf91fd48209793ec966161db3615af5a9e12b95e81e160a9`.
- Licença ACTIVE, assinatura verified, sem último erro; movimento permitido, objeto não habilitado. Identidade existente preservada.
- IA carregada de `.so`, zero arquivos Python de negócio em `/app`; movimento configurado em 7 FPS.
- `.git`, aplicações, serviços, ferramentas e arquivos de autoria removidos do cliente; seis imagens antigas e cache de compilação removidos.
- Preservados: banco/volumes, storage/gravações, backups, modelos escolhidos, APK, configurações, identidade, HTTPS e TURN. Imagem compilada anterior mantida para recuperação.
- IDs e horários de início de MediaMTX, SRS, PostgreSQL e Redis permaneceram idênticos: nenhum desses serviços foi recriado.
- Watchdog em 13:20:26: status OK, issues=[], selfHealed=[], disco 13%. Alarme falso de IP público atrás do MikroTik corrigido com `DRAC_WEBRTC_HOST_NAT=true`.
- Atualizador sem Git: `Runtime já está na versão aprovada.` Central recebeu heartbeat com o commit correto; instalador vinculado a `signed-runtime`.

## Testes e limitações

Laboratório isolado com serviços Docker reais, banco novo e vídeo sintético RTSP, sem portas públicas: criação do administrador/login 201, painel 200, captura nativa, movimento 6,96 FPS, gravação H.264 640×360, HLS 200 e sinalização WHEP OPTIONS 204. Assinatura e schema da imagem conferidos. Relatório protegido na Management: `runtime-artifacts/dguardian-runtime-lab-report-final-20261005.json`.

Não equivale a uma instalação Ubuntu virgem pelo instalador completo. Não valida câmera física, vídeo WebRTC completo através do MikroTik/TURN, aparelho do cliente ou capacidade com várias câmeras; Dguardian tem zero câmeras cadastradas.

Testes específicos: bootstrap 2/2; segurança Python 12/12; piloto/versões da Central 12/12; instalação remota/concorrência 5/5. IA nativa: 164 aprovados, quatro casos de código-fonte ignorados. Última suíte ampla da Central: 518 aprovados, 13 ignorados, duas falhas de infraestrutura de teste por resolução do módulo SSH2. Os cinco testes dos arquivos afetados passaram após corrigir NODE_PATH. Uma rodada anterior em Alpine também não tinha Bash; nenhuma dessas falhas foi tratada como sucesso nem exigiu alteração de produção.

Correções reais encontradas: leitura assíncrona e limitada do stdin do administrador; lock PostgreSQL sem desserializar `void`; hash de schema limitado aos arquivos presentes na imagem (exclui SQL opcional); aprovação, instalador, atualização e indicador de versão respeitando o piloto por instalação. A sessão de simulação deve abrir a lease de visualização, como o navegador faz.

## Recuperação e proteção

Backups fora do cliente: `/opt/ajustcam-management/backups/dguardian-pre-package-20261005`, acesso protegido.

- Fonte/histórico: SHA-256 `ab123bbe50194a6807ce6ff824427210d0c8526e64e2b670a1b41a21b5a02023`.
- Imagens anteriores: SHA-256 `7447421c58b8ec9ed54feec1cbda3f49debaea9ebae174c7fde93d06b07cd9b8`.
- Arquivo antigo de transferência, também retirado de `/tmp` do cliente: SHA-256 `3f7f5d0a8721a0756beb7a21bcffe08788e44937abf96916c622c3109fc20f5a`.

Proteção comercial de software, não hardware confidencial: `hardwareProtected=false`. Código compilado/JavaScript, frontend e modelos continuam sujeitos a inspeção ou engenharia reversa por root hostil. A migração não apaga cópias anteriores nem torna um repositório previamente público secreto. Chaves de emissão/publicação nunca foram colocadas no cliente; sua identidade local existente permanece em configuração protegida. Senhas SSH não foram gravadas nem trocadas; falta uma chave independente da equipe para retirar a senha compartilhada sem perder acesso.

Manifestos expiram em 30 dias: publicar um pacote novamente validado/assinado antes de reutilizar um instalador expirado. Mudanças de schema continuam exigindo revisão explícita; rollback de aplicação não restaura estado antigo da licença/banco.
