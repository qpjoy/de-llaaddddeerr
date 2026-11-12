import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';

export default function Modal({
  title,
  children,
  onClose,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      trigger?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`mincave-modal ${className}`}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mincave-modal-title">
        <h2>{title}</h2>
        <button className="mincave-icon-button" onClick={onClose} aria-label="关闭弹窗">
          <Icon name="x" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
