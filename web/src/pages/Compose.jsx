import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, IconButton, LinearProgress, Paper, Stack, TextField, Typography,
} from '@mui/material';
import { Film, ImagePlus, MapPin, Send, UserRound, X } from 'lucide-react';
import { api, mediaProblem as platformMediaProblem, PLATFORMS, typeLabel } from '../api.js';
import { EmptyState, Panel, TypeBadge } from '../components.jsx';

const MAX_BYTES = 10 * 1024 * 1024;

// "Who" posts in Facebook groups: each group's own setting, yourself, or one of your Pages.
const GROUP_DEFAULT = "Each group's setting";
const MYSELF = 'Myself';
const whoValue = (label) => (label === GROUP_DEFAULT ? '' : label === MYSELF ? '@self' : label.trim());
const whoLabel = (value) => (!value ? GROUP_DEFAULT : value === '@self' ? MYSELF : value);

function localInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export default function Compose({ onScheduled, goDestinations, initialWhen }) {
  const [destinations, setDestinations] = useState(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [when, setWhen] = useState(() => localInputValue(initialWhen || new Date(Date.now() + 15 * 60_000)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState('');
  const [firstComment, setFirstComment] = useState('');
  const [whoText, setWhoText] = useState(GROUP_DEFAULT);

  useEffect(() => { api.destinations().then(setDestinations).catch((e) => setError(e.message)); }, []);

  const enabled = (destinations || []).filter((d) => d.enabled && PLATFORMS[d.platform]?.posting);
  const previews = useMemo(() => files.map((f) => ({ f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const hasVideo = files.some((f) => f.type.startsWith('video/'));
  const mediaProblem =
    totalBytes > MAX_BYTES ? 'Attachments must total 10 MB or less (Chrome upload limit).'
    : hasVideo && files.length > 1 ? 'Attach either one video or images, not both.'
    : '';
  const groupCount = enabled.filter((d) => selected.has(d.id) && d.type === 'group').length;
  const pageNames = (destinations || []).filter((d) => d.platform === 'facebook' && d.type === 'page').map((d) => d.name);
  // Who actually posts in a Facebook group: this post's choice, else the group's own setting.
  const groupAuthor = (d) => (who === '@self' ? null : who || d.post_as || null);
  const kinds = files.map((f) => (f.type.startsWith('video/') ? 'video' : 'image'));
  // Per-platform rules: Instagram needs media, TikTok needs a video, X takes 4 photos.
  const platformProblems = [...new Set(enabled.filter((d) => selected.has(d.id)).map((d) => d.platform))]
    .map((pf) => platformMediaProblem(pf, kinds)).filter(Boolean);
  const hints = [...new Set(enabled.filter((d) => selected.has(d.id)).map((d) => PLATFORMS[d.platform].hint).filter(Boolean))];

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('body', body);
      form.append('scheduled_at', new Date(when).toISOString());
      if (who) form.append('post_as', who);
      if (firstComment.trim()) form.append('first_comment', firstComment.trim());
      for (const id of selected) form.append('destination_ids', String(id));
      for (const f of files) form.append('media', f);
      await api.createPost(form);
      setBody(''); setFiles([]); setSelected(new Set()); setWho(''); setFirstComment(''); setWhoText(GROUP_DEFAULT);
      onScheduled();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (destinations && !destinations.length) {
    return (
      <Paper>
        <EmptyState icon={MapPin} title="Add somewhere to post first">
          <Typography variant="body2">Save your profile, Pages and groups, then come back to schedule.</Typography>
          <Button variant="contained" onClick={goDestinations} sx={{ mt: 1 }}>Add a destination</Button>
        </EmptyState>
      </Paper>
    );
  }

  const canSubmit = !busy && !mediaProblem && !platformProblems.length && selected.size && (body.trim() || files.length);

  return (
    <Box component="form" onSubmit={submit}
      sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' }, alignItems: 'start' }}>
      <Panel title="Post">
        <TextField multiline minRows={9} fullWidth placeholder="What do you want to post?"
          value={body} onChange={(e) => setBody(e.target.value)} />
        <Stack direction="row" alignItems="center" justifyContent="space-between" mt={2} spacing={2}>
          <Button component="label" variant="outlined" color="secondary" startIcon={<ImagePlus size={18} />}>
            Add photos or a video
            <input hidden type="file" accept="image/*,video/*" multiple
              onChange={(e) => { setFiles([...files, ...e.target.files].slice(0, 10)); e.target.value = ''; }} />
          </Button>
          <Box sx={{ width: 140 }}>
            <Typography variant="caption" color={totalBytes > MAX_BYTES ? 'error' : 'text.secondary'}>
              {(totalBytes / 1024 / 1024).toFixed(1)} of 10 MB
            </Typography>
            <LinearProgress variant="determinate" value={Math.min(100, (totalBytes / MAX_BYTES) * 100)}
              color={totalBytes > MAX_BYTES ? 'error' : 'primary'} sx={{ height: 5, borderRadius: 3, mt: 0.5 }} />
          </Box>
        </Stack>
        {previews.length > 0 && (
          <Stack direction="row" flexWrap="wrap" gap={1.25} mt={2}>
            {previews.map(({ f, url }, i) => (
              <Box key={url} sx={{ position: 'relative', width: 104, height: 104, borderRadius: 2.5, overflow: 'hidden',
                border: 1, borderColor: 'divider' }}>
                {f.type.startsWith('video/')
                  ? <><video src={url} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <Box sx={{ position: 'absolute', left: 6, bottom: 6, color: '#fff' }}><Film size={16} /></Box></>
                  : <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                <IconButton size="small" aria-label="Remove" onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'rgba(0,0,0,.55)', color: '#fff', '&:hover': { bgcolor: 'rgba(0,0,0,.75)' } }}>
                  <X size={14} />
                </IconButton>
              </Box>
            ))}
          </Stack>
        )}
        {mediaProblem && <Alert severity="error" sx={{ mt: 2 }}>{mediaProblem}</Alert>}
        <TextField multiline minRows={2} fullWidth label="First comment (optional)" sx={{ mt: 2.5 }}
          placeholder="e.g. Get it here: https://…"
          value={firstComment} onChange={(e) => setFirstComment(e.target.value)}
          helperText="Claude adds this as the first comment right after the post is live. Put links here: many groups don't allow links in posts." />
      </Panel>

      <Stack spacing={2.5}>
        <Panel title="Who">
          <Autocomplete freeSolo autoSelect disableClearable
            options={[GROUP_DEFAULT, MYSELF, ...pageNames.filter((n) => n !== MYSELF && n !== GROUP_DEFAULT)]}
            value={whoLabel(who)} inputValue={whoText}
            onInputChange={(_, v) => setWhoText(v)}
            onChange={(_, v) => { const next = whoValue(v || GROUP_DEFAULT); setWho(next); setWhoText(whoLabel(next)); }}
            renderInput={(params) => (
              <TextField {...params} placeholder="Myself or a Page name"
                slotProps={{ input: { ...params.InputProps, startAdornment: <Box sx={{ ml: 0.5, mr: 0.5, display: 'flex', color: 'text.secondary' }}><UserRound size={17} /></Box> } }} />
            )} />
          <Typography variant="caption" color="text.secondary" display="block" mt={1.25}>
            Who posts in your Facebook groups: yourself or one of your Pages (type the Page's name exactly as Facebook shows it).
            Profiles, Pages and other platforms always post as that account.
          </Typography>
        </Panel>

        <Panel title="Where" action={<Typography variant="caption" color="text.secondary">{selected.size} selected</Typography>}>
          <Stack spacing={0.75} sx={{ maxHeight: 340, overflowY: 'auto', mx: -1, px: 1 }}>
            {enabled.map((d) => {
              const on = selected.has(d.id);
              return (
                <Box key={d.id} component="label" sx={{
                  display: 'flex', alignItems: 'center', gap: 1.25, p: 1, pr: 1.5, borderRadius: 2.5, cursor: 'pointer',
                  border: 1, borderColor: on ? 'primary.main' : 'transparent', bgcolor: on ? '#FFF3EE' : 'transparent',
                  transition: 'all .15s', '&:hover': { bgcolor: on ? '#FFF3EE' : 'background.default' } }}>
                  <Checkbox size="small" checked={on} onChange={() => toggle(d.id)} sx={{ p: 0.5 }} />
                  <TypeBadge type={d.type} withLabel={false} />
                  <Typography fontWeight={650} fontSize={14} noWrap sx={{ flex: 1 }}>{d.name}</Typography>
                  {d.platform === 'facebook' && d.type === 'group' && groupAuthor(d) && (
                    <Typography variant="caption" color="primary.main" fontWeight={650} noWrap sx={{ flex: 'none', maxWidth: 140 }}>as {groupAuthor(d)}</Typography>
                  )}
                  {d.platform !== 'facebook' && (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 'none' }}>
                      {PLATFORMS[d.platform].label}{d.type !== 'profile' ? ` · ${typeLabel(d.platform, d.type)}` : ''}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
          {platformProblems.map((m) => <Alert key={m} severity="warning" sx={{ mt: 1.5 }}>{m}. Add one or untick it.</Alert>)}
          {hints.map((h) => <Typography key={h} variant="caption" color="text.secondary" display="block" mt={1.5}>{h}</Typography>)}
          {groupCount > 1 && (
            <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
              {groupCount} groups go out one at a time, spaced by the group gap in Settings (per platform), to avoid spam flags.
            </Typography>
          )}
        </Panel>

        <Panel title="When">
          <TextField type="datetime-local" fullWidth value={when} onChange={(e) => setWhen(e.target.value)} required />
          <Typography variant="caption" color="text.secondary" display="block" mt={1.25}>
            Your Mac must be on and awake, with Chrome open and signed in to Facebook.
          </Typography>
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          <Button type="submit" variant="contained" size="large" fullWidth disabled={!canSubmit}
            startIcon={<Send size={18} />} sx={{ mt: 2.5, py: 1.25 }}>
            {busy ? 'Scheduling…' : selected.size ? `Schedule to ${selected.size} destination${selected.size === 1 ? '' : 's'}` : 'Pick a destination'}
          </Button>
        </Panel>
      </Stack>
    </Box>
  );
}
