"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      // Focus the cancel button by default for safety
      confirmRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Close on backdrop click
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === dialogRef.current) {
        onCancel();
      }
    },
    [onCancel],
  );

  // Close on Escape
  const handleCancel = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      onCancel();
    },
    [onCancel],
  );

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog-backdrop"
      onClick={handleClick}
      onCancel={handleCancel}
    >
      <div className="confirm-dialog">
        <h3 className="confirm-dialog-title">{title}</h3>
        <p className="confirm-dialog-description">{description}</p>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="button ghost"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`button ${variant === "danger" ? "danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

type ConfirmState = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  variant: "danger" | "default";
  onConfirm: () => void;
};

const EMPTY_STATE: ConfirmState = {
  open: false,
  title: "",
  description: "",
  confirmLabel: "Confirm",
  variant: "default",
  onConfirm: () => {},
};

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>(EMPTY_STATE);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback(
    (options: {
      title: string;
      description: string;
      confirmLabel?: string;
      variant?: "danger" | "default";
    }): Promise<boolean> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        setState({
          open: true,
          title: options.title,
          description: options.description,
          confirmLabel: options.confirmLabel ?? "Confirm",
          variant: options.variant ?? "default",
          onConfirm: () => {
            setState(EMPTY_STATE);
            resolveRef.current = null;
            resolve(true);
          },
        });
      });
    },
    [],
  );

  const cancel = useCallback(() => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setState(EMPTY_STATE);
    resolve?.(false);
  }, []);

  const dialogProps = {
    open: state.open,
    title: state.title,
    description: state.description,
    confirmLabel: state.confirmLabel,
    variant: state.variant,
    onConfirm: state.onConfirm,
    onCancel: cancel,
  };

  return { confirm, dialogProps };
}
