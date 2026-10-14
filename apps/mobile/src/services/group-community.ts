export type CommunityGroup = { id: string; name: string; memberCount: number };
export type CommunityMessage = { id: string; body: string; kind: 'TEXT' | 'ALERT'; createdAt: string; expiresAt?: string; user: { id: string; name: string }; camera?: { id: string; name: string } | null };
export type PanicResult = { mensagem: CommunityMessage; enviadoPara: number; pushStatus: 'accepted' | 'failed' | 'no_devices' | 'cooldown' };

export function eligibleCommunityGroups(items: unknown): CommunityGroup[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.filter((g): g is CommunityGroup => {
    if (!g || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string'
      || !Number.isInteger(g.memberCount) || g.memberCount < 2 || seen.has(g.id)) return false;
    seen.add(g.id); return true;
  });
}

export function panicFeedback(result: Pick<PanicResult, 'pushStatus'>): string {
  switch (result.pushStatus) {
    case 'accepted': return 'Pedido registrado no chat e notificações encaminhadas. Isso não confirma que alguém já viu o aviso.';
    case 'cooldown': return 'Pedido registrado no chat. As notificações não foram repetidas porque houve outro pedido há pouco.';
    case 'no_devices': return 'Pedido registrado no chat. Não há aparelhos disponíveis para receber o aviso.';
    default: return 'Pedido registrado no chat, mas não foi possível enviar as notificações.';
  }
}

export function addCommunityMessage(items: CommunityMessage[], message: CommunityMessage) {
  return [message, ...items.filter(item => item.id !== message.id)]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
}

export function communityPollingAllowed(visible: boolean, appState: string | null) {
  return visible && appState === 'active';
}
