import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

/**
 * Overlays (dialog, sheet, popover, menu) start light (ADR-0186). Until one is first opened, its
 * content and the Radix presence machinery behind it are not mounted, and a popover's or menu's
 * trigger is a plain stand-in button rather than a positioning anchor. Both of those update their
 * state while React commits the page, which makes it re-render synchronously and run every effect on
 * the page in the same task as hydration: one long task on a phone, on every page with an overlay.
 */
interface OverlayState {
  opened: boolean;
  open: () => void;
}
const OverlayContext = React.createContext<OverlayState>({ opened: true, open: () => {} });
/** Whether the overlay around this component has been opened yet (true outside one). */
export const useOverlayOpened = () => React.useContext(OverlayContext).opened;

interface RootProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A Radix root that remembers whether it has been opened, for its trigger and content. */
export function openedOnce<P extends RootProps>(Root: React.ComponentType<P>, name: string) {
  function OverlayRoot(props: P) {
    const { open, defaultOpen, onOpenChange } = props;
    const controlled = open !== undefined;
    const [ownOpen, setOwnOpen] = React.useState(!!defaultOpen);
    const isOpen = controlled ? open : ownOpen;
    const [opened, setOpened] = React.useState(isOpen);
    // opened from outside (controlled): mount the content in this same render
    if (isOpen && !opened) setOpened(true);
    const change = React.useCallback(
      (next: boolean) => {
        if (next) setOpened(true);
        if (!controlled) setOwnOpen(next);
        onOpenChange?.(next);
      },
      [controlled, onOpenChange],
    );
    const state = React.useMemo(() => ({ opened, open: () => change(true) }), [opened, change]);
    return (
      <OverlayContext.Provider value={state}>
        <Root {...props} defaultOpen={undefined} open={isOpen} onOpenChange={change} />
      </OverlayContext.Provider>
    );
  }
  OverlayRoot.displayName = name;
  return OverlayRoot;
}

type TriggerProps = React.ComponentPropsWithoutRef<'button'> & { asChild?: boolean };

/**
 * A popover's or menu's trigger: a plain button that opens the overlay until it has been opened, then
 * the Radix trigger (which anchors the overlay's position to it).
 */
export function standInTrigger<T extends React.ElementType>(
  Trigger: T,
  popup: 'dialog' | 'menu',
  name: string,
): T {
  const Radix: React.ElementType = Trigger;
  const OverlayTrigger = React.forwardRef<HTMLButtonElement, TriggerProps>(
    function OverlayTrigger(props, ref) {
      const { opened, open } = React.useContext(OverlayContext);
      if (opened) return <Radix {...props} ref={ref} />;
      const { asChild, onClick, ...rest } = props;
      const Comp = asChild ? Slot : 'button';
      return (
        <Comp
          type={asChild ? undefined : 'button'}
          aria-haspopup={popup}
          aria-expanded={false}
          data-state="closed"
          {...rest}
          ref={ref}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            onClick?.(e);
            if (!e.defaultPrevented) open();
          }}
        />
      );
    },
  );
  OverlayTrigger.displayName = name;
  // the same props as the Radix trigger it stands in for
  return OverlayTrigger as unknown as T;
}
