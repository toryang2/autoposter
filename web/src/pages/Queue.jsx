import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Link, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { Ban, ChevronDown, Send, Trash2, CircleCheck, Copy, ExternalLink, Link2, ListChecks, RotateCcw, UserRoundPlus } from 'lucide-react';
import { api, PLATFORMS, STATUS_LABEL, TYPE_LABEL, formatWhen } from '../api.js';
import { EmptyState, StatusChip, TypeBadge } from '../components.jsx';

const FILTERS = ['', 'queued', 'awaiting_join', 'needs_check', 'failed', 'submitted', 'pending_approval', 'cancelled'];
const HAS_POST = new Set(['submitted', 'pending_approval', 'needs_check']);

// Manual override: publishes one queued post right away, skipping its time, the group gap, the daily cap and any pause.
function PostNow({ job, onAction }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (job.force_now) return <Chip icon={<Send size={14} />} label="Posting next…" color="primary" variant="outlined" />;
  async function go() {
    setBusy(true);
    await onAction(job.id, 'post-now');
    setBusy(false);
    setConfirm(false);
  }
  return (
    <>
      <Button variant="contained" startIcon={<Send size={16} />} onClick={() => setConfirm(true)}>Post now</Button>
      <Dialog open={confirm} onClose={() => !busy && setConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700 }}>Post to {job.destination_name} now?</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Claude starts publishing this in Chrome right away, ignoring its scheduled time, the gap between group posts,
            the daily cap and any usage pause. Other queued posts keep their schedule.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button color="secondary" disabled={busy} onClick={() => setConfirm(false)}>Not yet</Button>
          <Button variant="contained" disabled={busy} startIcon={<Send size={16} />} onClick={go}>{busy ? 'Starting…' : 'Post now'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function PostLinkField({ job, onSaved, autoFocus }) {
  const [value, setValue] = useState(job.post_url || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setValue(job.post_url || ''); }, [job.post_url]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try { await api.setJobLink(job.id, value); await onSaved(); } catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(job.post_url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  return (
    <Box component="form" onSubmit={save} sx={{ mt: 2 }}>
      <Typography fontSize={13} fontWeight={700} mb={0.75}>Post link</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField size="small" fullWidth autoFocus={autoFocus} value={value} onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the post's link (… → Copy link)" error={!!error} helperText={error || undefined}
          slotProps={{ input: { startAdornment: <Box sx={{ mr: 1, display: 'flex', color: 'text.secondary' }}><Link2 size={16} /></Box> } }} />
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="outlined" color="secondary" disabled={saving || value === (job.post_url || '')}>Save</Button>
          {job.post_url && (
            <Tooltip title={copied ? 'Copied' : 'Copy link'}>
              <IconButton onClick={copy} aria-label="Copy link"><Copy size={16} /></IconButton>
            </Tooltip>
          )}
        </Stack>
      </Stack>
      {!job.post_url && (
        <Typography variant="caption" color="text.secondary" display="block" mt={0.75}>
          Claude couldn't read this post's link. Open the post's ⋯ or share menu → Copy link, then paste it here.
        </Typography>
      )}
    </Box>
  );
}

function RowLink({ job, onAddLink }) {
  if (job.post_url) {
    return (
      <Button size="small" href={job.post_url} target="_blank" rel="noreferrer" endIcon={<ExternalLink size={14} />}
        sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>
        View post
      </Button>
    );
  }
  if (!HAS_POST.has(job.status)) return <Box />;
  return (
    <Tooltip title="Claude couldn't read the link — add it yourself">
      <Button size="small" color="secondary" startIcon={<Link2 size={14} />} onClick={onAddLink}
        sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
        Add link
      </Button>
    </Tooltip>
  );
}

function JobDetail({ job, onAction, onSaved, focusLink }) {
  const removed = Boolean(job.destination_archived);
  const [log, setLog] = useState(null);
  const [media, setMedia] = useState([]);
  useEffect(() => {
    api.jobLog(job.id).then(setLog).catch(() => {});
    api.postMedia(job.post_id).then(setMedia).catch(() => {});
  }, [job.id, job.post_id]);

  return (
    <Box sx={{ px: { xs: 2, md: 2.5 }, pb: 2.5, pt: 0.5 }}>
      <Box sx={{ p: 2, borderRadius: 2.5, bgcolor: 'background.default' }}>
        <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{job.post_body || '(no text)'}</Typography>
        {job.first_comment && (
          <Box sx={{ mt: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>First comment</Typography>
            <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{job.first_comment}</Typography>
          </Box>
        )}
        {media.length > 0 && (
          <Stack direction="row" gap={1} mt={1.5} flexWrap="wrap">
            {media.map((m) => {
              const style = { width: 72, height: 72, objectFit: 'cover', borderRadius: 10 };
              return m.kind === 'video' ? <video key={m.id} src={m.url} muted style={style} /> : <img key={m.id} src={m.url} alt="" style={style} />;
            })}
          </Stack>
        )}
      </Box>
      {job.destination_platform === 'facebook' && job.destination_type === 'group' && (
        <Typography variant="caption" color="text.secondary" display="block" mt={1}>
          Posts as <strong>{job.post_as === '@self' ? 'you' : job.post_as || job.destination_post_as || 'you'}</strong>
        </Typography>
      )}
      {job.last_error && <Alert severity="error" sx={{ mt: 1.5 }}>{job.last_error}</Alert>}
      {job.status === 'awaiting_join' && (
        <Alert severity="info" icon={<UserRoundPlus size={20} />} sx={{ mt: 1.5 }}>
          <strong>Asked to join {job.destination_name}{job.join_requested_at ? ` on ${formatWhen(job.join_requested_at)}` : ''}.</strong>{' '}
          The group's admin hasn't accepted the request yet, so nothing has been posted. The autoposter checks again
          at {formatWhen(job.scheduled_at)} and posts as soon as the account is in. If the admin never accepts, it stops
          after the wait set in Settings and marks the post Failed.
        </Alert>
      )}
      {job.status === 'needs_check' && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          Claude may or may not have posted this. Check the post's page first; retrying a post that already went out will duplicate it.
        </Alert>
      )}
      {log?.result && (
        <Box component="details" sx={{ mt: 1.5, '& summary': { cursor: 'pointer', fontWeight: 650, fontSize: 13, color: 'text.secondary' } }}>
          <summary>Claude's report{log.num_turns ? ` · ${log.num_turns} steps, ${Math.round(log.duration_ms / 1000)}s` : ''}</summary>
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontSize: 12, p: 1.5, mt: 1, borderRadius: 2, bgcolor: '#15171C', color: '#E8E6E1', maxHeight: 280, overflow: 'auto' }}>
            {log.result}
          </Box>
        </Box>
      )}
      {removed && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          You removed {job.destination_name} from Destinations, so this can't be posted again. Add the destination back to post there.
        </Alert>
      )}
      <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
        {!removed && ['queued', 'awaiting_join'].includes(job.status) && <PostNow job={job} onAction={onAction} />}
        {!removed && job.status === 'awaiting_join' && <Button variant="outlined" color="secondary" startIcon={<RotateCcw size={16} />} onClick={() => onAction(job.id, 'retry')}>Check now</Button>}
        {['queued', 'awaiting_join'].includes(job.status) && <Button variant="outlined" color="secondary" startIcon={<Ban size={16} />} onClick={() => onAction(job.id, 'cancel')}>Cancel</Button>}
        {job.status === 'needs_check' && <Button variant="contained" color="success" startIcon={<CircleCheck size={16} />} onClick={() => onAction(job.id, 'mark-posted')}>It posted</Button>}
        {!removed && ['failed', 'needs_check', 'cancelled'].includes(job.status) && (
          <Button variant="outlined" color="secondary" startIcon={<RotateCcw size={16} />} onClick={() => onAction(job.id, 'retry')}>
            {job.status === 'needs_check' ? "It didn't post — retry now" : 'Retry now'}
          </Button>
        )}
        {['failed', 'cancelled'].includes(job.status) && (
          <Tooltip title="Clears this from the Queue, with Claude's report. Nothing changes on the social network.">
            <Button variant="outlined" color="error" startIcon={<Trash2 size={16} />} onClick={() => onAction(job.id, 'remove')}>Remove</Button>
          </Tooltip>
        )}
        {!job.post_url && HAS_POST.has(job.status) && (
            <Tooltip title="Claude couldn't read this post's own link, so this opens where it was posted">
              <Button href={job.destination_url} target="_blank" rel="noreferrer" color="secondary" endIcon={<ExternalLink size={15} />}>
                Open {TYPE_LABEL[job.destination_type].toLowerCase()}
              </Button>
            </Tooltip>
          )}
      </Stack>
      {HAS_POST.has(job.status) && <PostLinkField job={job} onSaved={onSaved} autoFocus={focusLink} />}
    </Box>
  );
}

export default function Queue({ onChange }) {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const [focusLink, setFocusLink] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.jobs(filter).then(setJobs).catch((e) => setError(e.message)), [filter]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function onAction(id, action) {
    setError('');
    try {
      if (action === 'remove') { await api.removeJob(id); setOpen(null); } else await api.jobAction(id, action);
      await load();
      onChange();
    } catch (e) { setError(e.message); }
  }

  return (
    <Stack spacing={2}>
      <Box sx={{ overflowX: 'auto' }}>
        <ToggleButtonGroup exclusive size="small" value={filter} onChange={(_, v) => v !== null && setFilter(v)}
          sx={{ bgcolor: '#fff', '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 650, px: 1.75, borderColor: 'divider', whiteSpace: 'nowrap' },
            '& .Mui-selected': { bgcolor: '#15171C !important', color: '#fff !important' } }}>
          {FILTERS.map((f) => <ToggleButton key={f} value={f}>{f ? STATUS_LABEL[f] : 'All'}</ToggleButton>)}
        </ToggleButtonGroup>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ overflow: 'hidden' }}>
        {!jobs.length && <EmptyState icon={ListChecks} title="Nothing here yet" />}
        {jobs.map((j, i) => {
          const isOpen = open === j.id;
          const waiting = j.status === 'queued' && new Date(j.scheduled_at) < new Date(Date.now() - 2 * 60_000);
          return (
            <Box key={j.id} sx={{ borderTop: i ? 1 : 0, borderColor: 'divider', bgcolor: isOpen ? '#FCFBF8' : 'transparent' }}>
              <Stack direction="row" alignItems="center" sx={{ pr: { xs: 1.5, md: 2 }, '&:hover': { bgcolor: '#FCFBF8' } }}>
              <Box role="button" tabIndex={0} aria-expanded={isOpen}
                onClick={() => { setFocusLink(false); setOpen(isOpen ? null : j.id); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setFocusLink(false); setOpen(isOpen ? null : j.id); } }}
                sx={{ all: 'unset', boxSizing: 'border-box', flex: 1, minWidth: 0, cursor: 'pointer', display: 'grid', alignItems: 'center',
                  gap: { xs: 1, md: 2 }, pl: { xs: 2, md: 2.5 }, pr: 1, py: 1.75, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                  gridTemplateColumns: { xs: 'auto 1fr', md: '150px 190px minmax(0,1fr) minmax(0,1.4fr)' } }}>
                <Box><StatusChip status={j.status} /></Box>
                <Box sx={{ display: { xs: 'none', md: 'block' } }}>
                  <Typography fontSize={13} fontWeight={600}>{formatWhen(j.scheduled_at)}</Typography>
                  {waiting && !j.destination_archived && <Chip size="small" label="waiting" sx={{ mt: 0.5, height: 20, fontSize: 11 }} />}
                  {Boolean(j.destination_archived) && <Chip size="small" label="Destination removed" sx={{ mt: 0.5, height: 20, fontSize: 11 }} />}
                </Box>
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
                  <TypeBadge type={j.destination_type} withLabel={false} />
                  <Tooltip title={`Open on ${PLATFORMS[j.destination_platform]?.label ?? 'Facebook'}`}>
                    <Link href={j.destination_url} target="_blank" rel="noreferrer" color="inherit" underline="hover" noWrap
                      onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 700, fontSize: 14, minWidth: 0 }}>
                      {j.destination_name}
                    </Link>
                  </Tooltip>
                </Stack>
                <Typography fontSize={13} color="text.secondary" noWrap sx={{ display: { xs: 'none', md: 'block' } }}>{j.post_body}</Typography>
              </Box>
              <Box sx={{ width: { xs: 'auto', md: 116 }, display: 'flex', justifyContent: 'flex-end', flex: 'none' }}>
                <RowLink job={j} onAddLink={() => { setFocusLink(true); setOpen(j.id); }} />
              </Box>
              <IconButton size="small" onClick={() => { setFocusLink(false); setOpen(isOpen ? null : j.id); }}
                aria-label={isOpen ? 'Collapse' : 'Expand'} sx={{ ml: 0.5, transition: 'transform .2s', transform: isOpen ? 'rotate(180deg)' : 'none' }}>
                <ChevronDown size={18} />
              </IconButton>
              </Stack>
              <Collapse in={isOpen} unmountOnExit>{isOpen && <JobDetail job={j} onAction={onAction} onSaved={load} focusLink={focusLink} />}</Collapse>
            </Box>
          );
        })}
      </Paper>
    </Stack>
  );
}
