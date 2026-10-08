import { useSyncExternalStore } from 'react';

const query = '(max-width: 1199px)';
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia(query).matches;
const serverSnapshot = () => false;

/** Menus sobrepostos em celular/tablet; muda só ao cruzar o breakpoint. */
export function useCompactLayout() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
