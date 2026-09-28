import { useEffect, useRef } from 'react';
import { confirmAction } from '../components/ActionConfirmation';

const unsavedPages = new Set<symbol>();
export async function confirmNavigation() {
  return !unsavedPages.size || await confirmAction({ title: 'Sair sem salvar?', description: 'As alterações feitas nesta página serão descartadas.', confirmLabel: 'Sair sem salvar', destructive: true });
}

export function useUnsavedChanges(dirty: boolean) {
  const leaving = useRef(false);
  const registration = useRef(Symbol('unsaved-page'));
  useEffect(() => {
    const id = registration.current;
    if (dirty) unsavedPages.add(id);
    return () => { unsavedPages.delete(id); };
  }, [dirty]);
  useEffect(() => {
    leaving.current = false;
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { if (!leaving.current) { event.preventDefault(); event.returnValue = ''; } };
    const navigate = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = (event.target as Element)?.closest?.('a');
      if (!link || link.target === '_blank' || link.hasAttribute('download') || link.href === window.location.href) return;
      event.preventDefault(); event.stopPropagation();
      const href = link.href;
      void confirmAction({ title: 'Sair sem salvar?', description: 'As alterações feitas nesta página serão descartadas.', confirmLabel: 'Sair sem salvar', destructive: true }).then((accepted) => {
        if (accepted) { leaving.current = true; window.location.assign(href); }
      });
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigate, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigate, true); };
  }, [dirty]);
}
