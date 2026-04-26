import { useId, type ReactNode } from 'react';

interface Props {
  label: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  /** A render prop receives the auto-generated id so children can wire `id`/`htmlFor`/`aria-describedby`. */
  children: (ids: { id: string; helperId: string; errorId: string }) => ReactNode;
  required?: boolean;
}

export function Field({ label, helper, error, required, children }: Props) {
  const baseId = useId();
  const id = `${baseId}-input`;
  const helperId = `${baseId}-helper`;
  const errorId = `${baseId}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-[var(--color-text)]">
        {label}
        {required ? <span className="ml-0.5 text-[var(--color-fail)]">*</span> : null}
      </label>
      {children({ id, helperId, errorId })}
      {error ? (
        <p id={errorId} className="text-[12px] text-[var(--color-fail)]">
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-[12px] text-[var(--color-text-muted)]">
          {helper}
        </p>
      ) : null}
    </div>
  );
}
