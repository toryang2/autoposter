import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import { CircleCheck, CircleX, Globe, Circle, PlugZap, Download, ExternalLink, LogIn, Play, RefreshCw, ShieldCheck, ShieldAlert, SquareTerminal, Workflow } from 'lucide-react';
import { api } from '../api.js';
import { Panel, WorkerControl } from '../components.jsx';

const CHROME_EXTENSION_URL = 'https://claude.ai/chrome';

const PLAN_LABEL = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

// Logged in with a Claude subscription (not an API key) on a plan that includes Claude Code.
export function claudeReady(s) {
  return Boolean(s?.claude_installed && s.logged_in && s.subscription && s.paid_plan !== false);
}

// Every readiness check passed: installed, subscription login, extension, test automation. Scheduled posts need it.
export function setupReady(s) {
  return Boolean(s?.readiness?.ready);
}

function ReadinessCard({ readiness, verifiedAt }) {
  const passed = readiness.checks.filter((c) => c.ok).length;
  const ready = readiness.ready;
  const Icon = ready ? ShieldCheck : ShieldAlert;
  return (
    <Paper sx={{ p: { xs: 2, md: 2.5 }, borderLeft: 4, borderColor: ready ? 'success.main' : 'warning.main' }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Box sx={{ color: ready ? 'success.main' : 'warning.main', flex: 'none' }}><Icon size={28} /></Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h2">{ready ? 'Ready to post' : 'Not ready to post yet'}</Typography>
          <Typography color="text.secondary" fontSize={14}>
            {ready
              ? `All ${readiness.checks.length} checks passed${verifiedAt ? `; test automation passed ${new Date(verifiedAt).toLocaleString()}` : ''}. Scheduled posts can go out.`
              : `${passed} of ${readiness.checks.length} checks passed. Scheduled posts stay on hold until all of them do.`}
          </Typography>
        </Box>
      </Stack>
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, mt: 1.75, display: 'grid', gap: 0.75,
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        {readiness.checks.map((c) => (
          <Stack key={c.id} component="li" direction="row" spacing={1} alignItems="center"
            sx={{ color: c.ok ? 'success.main' : 'text.secondary', fontSize: 14 }}>
            {c.ok ? <CircleCheck size={17} /> : <CircleX size={17} />}
            <Typography fontSize={14} color={c.ok ? 'text.primary' : 'text.secondary'}>{c.label}</Typography>
          </Stack>
        ))}
      </Box>
    </Paper>
  );
}

function Step({ n, done, title, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 2.25, borderTop: n > 1 ? 1 : 0, borderColor: 'divider' }}>
      <Box sx={{ pt: 0.25, color: done ? 'success.main' : 'text.disabled', flex: 'none' }}>
        {done ? <CircleCheck size={22} /> : <Circle size={22} />}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography fontWeight={700}>{n}. {title}</Typography>
        <Box sx={{ mt: 0.75, color: 'text.secondary', fontSize: 14 }}>{children}</Box>
      </Box>
    </Stack>
  );
}

export default function Setup({ status, onStatusChange, go, onSetupChange }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState(false);
  const [chromeTest, setChromeTest] = useState(null); // null | 'running' | { ok, browsers, error }
  const [autoTest, setAutoTest] = useState(null); // null | 'running' | { ok, facebook_signed_in, note, error }
  // A passing connection test goes straight on to the test automation (step 4) if it hasn't passed yet,
  // so the last readiness check doesn't stay unticked without the person noticing step 4.
  async function testChrome() {
    setChromeTest('running');
    let r;
    try { r = await api.testChrome(); } catch (e) { r = { ok: false, error: e.message }; }
    setChromeTest(r);
    if (r.ok && !s.verified_at) testAutomation();
  }
  async function testAutomation() {
    setAutoTest('running');
    try {
      const r = await api.testAutomation();
      setAutoTest(r);
      setS(r.setup);
      onSetupChange?.(r.setup);
    } catch (e) {
      setAutoTest({ ok: false, error: e.message });
    }
  }

  const check = useCallback(async () => {
    setChecking(true);
    setError('');
    try { const next = await api.setup(); setS(next); onSetupChange?.(next); } catch (e) { setError(e.message); } finally { setChecking(false); }
  }, [onSetupChange]);
  useEffect(() => { check(); }, [check]);

  // While a terminal step is open, keep checking so the ticks turn green on their own.
  useEffect(() => {
    if (!note) return undefined;
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, [note, check]);

  async function run(action, message) {
    setError('');
    try { await action(); setNote(message); } catch (e) { setError(e.message); }
  }

  if (!s) return error ? <Alert severity="error">{error}</Alert> : null;
  const win = s.platform === 'win32';
  const terminal = win ? 'PowerShell' : 'Terminal';

  return (
    <Stack spacing={2.5} sx={{ maxWidth: 820 }}>
      {s.readiness && <ReadinessCard readiness={s.readiness} verifiedAt={s.verified_at} />}
      {!setupReady(s) && (
        <Alert severity="info">Autoposter uses Claude Code with your own Claude subscription (Pro or Max). No API key. This takes about 5 minutes, once.</Alert>
      )}
      {note && <Alert severity="info" onClose={() => setNote('')}>{note}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}

      <Panel title="Get ready" action={
        <Button size="small" color="secondary" startIcon={<RefreshCw size={15} className={checking ? 'spin' : undefined} />} onClick={check} disabled={checking}>
          Check again
        </Button>
      }>
        <Step n={1} done={s.claude_installed} title="Install Claude Code">
          {s.claude_installed ? (
            <>Found at <Box component="code" sx={{ fontSize: 12, wordBreak: 'break-all' }}>{s.claude_path}</Box></>
          ) : (
            <>
              <Typography fontSize={14} mb={1.25}>
                This opens {terminal} and runs Anthropic's official installer. When it says it's done, come back here.
              </Typography>
              <Button variant="contained" startIcon={<Download size={16} />}
                onClick={() => run(api.installClaude, `Installing Claude Code in ${terminal}. This page updates when it's done.`)}>
                Install Claude Code
              </Button>
            </>
          )}
        </Step>

        <Step n={2} done={claudeReady(s)} title="Log in with your Claude subscription">
          {claudeReady(s) && (
            <>Logged in{s.email ? ` as ${s.email}` : ''} on Claude {PLAN_LABEL[s.plan] || 'subscription'}{s.plan ? '' : ' (plan not reported by this Claude Code version)'}.</>
          )}
          {s.logged_in && !s.subscription && (
            <Alert severity="warning" sx={{ mb: 1.25 }}>
              Claude Code is logged in with {s.auth_method || 'an API key'}, which bills API usage. Log in again and choose your Claude account.
            </Alert>
          )}
          {s.logged_in && s.subscription && s.paid_plan === false && (
            <Alert severity="warning" sx={{ mb: 1.25 }}
              action={<Button color="inherit" size="small" href="https://claude.ai/upgrade" target="_blank" rel="noreferrer">Upgrade</Button>}>
              Your Claude account is on the {PLAN_LABEL[s.plan] || s.plan} plan. Claude Code with Chrome needs Claude Pro or Max.
              Upgrade, then click Check again.
            </Alert>
          )}
          {!(s.logged_in && s.subscription) && (
            <>
              <Typography fontSize={14} mb={1.25}>
                Opens {terminal} and your browser. Sign in with the Claude account that has your Pro or Max plan.
              </Typography>
              <Button variant="contained" startIcon={<LogIn size={16} />} disabled={!s.claude_installed}
                onClick={() => run(api.loginClaude, 'Finish signing in in your browser. This page updates when you are logged in.')}>
                Log in
              </Button>
            </>
          )}
        </Step>

        <Step n={3} done={s.app_accounts > 0 || (Boolean(s.chrome_extension?.length) && chromeTest?.ok === true)}
          title={s.app ? 'Log in to your accounts in Autoposter' : 'Install Claude in Chrome and connect it'}>
          {s.app && (
            <>
              <Typography fontSize={14} mb={1.25}>
                {s.app_accounts > 0
                  ? <><strong>{s.app_accounts} account{s.app_accounts === 1 ? '' : 's'} logged in</strong> inside Autoposter. Posts from them don't need Chrome.</>
                  : <>Add the accounts you post from, then click <strong>Log in</strong> next to each one. Each logs in once right here inside
                      Autoposter and stays logged in. No Chrome or extension needed.</>}
              </Typography>
              <Button variant={s.app_accounts > 0 ? 'outlined' : 'contained'} color={s.app_accounts > 0 ? 'secondary' : 'primary'}
                startIcon={<LogIn size={16} />} onClick={() => go('accounts')} sx={{ mb: 2 }}>
                Open Accounts
              </Button>
              <Typography variant="caption" color="text.secondary" display="block" mb={1}>
                Or, instead, post through your own Chrome with the Claude in Chrome extension:
              </Typography>
            </>
          )}
          {s.chrome_extension?.length ? (
            <Typography fontSize={14} mb={1.25}>
              <strong>Installed</strong> in {s.chrome_extension.map((e) => `${e.browser} (${e.profile})`).join(', ')}.
              Sign in to the extension with the same Claude account, keep that Chrome open when posts are due, and log it in to
              every account you'll post to.
            </Typography>
          ) : (
            <>
              <Alert severity="warning" sx={{ mb: 1.25 }}>
                The Claude in Chrome extension isn't installed in Chrome on this computer yet.
              </Alert>
              <Typography fontSize={14} mb={1.25}>
                Install it, sign in to it with the same Claude account, then click Check again.
              </Typography>
            </>
          )}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {!s.chrome_extension?.length && (
              <Button variant="contained" startIcon={<Globe size={16} />} endIcon={<ExternalLink size={14} />}
                href={CHROME_EXTENSION_URL} target="_blank" rel="noreferrer">
                Get Claude in Chrome
              </Button>
            )}
            <Button variant={s.chrome_extension?.length ? 'contained' : 'outlined'} color={s.chrome_extension?.length ? 'primary' : 'secondary'}
              startIcon={<PlugZap size={16} />} disabled={!claudeReady(s) || chromeTest === 'running'} onClick={testChrome}>
              {chromeTest === 'running' ? 'Testing… (up to a minute)' : 'Test connection'}
            </Button>
          </Stack>
          {chromeTest && chromeTest !== 'running' && (chromeTest.ok
            ? <Alert severity="success" sx={{ mt: 1.25 }}>
                Connected: Claude can reach {chromeTest.browsers} Chrome browser{chromeTest.browsers === 1 ? '' : 's'}.
                {autoTest === 'running' && ' Now running the test automation (step 4)…'}
              </Alert>
            : <Alert severity="error" sx={{ mt: 1.25 }}>
                Claude couldn't reach Chrome{chromeTest.error ? `: ${chromeTest.error}` : '.'} Open Chrome, make sure the extension is
                signed in to your Claude account, then test again.
              </Alert>)}
          <Typography variant="caption" color="text.secondary" display="block" mt={1}>
            The test asks Claude to list your connected browsers. It takes a few seconds and a tiny bit of your Claude usage.
          </Typography>
        </Step>

        <Step n={4} done={Boolean(s.readiness?.checks.find((c) => c.id === 'automation')?.ok)} title="Run a test automation">
          <Typography fontSize={14} mb={1.25}>
            {s.app_accounts > 0
              ? 'Claude opens one of your logged-in accounts in a hidden Autoposter window and checks it is signed in.'
              : "Claude opens a new tab in your Chrome, loads Facebook, checks whether you're signed in and closes the tab."}{' '}
            It doesn't post, like or click anything.
          </Typography>
          <Button variant="contained" startIcon={<Workflow size={16} />}
            disabled={!claudeReady(s) || (!s.chrome_extension?.length && !(s.app_accounts > 0)) || autoTest === 'running'} onClick={testAutomation}>
            {autoTest === 'running' ? 'Running… (up to 4 minutes)' : s.verified_at ? 'Run the test again' : 'Run test automation'}
          </Button>
          {autoTest && autoTest !== 'running' && (autoTest.ok
            ? <Alert severity={autoTest.facebook_signed_in ? 'success' : 'warning'} sx={{ mt: 1.25 }}>
                Claude drove the browser end to end.{' '}
                {autoTest.facebook_signed_in
                  ? 'The account is signed in, so scheduled posts can go out.'
                  : "The account isn't signed in there. Log in to every account you'll post from before posts are due."}
                {autoTest.note ? ` (${autoTest.note})` : ''}
              </Alert>
            : <Alert severity="error" sx={{ mt: 1.25 }}>
                The test didn't pass{autoTest.error ? `: ${autoTest.error}` : '.'} Fix that and run it again.
              </Alert>)}
          <Typography variant="caption" color="text.secondary" display="block" mt={1}>
            Uses a little of your Claude usage. Run it again after you change Claude accounts or reinstall the extension.
            Want to see a real post? Add your profile with the audience <strong>Only me</strong> in{' '}
            <Link component="button" onClick={() => go('destinations')}>Destinations</Link>, write one in{' '}
            <Link component="button" onClick={() => go('compose')}>Compose</Link> and press <strong>Post now</strong> in the Queue.
          </Typography>
        </Step>

        <Step n={5} done={Boolean(status?.worker_running)} title="Start the worker">
          <Typography fontSize={14} mb={1.25}>
            The worker posts everything at its scheduled time. {s.app
              ? 'It keeps running while Autoposter is in the menu bar or system tray, and starts again when you reopen the app.'
              : 'Keep this computer awake and Chrome open.'}
          </Typography>
          {status && !status.worker_running && (
            <WorkerControl status={status} onChange={onStatusChange}
              blocked={setupReady(s) ? null : 'Finish steps 1–4 first: scheduled posts are on hold until every check passes'} />
          )}
          {!setupReady(s) && (
            <Typography variant="caption" color="text.secondary" display="block" mt={1}>
              Available once steps 1–4 pass.
            </Typography>
          )}
          {status?.worker_running && <Chip color="success" icon={<Play size={14} />} label="Worker running" />}
        </Step>
      </Panel>

      <Typography variant="caption" color="text.secondary">
        <SquareTerminal size={13} style={{ verticalAlign: '-2px' }} /> Each post is a real Claude session in your Chrome and counts toward
        your plan's usage limits. Social networks restrict automation, so keep the daily cap low.
      </Typography>
    </Stack>
  );
}
