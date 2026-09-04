// Admin-only: manage companies, departments and employees.
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Company, type Department, type ImportResult, type Role, type User } from '../api';
import { useLoader, useStore } from '../store';
import { Confirm, Sheet, Spinner } from '../components/ui';
import { BuildingIcon, EditIcon, PlusIcon, TrashIcon, UploadIcon, UsersIcon } from '../icons';
import { Avatar } from '../components/social';

const ADD_NEW = '__new__';

export function PeopleScreen() {
  const { user } = useStore();
  const isAdmin = user?.role === 'admin';
  const [view, setView] = useState<'people' | 'departments' | 'companies'>('people');
  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={view === 'people' ? 'active' : ''} onClick={() => setView('people')}><UsersIcon style={{ width: 16, height: 16, verticalAlign: '-3px', marginRight: 6 }} />Employees</button>
        <button className={view === 'departments' ? 'active' : ''} onClick={() => setView('departments')}>Departments</button>
        {isAdmin && <button className={view === 'companies' ? 'active' : ''} onClick={() => setView('companies')}><BuildingIcon style={{ width: 16, height: 16, verticalAlign: '-3px', marginRight: 6 }} />Companies</button>}
      </div>
      {!isAdmin && <p className="small muted" style={{ marginBottom: 12 }}>As a manager you see and manage the employees of <strong>{user?.company_name}</strong>.</p>}
      {view === 'people' && <UsersPanel />}
      {view === 'departments' && <DepartmentsPanel />}
      {view === 'companies' && <CompaniesPanel />}
    </>
  );
}

// =====================================================================
// Employees
// =====================================================================
function UsersPanel() {
  const { user: me, companies, toast, bump } = useStore();
  const { data, loading, error } = useLoader(() => api.users());
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState('');
  const [companyFilter, setCompanyFilter] = useState<number | 'all'>('all');
  const users = (data?.users || []).filter(
    (u) =>
      (companyFilter === 'all' || u.company_id === companyFilter || u.role === 'admin') &&
      (!q || u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setImporting(true)} title="Import from Excel / CSV"><UploadIcon /> Import</button>
        <button className="btn primary" onClick={() => setEditing('new')}><PlusIcon /> Add</button>
      </div>
      {companies.length > 1 && me?.role === 'admin' && (
        <div className="dept-pick" style={{ marginBottom: 12 }}>
          <span className={`chip ${companyFilter === 'all' ? 'primary' : ''}`} onClick={() => setCompanyFilter('all')}>All companies</span>
          {companies.map((c) => (
            <span key={c.id} className={`chip ${companyFilter === c.id ? 'primary' : ''}`} onClick={() => setCompanyFilter(c.id)}>{c.name}</span>
          ))}
        </div>
      )}
      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      <div className="card" style={{ padding: '4px 16px' }}>
        <div className="list">
          {!loading && users.length === 0 && <p className="muted small" style={{ padding: '12px 0' }}>No employees match.</p>}
          {users.map((u) => (
            <div className="list-item" key={u.id}>
              <Avatar userId={u.id} name={u.name} avatarUrl={u.avatar_url} grey={!u.active} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>{u.name}</span>
                  {u.role === 'admin' && <span className="chip primary">Admin</span>}
                  {u.role === 'manager' && <span className="chip primary">Manager</span>}
                  {!u.active && <span className="chip">Inactive</span>}
                </div>
                <div className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {u.email} · {u.role === 'admin' ? 'All companies' : [u.company_name, u.department_name].filter(Boolean).join(' · ') || 'No company'}
                </div>
              </div>
              {(me?.role === 'admin' || u.role === 'employee') && <button className="btn ghost icon-btn" onClick={() => setEditing(u)} aria-label="Edit"><EditIcon /></button>}
              {u.id !== me?.id && (me?.role === 'admin' || u.role === 'employee') && <button className="btn ghost icon-btn" onClick={() => setDeleting(u)} aria-label="Delete"><TrashIcon /></button>}
            </div>
          ))}
        </div>
      </div>

      {editing && <UserForm existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportSheet onClose={() => setImporting(false)} />}
      {deleting && (
        <Confirm title={`Remove ${deleting.name}?`} message="Their read receipts and RSVPs will be removed too. To keep history, deactivate the account instead." confirmLabel="Remove" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api.deleteUser(deleting.id); toast('User removed'); bump(); }} />
      )}
    </>
  );
}

function UserForm({ existing, onClose }: { existing?: User; onClose: () => void }) {
  const { companies, departments, toast, bump, reloadDepartments, user: me } = useStore();
  const [name, setName] = useState(existing?.name || '');
  const [email, setEmail] = useState(existing?.email || '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(existing?.role || 'employee');
  const [company, setCompany] = useState<number | ''>(existing?.company_id ?? (me?.role === 'manager' ? me.company_id ?? '' : companies.length === 1 ? companies[0].id : ''));
  const [dept, setDept] = useState<number | '' | typeof ADD_NEW>(existing?.department_id ?? '');
  const [newDeptName, setNewDeptName] = useState('');
  const [active, setActive] = useState(existing ? !!existing.active : true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSelf = existing?.id === me?.id;

  const companyDepts = departments.filter((d) => d.company_id === company);

  // Changing company resets the department (departments belong to one company).
  useEffect(() => {
    if (dept !== '' && dept !== ADD_NEW && !companyDepts.some((d) => d.id === dept)) setDept('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const company_id = role === 'admin' ? null : company === '' ? null : Number(company);
      if (role !== 'admin' && !company_id) throw new Error(`Choose a company for this ${role}`);

      // "+ Add new department" chosen: create it first, then use its id.
      let department_id: number | null = dept === '' || dept === ADD_NEW ? null : Number(dept);
      if (dept === ADD_NEW) {
        if (!newDeptName.trim()) throw new Error('Type a name for the new department');
        if (!company_id) throw new Error('Choose a company before adding a department');
        const r = await api.createDepartment(newDeptName.trim(), company_id);
        department_id = r.department.id;
      }

      if (existing) {
        await api.updateUser(existing.id, { name, email, role, company_id, department_id, active, ...(password ? { password } : {}) });
        toast('Employee updated');
      } else {
        await api.createUser({ name, email, password, role, company_id, department_id });
        toast('Employee added');
      }
      bump();
      reloadDepartments();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      reloadDepartments();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={existing ? 'Edit employee' : 'Add employee'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && <div className="error">{error}</div>}
        <div className="field"><label>Full name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></div>
        <div className="field"><label>Email (used to sign in)</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field">
          <label>{existing ? 'New password (leave blank to keep)' : 'Password'}</label>
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required={!existing} minLength={6} placeholder={existing ? '••••••' : 'At least 6 characters'} autoComplete="off" />
        </div>
        <div className="field">
          <label>Role</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf || me?.role !== 'admin'}>
            <option value="employee">Employee</option>
            <option value="manager">Manager (posts for one company)</option>
            <option value="admin">Admin (manages all companies)</option>
          </select>
          {role === 'manager' && <p className="tiny muted">A manager can post announcements, schedule meetings, take attendance, see reports and manage employees — for their own company only.</p>}
        </div>
        {role !== 'admin' && (
          <div className="grid-2">
            <div className="field">
              <label>Company</label>
              <select className="select" value={company} onChange={(e) => setCompany(e.target.value === '' ? '' : Number(e.target.value))} required disabled={me?.role !== 'admin'}>
                <option value="">Choose…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {companies.length === 0 && <p className="tiny muted">Add a company first (Companies tab).</p>}
            </div>
            <div className="field">
              <label>Department</label>
              <select className="select" value={dept} onChange={(e) => setDept(e.target.value === '' ? '' : e.target.value === ADD_NEW ? ADD_NEW : Number(e.target.value))} disabled={company === ''}>
                <option value="">None</option>
                {companyDepts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value={ADD_NEW}>+ Add new department…</option>
              </select>
            </div>
          </div>
        )}
        {role !== 'admin' && dept === ADD_NEW && (
          <div className="field">
            <label>New department name</label>
            <input className="input" value={newDeptName} onChange={(e) => setNewDeptName(e.target.value)} placeholder="e.g. Marketing" autoFocus required />
            <p className="tiny muted">It will be created under {companies.find((c) => c.id === company)?.name || 'the selected company'} and assigned to this employee.</p>
          </div>
        )}
        {existing && !isSelf && (
          <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Account active (inactive users can't sign in and don't receive announcements)</label>
        )}
        <button className="btn primary block" type="submit" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save changes' : 'Add employee'}</button>
      </form>
    </Sheet>
  );
}

function ImportSheet({ onClose }: { onClose: () => void }) {
  const { toast, bump, reloadDepartments } = useStore();
  const [file, setFile] = useState<File | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    if (!file) return setError('Choose a file first');
    setBusy(true);
    setError(null);
    try {
      const r = await api.importUsers(file, createMissing);
      setResult(r);
      bump();
      reloadDepartments();
      toast(`${r.created.length} employee${r.created.length === 1 ? '' : 's'} imported`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Import employees from Excel / CSV" onClose={onClose}>
      {!result ? (
        <div className="stack">
          {error && <div className="error">{error}</div>}
          <p className="small muted">
            Use a spreadsheet with these columns (first row = headers): <strong>Name, Email, Password, Company, Department, Role</strong>.
            Password and Role are optional — a random password is generated when blank.
          </p>
          <a className="btn sm" href={api.importTemplateUrl()} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}>Download template (.xlsx)</a>
          <label className="btn" style={{ cursor: 'pointer', justifyContent: 'flex-start' }}>
            <UploadIcon /> {file ? file.name : 'Choose .xlsx / .xls / .csv file'}
            <input type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <label className="check"><input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} /> Create companies / departments that don't exist yet</label>
          <button className="btn primary block" onClick={run} disabled={busy || !file}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      ) : (
        <div className="stack">
          <div className="success">{result.created.length} employee{result.created.length === 1 ? '' : 's'} added{result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.</div>
          {result.created.some((c) => c.password !== '(as given)') && (
            <p className="small muted">Generated passwords are shown below — copy them now, they won't be shown again.</p>
          )}
          <div className="table-wrap">
            <table className="report">
              <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Password</th><th>Company · Dept</th></tr></thead>
              <tbody>
                {result.created.map((c) => (
                  <tr key={c.line}><td>{c.line}</td><td>{c.name}</td><td>{c.email}</td><td><code>{c.password}</code></td><td>{[c.company, c.department].filter(Boolean).join(' · ')}</td></tr>
                ))}
                {result.skipped.map((s) => (
                  <tr key={`s${s.line}`} style={{ color: 'var(--danger)' }}><td>{s.line}</td><td colSpan={2}>{s.email || '—'}</td><td colSpan={2}>Skipped: {s.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn primary block" onClick={onClose}>Done</button>
        </div>
      )}
    </Sheet>
  );
}

// =====================================================================
// Departments
// =====================================================================
function DepartmentsPanel() {
  const { companies, departments, reloadDepartments, toast, bump, user: me } = useStore();
  const [name, setName] = useState('');
  const [company, setCompany] = useState<number | ''>(me?.role === 'manager' ? me.company_id ?? '' : companies.length === 1 ? companies[0].id : '');
  const [editing, setEditing] = useState<Department | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (company === '' && companies.length === 1) setCompany(companies[0].id);
  }, [companies, company]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (company === '') return setError('Choose which company the department belongs to');
    try {
      await api.createDepartment(name.trim(), Number(company));
      setName('');
      await reloadDepartments();
      toast('Department added');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const grouped = companies.filter((c) => me?.role !== 'manager' || c.id === me.company_id).map((c) => ({ company: c, depts: departments.filter((d) => d.company_id === c.id) }));

  return (
    <>
      <form className="card" style={{ marginBottom: 12 }} onSubmit={add}>
        <div className="title" style={{ marginBottom: 10 }}>Add a department</div>
        <div className="grid-2">
          <div className="field">
            <label>Company</label>
            <select className="select" value={company} onChange={(e) => setCompany(e.target.value === '' ? '' : Number(e.target.value))} required disabled={me?.role === 'manager'}>
              <option value="">Choose…</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Department name</label>
            <input className="input" placeholder="e.g. Marketing" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
        </div>
        {error && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
        <button className="btn primary" type="submit" style={{ marginTop: 12 }}><PlusIcon /> Add department</button>
      </form>

      {companies.length === 0 && <p className="muted small">Add a company first — departments belong to a company.</p>}
      {grouped.map(({ company: c, depts }) => (
        <div className="card" key={c.id} style={{ padding: '12px 16px 4px' }}>
          <div className="row between" style={{ marginBottom: 4 }}>
            <div className="title">{c.name}</div>
            <span className="chip">{depts.length} department{depts.length === 1 ? '' : 's'}</span>
          </div>
          <div className="list">
            {depts.length === 0 && <p className="muted small" style={{ padding: '8px 0 12px' }}>No departments yet.</p>}
            {depts.map((d) => (
              <div className="list-item" key={d.id}>
                <div className="avatar"><UsersIcon style={{ width: 18, height: 18 }} /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  <div className="tiny muted">{d.member_count} member{d.member_count === 1 ? '' : 's'}</div>
                </div>
                <button className="btn ghost icon-btn" onClick={() => { setEditing(d); setEditName(d.name); }} aria-label="Rename"><EditIcon /></button>
                <button className="btn ghost icon-btn" onClick={() => setDeleting(d)} aria-label="Delete"><TrashIcon /></button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {editing && (
        <Sheet title="Rename department" onClose={() => setEditing(null)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api.renameDepartment(editing.id, editName.trim()); await reloadDepartments(); bump(); setEditing(null); toast('Department renamed'); } catch (err) { toast((err as Error).message); } }}>
            <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            <button className="btn primary block" type="submit">Save</button>
          </form>
        </Sheet>
      )}
      {deleting && (
        <Confirm title={`Delete ${deleting.name}?`} message="Employees in this department will be left without a department. Announcements sent only to this department will no longer be visible to them." confirmLabel="Delete" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api.deleteDepartment(deleting.id); await reloadDepartments(); bump(); toast('Department deleted'); }} />
      )}
    </>
  );
}

// =====================================================================
// Companies
// =====================================================================
function CompaniesPanel() {
  const { companies, reloadDepartments, toast, bump } = useStore();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<Company | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<Company | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createCompany(name.trim());
      setName('');
      await reloadDepartments();
      bump();
      toast('Company added');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <form className="row" style={{ marginBottom: 12 }} onSubmit={add}>
        <input className="input" placeholder="New company name…" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn primary" type="submit"><PlusIcon /> Add</button>
      </form>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="card" style={{ padding: '4px 16px' }}>
        <div className="list">
          {companies.length === 0 && <p className="muted small" style={{ padding: '12px 0' }}>No companies yet. Add each company the boss manages — employees and departments belong to a company, and announcements can go to one company or all of them.</p>}
          {companies.map((c) => (
            <div className="list-item" key={c.id}>
              <div className="avatar"><BuildingIcon style={{ width: 18, height: 18 }} /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                <div className="tiny muted">{c.member_count} employee{c.member_count === 1 ? '' : 's'} · {c.department_count} department{c.department_count === 1 ? '' : 's'}</div>
              </div>
              <button className="btn ghost icon-btn" onClick={() => { setEditing(c); setEditName(c.name); }} aria-label="Rename"><EditIcon /></button>
              <button className="btn ghost icon-btn" onClick={() => setDeleting(c)} aria-label="Delete"><TrashIcon /></button>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <Sheet title="Rename company" onClose={() => setEditing(null)}>
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await api.renameCompany(editing.id, editName.trim()); await reloadDepartments(); bump(); setEditing(null); toast('Company renamed'); } catch (err) { toast((err as Error).message); } }}>
            <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            <button className="btn primary block" type="submit">Save</button>
          </form>
        </Sheet>
      )}
      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          message={deleting.member_count > 0 ? `This company still has ${deleting.member_count} employee(s). Move them to another company first.` : 'Its departments and any announcements or meetings sent only to this company will be deleted too.'}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteCompany(deleting.id);
              await reloadDepartments();
              bump();
              toast('Company deleted');
            } catch (err) {
              toast((err as Error).message);
            }
          }}
        />
      )}
    </>
  );
}
