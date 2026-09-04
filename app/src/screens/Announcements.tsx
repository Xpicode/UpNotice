import { useEffect, useState, type FormEvent } from 'react';
import { api, isStaff, timeAgo, sqlToIso, formatDateTime, toLocalInput, type Announcement, type Poll, type Template } from '../api';
import { useLoader, useStore } from '../store';
import { AudiencePicker, Confirm, Empty, PriorityChip, Sheet, Spinner, audienceLabel, type Audience } from '../components/ui';
import { AttachmentList, Avatar, CommentThread, FilePicker } from '../components/social';
import { EMPTY_FILTERS, FilterBar, useDebounced, type ListFilters } from '../components/filters';
import { CheckIcon, ClockIcon, CopyIcon, EditIcon, LinkIcon, MegaphoneIcon, PinIcon, PlusIcon, SaveIcon, TrashIcon } from '../icons';

function StatusChip({ a }: { a: Announcement }) {
  if (a.status === 'draft') return <span className="chip"><EditIcon style={{ width: 12, height: 12 }} /> Draft</span>;
  if (a.status === 'scheduled') return <span className="chip warn"><ClockIcon style={{ width: 12, height: 12 }} /> Scheduled · {formatDateTime(a.publish_at!)}</span>;
  if (a.status === 'expired') return <span className="chip">Expired</span>;
  return null;
}

export function AnnouncementsScreen() {
  const { user, go } = useStore();
  const staff = isStaff(user);
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const [filter, setFilter] = useState<'all' | 'unread' | 'live' | 'scheduled' | 'expired' | 'draft'>('all');
  const q = useDebounced(filters.q);
  const { data, error, loading } = useLoader(
    () => api.announcements({ q, category: filters.category, company_id: filters.company_id, department_id: filters.department_id, from: filters.from, to: filters.to, status: filter === 'all' || filter === 'unread' ? undefined : filter, unread: filter === 'unread' }),
    [q, filters.category, filters.company_id, filters.department_id, filters.from, filters.to, filter]
  );
  const { data: cats } = useLoader(() => api.categories());
  const [compose, setCompose] = useState<false | { prefill?: Announcement }>(false);
  const items = data?.announcements || [];
  const hasQuery = !!(filters.q || filters.category || filters.company_id || filters.department_id || filters.from || filters.to);

  return (
    <>
      <FilterBar value={filters} onChange={setFilters} categories={cats?.categories} placeholder="Search announcements…">
        {staff && (
          <button className="btn primary" onClick={() => setCompose({})} title="New announcement">
            <PlusIcon /> <span className="desktop-only">New</span>
          </button>
        )}
      </FilterBar>
      <div className="row between wrap" style={{ marginBottom: 14 }}>
        {!staff ? (
          <div className="seg">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
            <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread</button>
          </div>
        ) : (
          <div className="seg">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
            <button className={filter === 'live' ? 'active' : ''} onClick={() => setFilter('live')}>Live</button>
            <button className={filter === 'scheduled' ? 'active' : ''} onClick={() => setFilter('scheduled')}>Scheduled</button>
            <button className={filter === 'draft' ? 'active' : ''} onClick={() => setFilter('draft')}>Drafts</button>
            <button className={filter === 'expired' ? 'active' : ''} onClick={() => setFilter('expired')}>Expired</button>
          </div>
        )}
      </div>

      {loading && <Spinner />}
      {error && <div className="error">{error}</div>}
      {!loading && items.length === 0 && (
        <Empty
          icon={<MegaphoneIcon />}
          title={hasQuery ? 'Nothing matches your search' : filter === 'unread' ? "You're all caught up" : filter === 'draft' ? 'No drafts' : 'No announcements here'}
          hint={hasQuery ? 'Try other words or clear the filters.' : staff ? 'Post your first announcement to the team.' : 'New announcements from management will show up here.'}
        />
      )}

      {items.map((a) => (
        <AnnouncementCard key={a.id} a={a} isAdmin={staff} onOpen={() => go('announcements', { type: 'announcement', id: a.id })} />
      ))}

      {compose && <AnnouncementForm prefill={compose.prefill} onClose={() => setCompose(false)} />}
    </>
  );
}

function AnnouncementCard({ a, isAdmin, onOpen }: { a: Announcement; isAdmin: boolean; onOpen: () => void }) {
  const pct = a.audience_count ? Math.round((a.read_count / a.audience_count) * 100) : 0;
  return (
    <div className={`card clickable ${!a.read_by_me && !isAdmin ? 'unread' : ''}`} onClick={onOpen} style={{ opacity: a.status === 'expired' ? 0.7 : 1 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row wrap" style={{ gap: 6, marginBottom: 4 }}>
            {a.pinned && <span className="chip"><PinIcon style={{ width: 12, height: 12 }} /> Pinned</span>}
            <PriorityChip priority={a.priority} />
            <StatusChip a={a} />
            {a.category && <span className="chip primary">{a.category}</span>}
            <span className="chip">{audienceLabel(a)}</span>
            {a.ack_required && !isAdmin && <span className={`chip ${a.acked_by_me ? 'ok' : 'warn'}`}>{a.acked_by_me ? 'Acknowledged' : 'Needs acknowledgement'}</span>}
            {a.poll && <span className="chip">Poll</span>}
          </div>
          <div className="title">{a.title}</div>
          <p className="muted small" style={{ marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {a.body}
          </p>
        </div>
        {!isAdmin && a.read_by_me && <span className="chip ok"><CheckIcon style={{ width: 12, height: 12 }} /> Read</span>}
      </div>
      <div className="row between tiny muted wrap" style={{ marginTop: 10 }}>
        <span>
          {a.author_name} · {timeAgo(a.created_at)}
          {(a.attachment_count ?? 0) > 0 && <> · <LinkIcon style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> {a.attachment_count} file{a.attachment_count > 1 ? 's' : ''}</>}
          {(a.comment_count ?? 0) > 0 && <> · {a.comment_count} comment{a.comment_count > 1 ? 's' : ''}</>}
          {a.expires_at && a.status !== 'expired' && <> · expires {formatDateTime(a.expires_at)}</>}
        </span>
        {isAdmin && a.status !== 'draft' && (
          <span>
            {a.read_count}/{a.audience_count ?? '?'} read ({pct}%){a.ack_required && ` · ${a.ack_count} acknowledged`}
          </span>
        )}
      </div>
      {isAdmin && a.status !== 'draft' && (
        <div className="progress" style={{ marginTop: 8 }}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function PollBox({ announcementId, poll, canVote, onVoted }: { announcementId: number; poll: Poll; canVote: boolean; onVoted: (p: Poll) => void }) {
  const { toast } = useStore();
  const vote = async (optionId: number) => {
    if (!canVote) return;
    try {
      const r = await api.vote(announcementId, optionId);
      onVoted(r.poll);
      toast('Vote saved');
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="card">
      <div className="title" style={{ marginBottom: 4 }}>{poll.question}</div>
      <p className="tiny muted" style={{ marginBottom: 10 }}>{poll.total} {poll.total === 1 ? 'vote' : 'votes'}{canVote && !poll.my_vote ? ' · tap an option to vote' : ''}</p>
      {poll.options.map((o) => {
        const pct = poll.total ? Math.round((o.votes / poll.total) * 100) : 0;
        return (
          <button key={o.id} type="button" className={`poll-option ${poll.my_vote === o.id ? 'chosen' : ''}`} onClick={() => vote(o.id)} disabled={!canVote}>
            <span className="bar" style={{ width: `${pct}%` }} />
            <span className="lbl">
              <span>{poll.my_vote === o.id && <CheckIcon style={{ width: 14, height: 14, verticalAlign: '-2px', color: 'var(--primary)' }} />} {o.label}</span>
              <span className="muted small">{o.votes} · {pct}%</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AnnouncementDetail({ id }: { id: number }) {
  const { back, toast, bump } = useStore();
  const { data, error, loading, setData } = useLoader(() => api.announcement(id), [id]);
  const [edit, setEdit] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [saveTpl, setSaveTpl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const a = data?.announcement;
  const isAdmin = !!a?.can_manage; // "manages this item": admin, or manager of its company
  const viewerOnly = !isAdmin; // everyone else (employees, and managers reading another company's / all-company items) is a reader

  // Employees: opening the announcement marks it as read automatically.
  useEffect(() => {
    if (a && !a.read_by_me && viewerOnly) {
      api.markRead(a.id).then(() => {
        setData({ announcement: { ...a, read_by_me: true } });
        bump();
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.id, a?.read_by_me]);

  if (loading) return <Spinner />;
  if (error || !a) return <div className="error">{error || 'Announcement not found'}</div>;

  const pct = a.audience_count ? Math.round((a.read_count / a.audience_count) * 100) : 0;
  const acknowledge = async () => {
    try {
      await api.acknowledge(a.id);
      setData({ announcement: { ...a, acked_by_me: true, read_by_me: true } });
      toast('Thanks — acknowledged');
      bump();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {a.pinned && <span className="chip"><PinIcon style={{ width: 12, height: 12 }} /> Pinned</span>}
          <PriorityChip priority={a.priority} />
          <StatusChip a={a} />
          {a.category && <span className="chip primary">{a.category}</span>}
          <span className="chip">{audienceLabel(a)}</span>
        </div>
        <h2 style={{ fontSize: 22, marginBottom: 6 }}>{a.title}</h2>
        <p className="muted small" style={{ marginBottom: 16 }}>
          Posted by {a.author_name} · {formatDateTime(sqlToIso(a.created_at))}
          {a.expires_at && <> · {a.status === 'expired' ? 'expired' : 'expires'} {formatDateTime(a.expires_at)}</>}
        </p>
        {a.body ? <p className="prose">{a.body}</p> : <p className="muted small">(No message yet — this is a draft.)</p>}
        <AttachmentList announcementId={a.id} attachments={a.attachments} />

        {a.status === 'draft' && isAdmin && (
          <div className="error" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', marginTop: 16 }}>
            This is a draft — employees can't see it yet. Edit it, then press <strong>Publish</strong> when it's ready.
          </div>
        )}
        {viewerOnly && a.ack_required && (
          a.acked_by_me ? (
            <div className="success" style={{ marginTop: 18 }}><CheckIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> You acknowledged this announcement.</div>
          ) : (
            <div style={{ marginTop: 18 }}>
              <div className="error" style={{ background: 'var(--warn-soft)', color: 'var(--warn)', marginBottom: 10 }}>Management asks you to confirm you've read and understood this.</div>
              <button className="btn primary block" onClick={acknowledge}><CheckIcon /> I have read and understood this</button>
            </div>
          )
        )}
        {viewerOnly && !a.ack_required && (
          <div className="success" style={{ marginTop: 18 }}>
            <CheckIcon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> Marked as read — management can see you've seen this.
          </div>
        )}
        {isAdmin && (
          <div className="row wrap" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            {a.status === 'draft' && <button className="btn sm primary" onClick={() => (a.body.trim() ? setConfirmPublish(true) : setEdit(true))}><CheckIcon /> Publish</button>}
            <button className="btn sm" onClick={() => setEdit(true)}><EditIcon /> Edit</button>
            <button className="btn sm" onClick={() => setDuplicate(true)} title="Start a new announcement with the same content"><CopyIcon /> Duplicate</button>
            <button className="btn sm" onClick={() => setSaveTpl(true)} title="Save as a reusable template"><SaveIcon /> Save as template</button>
            <button className="btn sm danger" onClick={() => setConfirmDelete(true)}><TrashIcon /> Delete</button>
          </div>
        )}
      </div>

      {a.poll && <PollBox announcementId={a.id} poll={a.poll} canVote={viewerOnly && a.status === 'live'} onVoted={(poll) => setData({ announcement: { ...a, poll, read_by_me: true } })} />}

      {isAdmin && a.status !== 'draft' && (
        <div className="card">
          <div className="row between">
            <div className="title">Read receipts</div>
            <span className="chip primary">{a.read_count}/{a.audience_count} · {pct}%</span>
          </div>
          <div className="progress" style={{ margin: '10px 0 14px' }}><div style={{ width: `${pct}%` }} /></div>
          {a.ack_required && <p className="small muted" style={{ marginBottom: 6 }}>Acknowledged: <strong>{a.ack_count}</strong> of {a.audience_count}</p>}

          <div className="section-title">Read ({a.readers?.length ?? 0})</div>
          <div className="list">
            {a.readers?.length === 0 && <p className="muted small">Nobody has read this yet.</p>}
            {a.readers?.map((p) => (
              <div className="list-item" key={p.id}>
                <Avatar userId={p.id} name={p.name} avatarUrl={null} />
                <div style={{ flex: 1 }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 600 }}>{p.name}</span>
                    {a.ack_required && (p.acknowledged_at ? <span className="chip ok">Acknowledged</span> : <span className="chip warn">Not acknowledged</span>)}
                    {p.poll_answer && <span className="chip primary">Voted: {p.poll_answer}</span>}
                  </div>
                  <div className="tiny muted">{[p.company_name, p.department_name].filter(Boolean).join(' · ') || 'No department'}</div>
                </div>
                <span className="tiny muted">{p.read_at ? timeAgo(p.read_at) : ''}</span>
              </div>
            ))}
          </div>

          <div className="section-title">Not yet read ({a.unread?.length ?? 0})</div>
          <div className="list">
            {a.unread?.length === 0 && <p className="muted small">Everyone has read this.</p>}
            {a.unread?.map((p) => (
              <div className="list-item" key={p.id}>
                <Avatar userId={p.id} name={p.name} avatarUrl={null} grey />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="tiny muted">{[p.company_name, p.department_name].filter(Boolean).join(' · ') || 'No department'}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <CommentThread refType="announcement" refId={a.id} />

      {edit && <AnnouncementForm existing={a} onClose={() => setEdit(false)} />}
      {duplicate && <AnnouncementForm prefill={a} onClose={() => setDuplicate(false)} />}
      {saveTpl && <SaveTemplateSheet a={a} onClose={() => setSaveTpl(false)} />}
      {confirmPublish && (
        <Confirm
          title="Publish this announcement?"
          message={a.publish_at && a.publish_at > new Date().toISOString() ? `It will go out at ${formatDateTime(a.publish_at)} and employees will be notified then.` : 'Everyone it is sent to gets a notification right away.'}
          confirmLabel="Publish"
          onClose={() => setConfirmPublish(false)}
          onConfirm={async () => {
            await api.updateAnnouncement(a.id, { draft: false });
            toast('Published');
            bump();
          }}
        />
      )}
      {confirmDelete && (
        <Confirm
          title="Delete announcement?"
          message="This removes it for everyone, including read receipts, attachments and comments."
          confirmLabel="Delete"
          danger
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteAnnouncement(a.id);
            toast('Announcement deleted');
            back();
          }}
        />
      )}
    </>
  );
}

function SaveTemplateSheet({ a, onClose }: { a: { title: string; body: string; priority: Announcement['priority']; category: string | null; ack_required: boolean; poll: Poll | null }; onClose: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(a.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title="Save as template" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.createTemplate({ name: name.trim(), title: a.title, body: a.body, priority: a.priority, category: a.category, ack_required: a.ack_required, poll_question: a.poll?.question || null, poll_options: a.poll?.options.map((o) => o.label) || [], company_id: null });
            toast('Template saved');
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && <div className="error">{error}</div>}
        <p className="small muted">Templates keep the title, message, priority, topic, acknowledgement and poll — you can pick them from "Use a template" when writing a new announcement.</p>
        <div className="field"><label>Template name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="e.g. Holiday notice" /></div>
        <button className="btn primary block" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save template'}</button>
      </form>
    </Sheet>
  );
}

function AnnouncementForm({ existing, prefill, onClose }: { existing?: Announcement; prefill?: Announcement; onClose: () => void }) {
  const { toast, bump, user } = useStore();
  const src = existing || prefill; // prefill = duplicate: same content, new announcement
  const [title, setTitle] = useState(src?.title || '');
  const [body, setBody] = useState(src?.body || '');
  const [priority, setPriority] = useState<Announcement['priority']>(src?.priority || 'normal');
  const [category, setCategory] = useState(src?.category || '');
  const [pinned, setPinned] = useState(src?.pinned || false);
  const [audience, setAudience] = useState<Audience>({ company_id: src?.company_id ?? (user?.role === 'manager' ? user.company_id : null), department_ids: src?.targets.map((t) => t.id) || [] });
  const { data: cats } = useLoader(() => api.categories());
  const { data: tpls, reload: reloadTemplates } = useLoader(() => api.templates());
  const [saveTpl, setSaveTpl] = useState(false);
  const applyTemplate = (t: Template) => {
    setTitle(t.title);
    setBody(t.body);
    setPriority(t.priority);
    setCategory(t.category || '');
    setAckRequired(t.ack_required);
    setHasPoll(!!t.poll_question);
    setPollQuestion(t.poll_question || '');
    setPollOptions(t.poll_options.length >= 2 ? t.poll_options : ['', '']);
  };
  const [files, setFiles] = useState<File[]>([]);
  const [removeIds, setRemoveIds] = useState<number[]>([]);
  const [schedule, setSchedule] = useState(!!existing?.publish_at && existing.status === 'scheduled');
  const [publishAt, setPublishAt] = useState(existing?.publish_at ? toLocalInput(existing.publish_at) : toLocalInput(new Date(Date.now() + 3600000).toISOString()));
  const [expire, setExpire] = useState(!!src?.expires_at);
  const [expiresAt, setExpiresAt] = useState(src?.expires_at ? toLocalInput(src.expires_at) : toLocalInput(new Date(Date.now() + 7 * 86400000).toISOString()));
  const [ackRequired, setAckRequired] = useState(src?.ack_required || false);
  const [hasPoll, setHasPoll] = useState(!!src?.poll);
  const [pollQuestion, setPollQuestion] = useState(src?.poll?.question || '');
  const [pollOptions, setPollOptions] = useState<string[]>(src?.poll?.options.map((o) => o.label) || ['', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDraft = existing?.status === 'draft';

  const submit = async (e: FormEvent | null, asDraft = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const options = pollOptions.map((s) => s.trim()).filter(Boolean);
      if (hasPoll && !asDraft && (!pollQuestion.trim() || options.length < 2)) throw new Error('A poll needs a question and at least 2 options');
      if (!asDraft && !body.trim()) throw new Error('Write the message first (or save as a draft)');
      const payload = {
        title, body, priority, pinned, category: category.trim() || null, ...audience,
        publish_at: schedule ? new Date(publishAt).toISOString() : null,
        expires_at: expire ? new Date(expiresAt).toISOString() : null,
        ack_required: ackRequired,
        poll_question: hasPoll ? pollQuestion.trim() : '',
        poll_options: hasPoll ? options : [],
        draft: asDraft,
      };
      if (existing) {
        const pollChanged = JSON.stringify(options) !== JSON.stringify(existing.poll?.options.map((o) => o.label) || []) || (hasPoll !== !!existing.poll);
        await api.updateAnnouncement(existing.id, { ...payload, ...(pollChanged ? {} : { poll_options: undefined }), remove_attachment_ids: removeIds }, files);
        toast(asDraft ? 'Draft saved' : isDraft ? (schedule ? `Scheduled for ${formatDateTime(new Date(publishAt).toISOString())}` : 'Published') : 'Announcement updated');
      } else {
        await api.createAnnouncement(payload, files);
        toast(asDraft ? 'Saved as draft' : schedule ? `Scheduled for ${formatDateTime(new Date(publishAt).toISOString())}` : 'Announcement posted');
      }
      bump();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const templates = tpls?.templates || [];
  return (
    <Sheet title={existing ? (isDraft ? 'Edit draft' : 'Edit announcement') : prefill ? 'Duplicate announcement' : 'New announcement'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => submit(e, false)}>
        {error && <div className="error">{error}</div>}
        {!existing && templates.length > 0 && (
          <div className="field">
            <label>Use a template</label>
            <div className="row">
              <select className="select" defaultValue="" onChange={(e) => { const t = templates.find((x) => x.id === Number(e.target.value)); if (t) applyTemplate(t); }}>
                <option value="">Start from scratch…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <TemplateManager templates={templates} onChanged={reloadTemplates} />
            </div>
          </div>
        )}
        <div className="field">
          <label>Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="e.g. Office closed on Monday" />
        </div>
        <div className="field">
          <label>Message</label>
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write the announcement…" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Priority</label>
            <div className="seg">
              {(['normal', 'important', 'urgent'] as const).map((p) => (
                <button type="button" key={p} className={priority === p ? 'active' : ''} onClick={() => setPriority(p)}>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Topic / category</label>
            <input className="input" list="ann-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. HR, Safety, Events" maxLength={40} />
            <datalist id="ann-categories">{(cats?.categories || []).map((c) => <option key={c} value={c} />)}</datalist>
          </div>
        </div>
        <AudiencePicker value={audience} onChange={setAudience} />
        <FilePicker files={files} onChange={setFiles} existing={(existing?.attachments ?? []).filter((a) => !removeIds.includes(a.id))} onRemoveExisting={(id) => setRemoveIds((r) => [...r, id])} />

        <div className="section-title">Options</div>
        <label className="check"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top</label>
        <label className="check"><input type="checkbox" checked={ackRequired} onChange={(e) => setAckRequired(e.target.checked)} /> Require acknowledgement ("I have read and understood")</label>
        <label className="check"><input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} /> Publish later</label>
        {schedule && (
          <div className="field" style={{ paddingLeft: 26 }}>
            <label>Publish at</label>
            <input className="input" type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} required />
            <p className="tiny muted">Employees won't see it or be notified until this time.</p>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={expire} onChange={(e) => setExpire(e.target.checked)} /> Hide automatically after a date</label>
        {expire && (
          <div className="field" style={{ paddingLeft: 26 }}>
            <label>Expires at</label>
            <input className="input" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required />
          </div>
        )}
        <label className="check"><input type="checkbox" checked={hasPoll} onChange={(e) => setHasPoll(e.target.checked)} /> Add a quick poll</label>
        {hasPoll && (
          <div className="stack" style={{ paddingLeft: 26 }}>
            <div className="field">
              <label>Question</label>
              <input className="input" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} placeholder="e.g. Which date works for the team outing?" />
            </div>
            <div className="field">
              <label>Options</label>
              {pollOptions.map((o, i) => (
                <div className="row" key={i}>
                  <input className="input" value={o} onChange={(e) => setPollOptions(pollOptions.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} />
                  {pollOptions.length > 2 && <button type="button" className="btn ghost icon-btn" onClick={() => setPollOptions(pollOptions.filter((_, j) => j !== i))}><TrashIcon /></button>}
                </div>
              ))}
              {pollOptions.length < 10 && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPollOptions([...pollOptions, ''])}>+ Add option</button>}
              {existing?.poll && <p className="tiny muted">Changing the options resets existing votes.</p>}
            </div>
          </div>
        )}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing && !isDraft ? 'Save changes' : schedule ? 'Schedule announcement' : isDraft ? 'Publish now' : 'Post announcement'}
        </button>
        <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
          {(!existing || isDraft) && (
            <button className="btn sm" type="button" disabled={busy} onClick={() => submit(null, true)}><SaveIcon /> {isDraft ? 'Save draft' : 'Save as draft'}</button>
          )}
          <button className="btn sm ghost" type="button" onClick={() => setSaveTpl(true)} disabled={!title.trim()}>Save as template</button>
        </div>
        {!existing && !schedule && <p className="tiny muted" style={{ textAlign: 'center' }}>Everyone it's sent to gets a notification right away. Drafts are only visible to you and other managers.</p>}
      </form>
      {saveTpl && (
        <SaveTemplateSheet
          a={{ title, body, priority, category: category.trim() || null, ack_required: ackRequired, poll: hasPoll ? { question: pollQuestion, options: pollOptions.filter(Boolean).map((label, i) => ({ id: i, label, votes: 0 })), my_vote: null, total: 0 } : null }}
          onClose={() => { setSaveTpl(false); reloadTemplates(); }}
        />
      )}
    </Sheet>
  );
}

/** Small "manage templates" popover: delete ones you no longer need. */
function TemplateManager({ templates, onChanged }: { templates: Template[]; onChanged: () => void }) {
  const { toast } = useStore();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title="Manage templates"><EditIcon /></button>
      {open && (
        <Sheet title="Templates" onClose={() => setOpen(false)}>
          <div className="list">
            {templates.map((t) => (
              <div className="list-item" key={t.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}{t.category ? ` · ${t.category}` : ''}{t.created_by_name ? ` · by ${t.created_by_name}` : ''}</div>
                </div>
                <button type="button" className="btn ghost icon-btn" aria-label="Delete template" onClick={async () => { try { await api.deleteTemplate(t.id); toast('Template deleted'); onChanged(); } catch (e) { toast((e as Error).message); } }}><TrashIcon /></button>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
