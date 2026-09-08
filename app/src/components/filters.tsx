// Search box + filter chips + "More filters" sheet, shared by the Announcements and Meetings lists.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { ChipButton, Sheet } from './ui';
import { SearchIcon, FilterIcon, CloseIcon } from '../icons';

export type ListFilters = { q: string; category: string; company_id: number | null; department_id: number | null; from: string; to: string };
export const EMPTY_FILTERS: ListFilters = { q: '', category: '', company_id: null, department_id: null, from: '', to: '' };

/** Waits until the user stops typing before reporting the value (so we don't call the server on every key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FilterBar({
  value,
  onChange,
  categories,
  placeholder = 'Search…',
  children,
}: {
  value: ListFilters;
  onChange: (f: ListFilters) => void;
  categories?: string[];
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const { companies, departments, user } = useStore();
  const [open, setOpen] = useState(false);
  const canPickCompany = user?.role === 'admin' && companies.length > 1;
  const companyForDepts = value.company_id ?? (user?.role === 'admin' ? null : (user?.company_id ?? null));
  const depts = departments.filter((d) => companyForDepts === null || d.company_id === companyForDepts);
  const activeCount = (value.company_id ? 1 : 0) + (value.department_id ? 1 : 0) + (value.from ? 1 : 0) + (value.to ? 1 : 0);

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="search">
          <SearchIcon />
          <input className="input" placeholder={placeholder} value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} aria-label={placeholder} />
          {value.q && (
            <button type="button" className="btn ghost icon-btn" onClick={() => onChange({ ...value, q: '' })} aria-label="Clear search">
              <CloseIcon />
            </button>
          )}
        </div>
        <button type="button" className={`btn ${activeCount ? 'primary' : ''}`} onClick={() => setOpen(true)} title="More filters">
          <FilterIcon /> <span className="desktop-only">Filters</span>
          {activeCount ? ` (${activeCount})` : ''}
        </button>
        {children}
      </div>
      {categories && categories.length > 0 && (
        <div className="dept-pick scroll-x" style={{ marginBottom: 12 }} role="group" aria-label="Topic">
          <ChipButton active={!value.category} onClick={() => onChange({ ...value, category: '' })}>
            All topics
          </ChipButton>
          {categories.map((c) => (
            <ChipButton key={c} active={value.category === c} onClick={() => onChange({ ...value, category: value.category === c ? '' : c })}>
              {c}
            </ChipButton>
          ))}
        </div>
      )}
      {open && (
        <Sheet title="Filters" onClose={() => setOpen(false)}>
          <div className="stack">
            {canPickCompany && (
              <div className="field">
                <label>Company</label>
                <select
                  className="select"
                  value={value.company_id ?? ''}
                  onChange={(e) => onChange({ ...value, company_id: e.target.value ? Number(e.target.value) : null, department_id: null })}
                >
                  <option value="">All companies</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label>Department</label>
              <select className="select" value={value.department_id ?? ''} onChange={(e) => onChange({ ...value, department_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Any department</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {companyForDepts === null ? `${d.company_name} · ${d.name}` : d.name}
                  </option>
                ))}
              </select>
              <p className="tiny muted">Only items sent specifically to that department.</p>
            </div>
            <div className="grid-2">
              <div className="field">
                <label>From</label>
                <input className="input" type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
              </div>
              <div className="field">
                <label>To</label>
                <input className="input" type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => onChange({ ...EMPTY_FILTERS, q: value.q, category: value.category })}>
                Clear
              </button>
              <button type="button" className="btn primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
