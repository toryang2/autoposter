import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, ButtonBase, Link, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { Activity, CalendarClock, CircleCheck, CircleX, MapPin, TriangleAlert } from 'lucide-react';
import { api, formatWhen, inApp, PLATFORMS } from '../api.js';
import { EmptyState, JobStatusChip, Panel, TypeBadge, WorkerControl } from '../components.jsx';

function Stat({ label, value, icon: Icon, tone = '#15171C', onClick }) {
  return (
    <ButtonBase onClick={onClick} sx={{ borderRadius: 3, textAlign: 'left', display: 'block' }}>
      <Paper sx={{ p: 2.25, height: '100%', transition: 'transform .15s, border-color .15s, box-shadow .15s',
        '&:hover': { transform: 'translateY(-2px)', borderColor: tone, boxShadow: `0 10px 24px -16px ${tone}` } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Typography variant="body2" color="text.secondary" fontWeight={600}>{label}</Typography>
          <Box sx={{ color: tone, opacity: 0.85 }}><Icon size={18} /></Box>
        </Stack>
        <Typography variant="h3" sx={{ mt: 1.5, color: tone }}>{value}</Typography>
      </Paper>
    </ButtonBase>
  );
}

// The name opens the post (or the group) inside Autoposter; the rest of the row opens the Queue.
function JobList({ jobs, empty, emptyIcon, useFinished, onOpen }) {
  if (!jobs.length) return <EmptyState icon={emptyIcon} title={empty} />;
  return (
    <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
      {jobs.map((j) => (
        <Stack key={j.id} direction="row" alignItems="flex-start" spacing={1.5} onClick={onOpen}
          sx={{ py: 1.5, px: 1, mx: -1, borderRadius: 2, cursor: 'pointer', '&:hover': { bgcolor: 'background.default' } }}>
          <TypeBadge type={j.destination_type} withLabel={false} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Tooltip title={j.post_url ? 'Open the post' : `Open on ${PLATFORMS[j.destination_platform]?.label ?? 'Facebook'}`}>
              <Link href={inApp(j.post_url || j.destination_url, j.account_ref)} target="_blank" rel="noreferrer" color="inherit" underline="hover"
                onClick={(e) => e.stopPropagation()} sx={{ display: 'block', fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.destination_name}
              </Link>
            </Tooltip>
            <Typography variant="caption" color="text.secondary" component="div"
              sx={{ mt: 0.25, lineHeight: 1.5, whiteSpace: 'pre-line', overflowWrap: 'anywhere',
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {j.post_body || '(media only)'}
            </Typography>
          </Box>
          <Stack alignItems="flex-end" spacing={0.5} sx={{ flex: 'none' }}>
            <JobStatusChip job={j} />
            <Typography variant="caption" color="text.secondary">
              {formatWhen(useFinished ? j.finished_at || j.scheduled_at : j.scheduled_at)}
            </Typography>
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}

export default function Overview({ status, go, onStatusChange, setup }) {
  const [jobs, setJobs] = useState([]);
  const [destCount, setDestCount] = useState(null);

  useEffect(() => {
    const load = () => api.jobs().then(setJobs).catch(() => {});
    load();
    api.destinations().then((d) => setDestCount(d.filter((x) => x.enabled).length)).catch(() => {});
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const c = status?.counts || {};
  const upcoming = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
    .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, 6);
  const recent = jobs.filter((j) => !['queued', 'running'].includes(j.status))
    .sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || '')).slice(0, 6);

  return (
    <Stack spacing={2.5}>
      <Box className="stagger" sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(5, 1fr)' } }}>
        <Stat label="Posted today" value={status ? `${status.posted_today}/${status.daily_cap}` : '–'} icon={CircleCheck} tone="#147A46" onClick={() => go('queue', { filter: 'submitted' })} />
        <Stat label="Queued" value={c.queued || 0} icon={CalendarClock} onClick={() => go('queue', { filter: 'queued' })} />
        <Stat label="Needs check" value={c.needs_check || 0} icon={TriangleAlert} tone={c.needs_check ? '#C77A00' : '#15171C'} onClick={() => go('queue', { filter: 'needs_check' })} />
        <Stat label="Failed" value={c.failed || 0} icon={CircleX} tone={c.failed ? '#C42B1C' : '#15171C'} onClick={() => go('queue', { filter: 'failed' })} />
        <Stat label="Destinations" value={destCount ?? '–'} icon={MapPin} onClick={() => go('destinations')} />
      </Box>

      {setup?.readiness && !setup.readiness.ready && (
        <Alert severity="warning" variant="outlined" sx={{ bgcolor: '#FFF8EC', alignItems: 'center' }}
          action={<Button color="inherit" size="small" onClick={() => go('setup')}>Open Setup</Button>}>
          <b>Not ready to post.</b> Scheduled posts are on hold until Setup is finished
          ({setup.readiness.checks.filter((c) => c.ok).length} of {setup.readiness.checks.length} checks passed).
        </Alert>
      )}

      {status && !status.worker_running && setup?.readiness?.ready !== false && (
        <Alert severity="warning" variant="outlined" sx={{ bgcolor: '#FFF8EC', alignItems: 'center' }}
          action={<WorkerControl status={status} onChange={onStatusChange} size="small" />}>
          The worker isn't running, so scheduled posts won't go out
          {status.overdue ? <> — <b>{status.overdue} {status.overdue === 1 ? 'is' : 'are'} overdue</b></> : ''}.
          To keep it running after restarts, use <b>bash scripts/install-launchd.sh</b> once.
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }, alignItems: 'start' }}>
        <Panel title="Up next" action={<Button size="small" onClick={() => go('queue')}>View all</Button>}>
          <JobList jobs={upcoming} empty="Nothing scheduled" emptyIcon={CalendarClock} onOpen={() => go('queue')} />
        </Panel>
        <Panel title="Recent results" action={<Button size="small" onClick={() => go('queue')}>View all</Button>}>
          <JobList jobs={recent} empty="No posts have run yet" emptyIcon={Activity} useFinished onOpen={() => go('queue')} />
        </Panel>
      </Box>
    </Stack>
  );
}
