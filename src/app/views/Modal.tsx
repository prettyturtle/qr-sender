/**
 * The app's modal shell, built on `<dialog>`.
 *
 * Shared rather than repeated because all three of the things it gets right are
 * things that are easy to get wrong, and getting them wrong in only one of two
 * dialogs is worse than getting them wrong in both.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, className, children }: ModalProps): JSX.Element {
  const t = useT();
  // Callback ref rather than `useRef`: mounting has to trigger the effect that
  // calls `showModal`, and a ref object does not re-render when it is filled.
  const [el, setEl] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (el === null) return;
    if (open && !el.open) {
      el.showModal();
      // `showModal` focuses the first focusable descendant, which lands on a
      // text field or a select and — on a phone — opens the keyboard over the
      // dialog that was just opened. Moving focus to the dialog itself keeps
      // Escape and tab order working without putting a caret anywhere.
      el.focus();
    }
    if (!open && el.open) el.close();
  }, [open, el]);

  return (
    <dialog
      ref={setEl}
      // Focusable, but not in the tab order: `el.focus()` above needs a target,
      // and without this the browser would refuse and fall back to the field.
      tabIndex={-1}
      className={className}
      onClose={onClose}
      onMouseDown={(event) => {
        // A backdrop click reports the dialog element as its target — but so
        // does a click on the dialog's own padding, or on the gap between two
        // sections. Comparing targets alone therefore closes the dialog when
        // the user clicks inside it, which is the bug this replaces. The
        // backdrop is by definition outside the dialog's box, so compare
        // against the box.
        if (event.target !== el || el === null) return;
        const box = el.getBoundingClientRect();
        const inside =
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom;
        if (!inside) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
              d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      {children}
    </dialog>
  );
}
