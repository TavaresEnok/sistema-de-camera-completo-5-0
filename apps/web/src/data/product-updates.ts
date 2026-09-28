export type ProductUpdate = {
  version: string;
  date: string;
  title: string;
  summary: string;
  kind: 'Novo' | 'Melhoria' | 'Segurança';
  items: string[];
};

/**
 * Catálogo editorial da instalação. Só entram entregas disponíveis no produto;
 * ideias e itens ainda em desenvolvimento não aparecem como se estivessem prontos.
 */
export const PRODUCT_UPDATES: ProductUpdate[] = [
  {
    version: '2026.08.27', date: '2026-08-27', kind: 'Novo',
    title: 'Mapa operacional e câmera no contexto',
    summary: 'As câmeras agora podem ser posicionadas na planta real de cada unidade e andar.',
    items: ['Abertura da câmera ao vivo sobre o mapa', 'Envio da planta e posicionamento visual', 'Acesso ao mapa respeitando as permissões de câmera'],
  },
  {
    version: '2026.08.26', date: '2026-08-26', kind: 'Melhoria',
    title: 'Câmeras e inteligência mais simples',
    summary: 'As telas técnicas foram reorganizadas para explicar o efeito de cada escolha.',
    items: ['ID operacional curto por câmera', 'Protocolo, consumo de armazenamento e retenção na listagem', 'Confiança da IA em porcentagem por câmera'],
  },
  {
    version: '2026.08.25', date: '2026-08-25', kind: 'Melhoria',
    title: 'Vídeo ao vivo mais estável',
    summary: 'A reprodução foi aprimorada para manter a imagem estável e aproveitar melhor os recursos disponíveis.',
    items: ['Preferência pelo vídeo original quando o navegador é compatível', 'Recuperação por câmera sem interromper as demais', 'Reconexão quando a transmissão para de avançar'],
  },
  {
    version: '2026.08.24', date: '2026-08-24', kind: 'Segurança',
    title: 'Licença, backup e recuperação',
    summary: 'O controle comercial e a proteção das configurações passaram a ter regras explícitas.',
    items: ['Teto contratado de câmeras aplicado no cadastro', 'Arquivo de cancelamento protegido e com validade', 'Exclusão automática de arquivos vencidos'],
  },
  {
    version: '2026.08.23', date: '2026-08-23', kind: 'Novo',
    title: 'Envio de vídeo pela câmera',
    summary: 'Câmeras em redes restritas podem enviar vídeo diretamente ao sistema, com configuração da equipe técnica.',
    items: ['Chave curta de publicação', 'Vinculação de caminhos fixos enviados pelo equipamento', 'Mesmas regras de vídeo ao vivo, movimento e gravação'],
  },
];
