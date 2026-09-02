// Avatars, comment threads and attachment lists — shared by announcements and meetings.
import { useState, type FormEvent } from 'react';
import { api, formatBytes, timeAgo, type Attachment, type Comment } from '../api';
import { useLoader, useStore } from '../store';
import { initials, Spinner } from './ui';
import { LinkIcon, TrashIcon } from '../icons';

export function Avatar({ userId, name, avatarUrl, size = 38, grey = false }: { userId: number; name: string; avatarUrl?: string | null; size?: number; grey?: boolean }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.37) };
  if (avatarUrl && !broken) {
    return <img className="avatar" src={api.avatarUrl(userId)} alt={name} style={{ ...style, objectFit: 'cover' }} onError={() => setBroken(true)} />;
  }
  return <div className={`avatar ${grey ? 'grey' : ''}`} style={style}>{initials(name)}</div>;
}

export function CommentThread({ refType, refId }: { refType: 'announcement' | 'meeting'; refId: number }) {
  const { user, toast } = useStore();
  const { data, loading, reload } = useLoader(() => api.comments(refType, refId), [refType, refId]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const comments = data?.comments || [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.addComment(refType, refId, text.trim());
      setText('');
      reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteComment(id);
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 6 }}>
        {user?.role === 'admin' ? 'Comments & questions' : 'Questions or comments'} {comments.length > 0 && <span className="chip">{comments.length}</span>}
      </div>
      {loading && <Spinner />}
      {!loading && comments.length === 0 && (
        <p className="small muted" style={{ marginBottom: 10 }}>
          {user?.role === 'admin' ? 'No comments yet. Employees can ask questions here and you can answer.' : 'Have a question about this? Ask here — management will see it.'}
        </p>
      )}
      <div className="list">
        {comments.map((c) => (
          <div className="list-item" key={c.id} style={{ alignItems: 'flex-start' }}>
            <Avatar userId={c.user_id} name={c.user_name} avatarUrl={c.avatar_url} size={34} grey={c.user_role !== 'admin'} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span style={{ fontWeight: 600 }}>{c.user_name}</span>
                {c.user_role === 'admin' && <span className="chip primary">Management</span>}
                <span className="tiny muted">{timeAgo(c.created_at)}</span>
              </div>
              <p className="prose small" style={{ marginTop: 2 }}>{c.body}</p>
            </div>
            {(c.mine || user?.role === 'admin') && (
              <button className="btn ghost icon-btn" onClick={() => remove(c.id)} aria-label="Delete comment"><TrashIcon /></button>
            )}
          </div>
        ))}
      </div>
      <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={submit}>
        <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder={user?.role === 'admin' ? 'Reply…' : 'Write your question or comment…'} style={{ minHeight: 44, flex: 1 }} rows={1} maxLength={2000}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e); }} />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{busy ? '…' : 'Send'}</button>
      </form>
    </div>
  );
}

export function AttachmentList({ announcementId, attachments }: { announcementId: number; attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.mime.startsWith('image/'));
  const others = attachments.filter((a) => !a.mime.startsWith('image/'));
  return (
    <div style={{ marginTop: 16 }}>
      {images.length > 0 && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
          {images.map((a) => (
            <a key={a.id} href={api.attachmentUrl(announcementId, a.id)} target="_blank" rel="noreferrer" title={a.filename}>
              <img src={api.attachmentUrl(announcementId, a.id)} alt={a.filename} style={{ width: 140, height: 100, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--border)' }} />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {others.map((a) => (
            <a key={a.id} className="attachment" href={api.attachmentUrl(announcementId, a.id, !(a.mime === 'application/pdf'))} target="_blank" rel="noreferrer">
              <span className="attachment-icon">{extLabel(a.filename)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
              <span className="tiny muted">{formatBytes(a.size)}</span>
              <LinkIcon style={{ width: 16, height: 16, color: 'var(--muted)' }} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function extLabel(name: string): string {
  const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
  return ext.slice(0, 4);
}

/** File picker used in the announcement form. */
export function FilePicker({ files, onChange, existing = [], onRemoveExisting }: { files: File[]; onChange: (f: File[]) => void; existing?: Attachment[]; onRemoveExisting?: (id: number) => void }) {
  const total = files.length + existing.length;
  return (
    <div className="field">
      <label>Attachments <span className="muted" style={{ fontWeight: 400 }}>(images, PDF, Word, Excel — up to 5, 15 MB each)</span></label>
      {existing.map((a) => (
        <div className="attachment" key={`e${a.id}`}>
          <span className="attachment-icon">{extLabel(a.filename)}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
          <span className="tiny muted">{formatBytes(a.size)}</span>
          {onRemoveExisting && <button type="button" className="btn ghost icon-btn" onClick={() => onRemoveExisting(a.id)} aria-label="Remove"><TrashIcon /></button>}
        </div>
      ))}
      {files.map((f, i) => (
        <div className="attachment" key={`n${i}`}>
          <span className="attachment-icon">{extLabel(f.name)}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
          <span className="tiny muted">{formatBytes(f.size)}</span>
          <button type="button" className="btn ghost icon-btn" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label="Remove"><TrashIcon /></button>
        </div>
      ))}
      {total < 5 && (
        <label className="btn sm" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
          + Add file
          <input type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" onChange={(e) => { const picked = Array.from(e.target.files || []); onChange([...files, ...picked].slice(0, 5 - existing.length)); e.target.value = ''; }} />
        </label>
      )}
    </div>
  );
}
