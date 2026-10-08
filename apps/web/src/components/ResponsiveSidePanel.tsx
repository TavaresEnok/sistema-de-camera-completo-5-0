import { motion, type HTMLMotionProps } from 'framer-motion';
import type { ReactNode } from 'react';
import { useCompactLayout } from '../hooks/use-compact-layout';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

type Props = Omit<HTMLMotionProps<'aside'>, 'children'> & { children: ReactNode; title: string; onClose: () => void };

/** Uma única árvore de conteúdo: o painel não cria uma segunda conexão de vídeo. */
export function ResponsiveSidePanel({ title, onClose, children, ...desktop }: Props) {
  const compact = useCompactLayout();
  if (compact) return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent className="responsive-side-panel flex w-full flex-col gap-0 p-0 pt-12 sm:max-w-md" aria-describedby={undefined}>
      <SheetTitle className="sr-only">{title}</SheetTitle>
      {children}
    </SheetContent>
  </Sheet>;
  return <motion.aside {...desktop}>{children}</motion.aside>;
}
