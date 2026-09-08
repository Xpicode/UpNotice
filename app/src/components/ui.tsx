import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../icons';
import { useStore } from '../store';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  // Rendered at the top level of the page (a portal) so no parent card's transform/animation
  // can push it behind the bottom tab bar or shift it around.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onClick={(e) => e.stopPropagation()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn ghost icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function Confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={title} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 18 }}>
        {message}
      </p>
      {error && (
        <div className="error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className={`btn ${danger ? 'danger' : 'primary'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError((err as Error).message || 'Something went wrong');
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

export function Toast() {
  const { toastMsg } = useStore();
  if (!toastMsg) return null;
  return (
    <div className="toast" role="status">
      {toastMsg}
    </div>
  );
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty">
      {icon}
      <div className="title">{title}</div>
      {hint && <p className="small">{hint}</p>}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

/** Grey placeholder lines shown while a list loads (calmer than a spinner, keeps the layout still). */
export function Skeleton({ lines = 3, card = false }: { lines?: number; card?: boolean }) {
  const rows = Array.from({ length: lines }, (_, i) => <span key={i} className="skeleton line" style={{ width: `${[92, 70, 84, 60, 76][i % 5]}%` }} />);
  return (
    <div className={card ? 'card skeleton-card' : 'skeleton-block'} aria-busy="true" aria-label="Loading">
      {rows}
    </div>
  );
}

/** A few placeholder cards for list screens. */
export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="stagger" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} card lines={2} />
      ))}
    </div>
  );
}

/** A number that counts up from 0 the first time it appears (and jumps on later changes). Respects reduced motion. */
export function CountUp({ value, suffix = '' }: { value: number | null | undefined; suffix?: string }) {
  const [shown, setShown] = useState<number | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (value === null || value === undefined) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!first.current || reduce || value === 0) {
      setShown(value);
      first.current = false;
      return;
    }
    first.current = false;
    const start = performance.now();
    const dur = 600;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (value === null || value === undefined) return <>–</>;
  return (
    <>
      {(shown ?? 0).toLocaleString()}
      {suffix}
    </>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
}

export function PriorityChip({ priority }: { priority: 'normal' | 'important' | 'urgent' }) {
  if (priority === 'urgent')
    return (
      <span className="chip danger">
        <i className="dot" />
        Urgent
      </span>
    );
  if (priority === 'important')
    return (
      <span className="chip warn">
        <i className="dot" />
        Important
      </span>
    );
  return null;
}

/** A selectable chip (filter, picker). A real button so it works with a keyboard and screen readers. */
export function ChipButton({ active, onClick, children, className = '' }: { active: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`chip pick ${active ? 'active' : ''} ${className}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

export interface Audience {
  company_id: number | null; // null = all companies
  department_ids: number[]; // empty = every department in the chosen company
}

/** "Send to" picker: choose a company (or all), then optionally narrow to departments of that company. */
export function AudiencePicker({ value, onChange }: { value: Audience; onChange: (a: Audience) => void }) {
  const { companies, departments, user } = useStore();
  // Managers can only send to their own company.
  const locked = user?.role === 'manager' ? user.company_id : null;
  useEffect(() => {
    if (locked !== null && value.company_id !== locked) onChange({ company_id: locked, department_ids: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);
  const depts = departments.filter((d) => d.company_id === value.company_id);
  const toggleDept = (id: number) =>
    onChange({
      ...value,
      department_ids: value.department_ids.includes(id) ? value.department_ids.filter((x) => x !== id) : [...value.department_ids, id],
    });
  return (
    <>
      <div className="field">
        <label>Send to company</label>
        {locked !== null ? (
          <div className="dept-pick">
            <span className="chip accent">{user?.company_name || 'My company'}</span>
            <span className="tiny muted" style={{ alignSelf: 'center' }}>
              Managers post to their own company.
            </span>
          </div>
        ) : (
          <div className="dept-pick" role="group" aria-label="Company">
            <ChipButton active={value.company_id === null} onClick={() => onChange({ company_id: null, department_ids: [] })}>
              All companies
            </ChipButton>
            {companies.map((c) => (
              <ChipButton key={c.id} active={value.company_id === c.id} onClick={() => onChange({ company_id: c.id, department_ids: [] })}>
                {c.name}
              </ChipButton>
            ))}
          </div>
        )}
        {companies.length === 0 && <p className="tiny muted">No companies yet — add them in People → Companies.</p>}
      </div>
      {value.company_id !== null && (
        <div className="field">
          <label>Departments</label>
          <div className="dept-pick" role="group" aria-label="Departments">
            <ChipButton active={value.department_ids.length === 0} onClick={() => onChange({ ...value, department_ids: [] })}>
              Whole company
            </ChipButton>
            {depts.map((d) => (
              <ChipButton key={d.id} active={value.department_ids.includes(d.id)} onClick={() => toggleDept(d.id)}>
                {d.name}
              </ChipButton>
            ))}
          </div>
          {depts.length === 0 && <p className="tiny muted">This company has no departments yet.</p>}
        </div>
      )}
    </>
  );
}

/** Short label like "All companies", "SixthGear", or "Upright · Sales, Ops". */
export function audienceLabel(item: { company_name: string | null; targets: { name: string }[] }): string {
  if (!item.company_name) return 'All companies';
  if (item.targets.length === 0) return item.company_name;
  return `${item.company_name} · ${item.targets.map((t) => t.name).join(', ')}`;
}
