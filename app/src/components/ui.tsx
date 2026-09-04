import { useEffect, useState, type ReactNode } from 'react';
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
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.stopPropagation()}
    >
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
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
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
  return <div className="toast">{toastMsg}</div>;
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

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
}

export function PriorityChip({ priority }: { priority: 'normal' | 'important' | 'urgent' }) {
  if (priority === 'urgent') return <span className="chip danger">Urgent</span>;
  if (priority === 'important') return <span className="chip warn">Important</span>;
  return null;
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
            <span className="chip primary">{user?.company_name || 'My company'}</span>
            <span className="tiny muted" style={{ alignSelf: 'center' }}>Managers post to their own company.</span>
          </div>
        ) : (
          <div className="dept-pick">
            <span className={`chip ${value.company_id === null ? 'primary' : ''}`} onClick={() => onChange({ company_id: null, department_ids: [] })}>
              All companies
            </span>
            {companies.map((c) => (
              <span key={c.id} className={`chip ${value.company_id === c.id ? 'primary' : ''}`} onClick={() => onChange({ company_id: c.id, department_ids: [] })}>
                {c.name}
              </span>
            ))}
          </div>
        )}
        {companies.length === 0 && <p className="tiny muted">No companies yet — add them in People → Companies.</p>}
      </div>
      {value.company_id !== null && (
        <div className="field">
          <label>Departments</label>
          <div className="dept-pick">
            <span className={`chip ${value.department_ids.length === 0 ? 'primary' : ''}`} onClick={() => onChange({ ...value, department_ids: [] })}>
              Whole company
            </span>
            {depts.map((d) => (
              <span key={d.id} className={`chip ${value.department_ids.includes(d.id) ? 'primary' : ''}`} onClick={() => toggleDept(d.id)}>
                {d.name}
              </span>
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
