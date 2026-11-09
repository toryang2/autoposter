import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, InputAdornment, MenuItem, Snackbar, Stack, TextField, Typography } from '@mui/material';
import { CalendarX, Clock3, Gauge, Hourglass, RotateCcw, Sparkles, Timer, UsersRound } from 'lucide-react';
import { api, formatWhen } from '../api.js';
import { Panel } from '../components.jsx';

const FIELDS = [
  ['daily_cap', 'Max posts per day', 'posts', Gauge, 'Across all destinations. Protects your Facebook account and your Claude usage.'],
  ['group_gap_minutes', 'Gap between group posts', 'min', UsersRound, 'Between Facebook groups, subreddits and LinkedIn groups on the same platform. Many at once looks like spam.'],
  ['max_attempts', 'Attempts per post', 'tries', RotateCcw, 'Only retried when Claude confirms it never clicked Post.'],
  ['job_timeout_min', 'Stop a run after', 'min', Timer, 'Videos need longer. A stopped run is marked "Needs check".'],
];
const JOIN_FIELDS = [
  ['join_recheck_hours', 'Check a join request every', 'hours', Clock3, 'Only between 7am and 10pm. The post goes out on the first check after the group accepts.'],
  ['join_wait_days', 'Give up on a join request after', 'days', CalendarX, 'Then the post is marked Failed. You can still press Retry if you get in later.'],
];

export default function Settings({ onChange }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.settings().then(setS).catch((e) => setError(e.message)); }, []);
  if (!s) return error ? <Alert severity="error">{error}</Alert> : null;

  async function save(e) {
    e.preventDefault();
    setError('');
    try {
      const { paused_until, ...rest } = s;
      setS(await api.saveSettings(rest));
      setSaved(true);
      onChange();
    } catch (err) { setError(err.message); }
  }
  async function resume() {
    setS(await api.saveSettings({ paused_until: '' }));
    onChange();
  }

  const paused = s.paused_until && new Date(s.paused_until) > new Date();

  return (
    <Box component="form" onSubmit={save} sx={{ maxWidth: 860 }}>
      <Stack spacing={2.5}>
        {paused && (
          <Alert severity="warning" icon={<Hourglass size={20} />} action={<Button color="inherit" onClick={resume}>Resume now</Button>}>
            Paused until {formatWhen(s.paused_until)} after hitting a Claude usage limit.
          </Alert>
        )}
        <Panel title="Pacing and safety">
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            {FIELDS.map(([key, label, unit, Icon, help]) => (
              <TextField key={key} type="number" label={label} value={s[key]} helperText={help}
                onChange={(e) => setS({ ...s, [key]: e.target.value })}
                slotProps={{ input: {
                  startAdornment: <InputAdornment position="start"><Icon size={17} /></InputAdornment>,
                  endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                } }} />
            ))}
          </Box>
        </Panel>
        <Panel title="Joining groups">
          <Typography fontSize={14} color="text.secondary" mb={2.5}>
            When a group needs you to join before posting, Claude joins first and answers the group's questions from the
            description below. It never gives a phone number, email, address or ID; a group that asks for one is skipped.
          </Typography>
          <TextField fullWidth multiline minRows={3} label="How Claude describes you to group admins" value={s.join_about}
            onChange={(e) => setS({ ...s, join_about: e.target.value })}
            helperText="Keep it true. Used to answer questions such as “Why do you want to join?” or “Are you a landlord?”" sx={{ mb: 3 }} />
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            {JOIN_FIELDS.map(([key, label, unit, Icon, help]) => (
              <TextField key={key} type="number" label={label} value={s[key]} helperText={help}
                onChange={(e) => setS({ ...s, [key]: e.target.value })}
                slotProps={{ input: {
                  startAdornment: <InputAdornment position="start"><Icon size={17} /></InputAdornment>,
                  endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                } }} />
            ))}
          </Box>
        </Panel>
        <Panel title="Claude">
          <TextField select fullWidth label="Model" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })}
            helperText="Runs on your Claude subscription through Claude Code with Chrome. No API key is used."
            slotProps={{ input: { startAdornment: <InputAdornment position="start"><Sparkles size={17} /></InputAdornment> } }}>
            <MenuItem value="sonnet">Sonnet — recommended</MenuItem>
            <MenuItem value="opus">Opus — most capable, uses more of your plan</MenuItem>
            <MenuItem value="haiku">Haiku — lightest, less reliable on Facebook</MenuItem>
          </TextField>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 3 }}>
            Which Facebook (or other) account posts is set on the <a href="#accounts">Accounts</a> page, and per post in Compose.
          </Typography>
        </Panel>
        {error && <Alert severity="error">{error}</Alert>}
        <Box><Button type="submit" variant="contained" size="large">Save settings</Button></Box>
      </Stack>
      <Snackbar open={saved} autoHideDuration={2500} onClose={() => setSaved(false)} message="Settings saved"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} />
      <Typography variant="caption" color="text.secondary" display="block" mt={3}>
        Changes apply to the next run the worker starts.
      </Typography>
    </Box>
  );
}
