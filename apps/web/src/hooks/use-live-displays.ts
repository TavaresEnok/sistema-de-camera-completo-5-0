import { useCallback, useEffect, useRef, useState } from 'react';
import { type LiveDisplayId, liveDisplayLabel } from '../store/gridStore';
import { findCameraDisplay, type LiveDisplayPresence } from '../lib/live-display-coordination';
import { useAuthStore } from '../store/authStore';

const CHANNEL = 'drac.live.displays.v1';
const PRESENCE_PREFIX = 'drac.live.display.presence.';
const COMMAND_KEY = 'drac.live.display.command';
type DisplayMessage =
  | { type: 'presence'; payload: LiveDisplayPresence }
  | { type: 'remove-camera'; target: LiveDisplayId; targetInstance: string; cameraId: string; nonce: string }
  | { type: 'removed'; nonce: string; instanceId: string };

function validPresence(value: unknown): value is LiveDisplayPresence {
  const item = value as LiveDisplayPresence;
  return !!item && ['main', 'aux-1', 'aux-2', 'aux-3'].includes(item.displayId)
    && typeof item.instanceId === 'string' && Number.isFinite(item.openedAt)
    && Array.isArray(item.cameraIds) && item.cameraIds.every(id => typeof id === 'string')
    && Number.isFinite(item.updatedAt);
}

export function useLiveDisplays(displayId: LiveDisplayId, cameraIds: string[], removeCamera: (cameraId: string) => void) {
  const userId = useAuthStore(state => state.user?.id ?? 'anonymous');
  const channelName = `${CHANNEL}.${userId}`;
  const presencePrefix = `${PRESENCE_PREFIX}${userId}.`;
  const commandKey = `${COMMAND_KEY}.${userId}`;
  const [displays, setDisplays] = useState<Record<string, LiveDisplayPresence>>({});
  const [isSuperseded, setIsSuperseded] = useState(false);
  const identityRef = useRef({ instanceId: crypto.randomUUID(), openedAt: Date.now() });
  const supersededRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const removeRef = useRef(removeCamera);
  removeRef.current = removeCamera;
  const cameraIdsRef = useRef(cameraIds);
  cameraIdsRef.current = cameraIds;
  const seenPresence = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, { instanceId: string; finish: (ok: boolean) => void }>());
  const incoming = useRef(new Map<string, string>());
  const moveOwners = useRef(new Map<string, string>());
  const [, changed] = useState(0);
  const send = useCallback((message: DisplayMessage) => {
    try { channelRef.current?.postMessage(message); } catch { /* Canal encerrado. */ }
    try { window.localStorage.setItem(commandKey, JSON.stringify(message)); } catch { /* BroadcastChannel continua disponível. */ }
  }, [commandKey]);

  const receive = useCallback((message: DisplayMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'presence' && validPresence(message.payload)) {
      const seen = seenPresence.current.get(message.payload.instanceId) ?? 0;
      if (message.payload.updatedAt < seen || Date.now() - message.payload.updatedAt > 8_000) return;
      seenPresence.current.set(message.payload.instanceId, message.payload.updatedAt);
      if (message.payload.displayId === displayId && message.payload.instanceId !== identityRef.current.instanceId) {
        const ours = identityRef.current;
        const theirsWins = message.payload.openedAt > ours.openedAt
          || (message.payload.openedAt === ours.openedAt && message.payload.instanceId > ours.instanceId);
        if (theirsWins) { supersededRef.current = true; setIsSuperseded(true); }
        return;
      }
      // Duas telas podem adicionar/restaurar a mesma câmera antes do heartbeat.
      // A instância que abriu primeiro vence; mover continua usando confirmação.
      const ours = identityRef.current;
      if (message.payload.displayId !== displayId && (message.payload.openedAt < ours.openedAt
        || (message.payload.openedAt === ours.openedAt && message.payload.instanceId < ours.instanceId))) {
        for (const cameraId of message.payload.cameraIds) {
          if (cameraIdsRef.current.includes(cameraId)) removeRef.current(cameraId);
        }
      }
      setDisplays(current => {
        const existing = current[message.payload.displayId];
        if (existing && existing.openedAt > message.payload.openedAt) return current;
        return { ...current, [message.payload.displayId]: message.payload };
      });
    }
    if (message.type === 'remove-camera' && message.target === displayId
      && message.targetInstance === identityRef.current.instanceId && !supersededRef.current
      && typeof message.cameraId === 'string' && typeof message.nonce === 'string') {
      const owner = moveOwners.current.get(message.cameraId);
      if (owner && owner !== message.nonce) return;
      moveOwners.current.set(message.cameraId, message.nonce);
      incoming.current.set(message.nonce, message.cameraId);
      removeRef.current(message.cameraId);
      changed(value => value + 1);
    }
    if (message.type === 'removed') {
      const request = pending.current.get(message.nonce);
      if (request?.instanceId === message.instanceId) request.finish(true);
    }
  }, [displayId]);

  useEffect(() => {
    setDisplays({});
    supersededRef.current = false;
    setIsSuperseded(false);
    identityRef.current = { instanceId: crypto.randomUUID(), openedAt: Date.now() };
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName) : null;
    channelRef.current = channel;
    if (channel) channel.onmessage = event => receive(event.data as DisplayMessage);
    const onStorage = (event: StorageEvent) => {
      if (!event.newValue) return;
      try {
        if (event.key?.startsWith(presencePrefix)) receive({ type: 'presence', payload: JSON.parse(event.newValue) });
        if (event.key === commandKey) receive(JSON.parse(event.newValue));
      } catch { /* mensagem de outra versão é ignorada */ }
    };
    window.addEventListener('storage', onStorage);
    for (const id of ['main', 'aux-1', 'aux-2', 'aux-3'] as LiveDisplayId[]) {
      try {
        const raw = window.localStorage.getItem(presencePrefix + id);
        if (raw) receive({ type: 'presence', payload: JSON.parse(raw) });
      } catch { /* cache corrompido não impede o ao vivo */ }
    }
    return () => {
      channel?.close(); channelRef.current = null; window.removeEventListener('storage', onStorage);
      for (const request of pending.current.values()) request.finish(false);
      incoming.current.clear();
      moveOwners.current.clear();
      seenPresence.current.clear();
    };
  }, [receive, channelName, presencePrefix, commandKey]);

  // Confirma somente depois do commit que removeu e desmontou o player anterior.
  useEffect(() => {
    for (const [cameraId, nonce] of moveOwners.current) {
      if (cameraIds.includes(cameraId) && !incoming.current.has(nonce)) moveOwners.current.delete(cameraId);
    }
    for (const [nonce, cameraId] of incoming.current) {
      if (cameraIds.includes(cameraId)) continue;
      send({ type: 'removed', nonce, instanceId: identityRef.current.instanceId });
      incoming.current.delete(nonce);
    }
  });

  useEffect(() => {
    const publish = () => {
      if (supersededRef.current) return;
      const payload: LiveDisplayPresence = { displayId, ...identityRef.current, cameraIds: cameraIds.filter(Boolean), updatedAt: Date.now() };
      try { window.localStorage.setItem(presencePrefix + displayId, JSON.stringify(payload)); } catch { /* Cache opcional. */ }
      channelRef.current?.postMessage({ type: 'presence', payload } satisfies DisplayMessage);
      setDisplays(current => ({ ...current, [displayId]: payload }));
    };
    publish();
    const timer = window.setInterval(publish, 2_500);
    return () => {
      window.clearInterval(timer);
      try {
        const raw = window.localStorage.getItem(presencePrefix + displayId);
        const current = raw ? JSON.parse(raw) as LiveDisplayPresence : null;
        if (current?.displayId === displayId && current.instanceId === identityRef.current.instanceId) window.localStorage.removeItem(presencePrefix + displayId);
      } catch { /* Cache opcional. */ }
    };
  }, [displayId, cameraIds, presencePrefix]);

  const moveFromOtherDisplay = useCallback((target: LiveDisplayId, cameraId: string) => {
    const instanceId = displays[target]?.instanceId;
    if (!instanceId) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const nonce = crypto.randomUUID();
      const finish = (ok: boolean) => { window.clearTimeout(timer); pending.current.delete(nonce); resolve(ok); };
      const timer = window.setTimeout(() => finish(false), 8_000);
      pending.current.set(nonce, { instanceId, finish });
      send({ type: 'remove-camera', target, targetInstance: instanceId, cameraId, nonce });
    });
  }, [displays, send]);

  return {
    displays,
    isSuperseded,
    findCameraDisplay: (cameraId: string) => findCameraDisplay(displays, cameraId, displayId),
    moveFromOtherDisplay,
    label: liveDisplayLabel(displayId),
  };
}
