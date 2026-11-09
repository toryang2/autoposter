import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, LinearProgress, ListSubheader, MenuItem, Paper,
  Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { Check, ChevronDown, Film, ImagePlus, MapPin, RotateCcw, Search, Send, Sparkles, X } from 'lucide-react';
import { createFilterOptions } from '@mui/material/Autocomplete';
import { api, mediaProblem as platformMediaProblem, PLATFORMS, typeLabel } from '../api.js';
import { EmptyState, Panel, PlatformIcon, TypeBadge } from '../components.jsx';

const CHROME_BYTES = 10 * 1024 * 1024; // the web version posts through Chrome, which takes 10 MB at most
// "10 MB", "4 GB".
const sizeLabel = (b) => (b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${Math.round(b / 1024 ** 2)} MB`);


const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
const AVATAR_COLORS = ['#7C3AED', '#2563EB', '#0F766E', '#C2410C', '#BE185D', '#4D7C0F'];

// One account to tick in "Post from": its profile picture (or initials), name, and a check when ticked.
function AccountChoice({ a, on, onToggle, src = a.avatar_v ? `/api/accounts/${a.id}/avatar?v=${a.avatar_v}` : null, title }) {
  return (
    <Box component="button" type="button" onClick={onToggle} title={title} sx={{
      display: 'flex', alignItems: 'center', gap: 1, p: 0.75, pr: 1.25, borderRadius: 999, cursor: 'pointer', font: 'inherit',
      border: 1.5, borderColor: on ? 'primary.main' : 'divider', bgcolor: on ? '#FFF3EE' : 'background.paper', color: 'text.primary',
      transition: 'all .15s', '&:hover': { borderColor: on ? 'primary.main' : 'text.secondary' } }}>
      {src
        ? <Box component="img" src={src} alt="" sx={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
        : <Box sx={{ width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 750, color: '#fff',
            bgcolor: AVATAR_COLORS[a.id % AVATAR_COLORS.length] }}>{initials(a.name)}</Box>}
      <Typography fontSize={13.5} fontWeight={650} noWrap sx={{ maxWidth: 170 }}>{a.name}</Typography>
      <Box sx={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none',
        bgcolor: on ? 'primary.main' : 'transparent', border: on ? 0 : 1.5, borderColor: 'divider', color: '#fff' }}>
        {on && <Check size={12} strokeWidth={3} />}
      </Box>
    </Box>
  );
}

const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Photos or a video for the post: drop files on the box, or click it to browse. Thumbnails show inside it.
function MediaDrop({ files, previews, totalBytes, onAdd, onRemove, maxBytes }) {
  const [over, setOver] = useState(false);
  const input = React.useRef(null);
  // A file dropped beside the box would make the app window open that file instead: ignore those drops.
  useEffect(() => {
    const stop = (e) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
  const take = (list) => {
    const media = [...list].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (media.length) onAdd(media);
  };
  const full = files.length >= 10;
  const tooBig = totalBytes > maxBytes;
  return (
    <Box mt={2}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      sx={{ border: '1.5px dashed', borderColor: over ? 'primary.main' : tooBig ? 'error.main' : 'divider', borderRadius: '3px',
        bgcolor: over ? '#FFF3EE' : '#FBFAF7', transition: 'all .15s' }}>
      <input ref={input} hidden type="file" accept="image/*,video/*" multiple
        onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
      {!files.length ? (
        <Box role="button" tabIndex={0} onClick={() => input.current.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current.click(); } }}
          sx={{ py: 3.5, px: 2, textAlign: 'center', cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' } }}>
          <Box sx={{ width: 44, height: 44, mx: 'auto', mb: 1.25, borderRadius: '50%', display: 'grid', placeItems: 'center',
            bgcolor: over ? 'primary.main' : '#F1EEE8', color: over ? '#fff' : 'text.secondary', transition: 'all .15s' }}>
            <ImagePlus size={20} />
          </Box>
          <Typography fontWeight={650} fontSize={14.5}>
            {over ? 'Drop to add' : <>Drag photos or a video here, or <Box component="span" sx={{ color: 'primary.main' }}>browse</Box></>}
          </Typography>
          <Typography variant="caption" color="text.secondary">Up to 10 photos or 1 video · {sizeLabel(maxBytes)} in total{maxBytes > CHROME_BYTES ? ' (big videos for TikTok and Reels welcome)' : ''}</Typography>
        </Box>
      ) : (
        <Box sx={{ p: 1.5 }}>
          <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }}>
            {previews.map(({ f, url }, i) => (
              <Box key={url} sx={{ position: 'relative', aspectRatio: '1', borderRadius: '3px', overflow: 'hidden', bgcolor: '#EEE' }}>
                {f.type.startsWith('video/')
                  ? <><video src={url} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <Box sx={{ position: 'absolute', left: 6, bottom: 6, color: '#fff' }}><Film size={16} /></Box></>
                  : <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
                <IconButton size="small" aria-label="Remove" onClick={() => onRemove(i)}
                  sx={{ position: 'absolute', top: 4, right: 4, p: 0.4, bgcolor: 'rgba(0,0,0,.55)', color: '#fff', '&:hover': { bgcolor: 'rgba(0,0,0,.75)' } }}>
                  <X size={14} />
                </IconButton>
              </Box>
            ))}
            {!full && (
              <Box role="button" tabIndex={0} onClick={() => input.current.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current.click(); } }}
                sx={{ aspectRatio: '1', borderRadius: '3px', border: '1.5px dashed', borderColor: 'divider', display: 'grid', placeItems: 'center',
                  alignContent: 'center', gap: 0.5, cursor: 'pointer', color: 'text.secondary', '&:hover': { borderColor: 'primary.main', color: 'primary.main' } }}>
                <ImagePlus size={20} />
                <Typography fontSize={12} fontWeight={650}>Add more</Typography>
              </Box>
            )}
          </Box>
          <Typography variant="caption" display="block" mt={1} color={tooBig ? 'error' : 'text.secondary'}>
            {files.length} {files.length === 1 ? 'file' : 'files'} · {mb(totalBytes)} of {sizeLabel(maxBytes)}{over ? ' · drop to add' : ' · drag more here'}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

// ---- Write with AI: the choices Claude writes to. Lists are suggestions where the field allows typing.
const AI = {
  goal: ['Engage', 'Sell', 'Inform', 'Announce', 'Educate', 'Entertain', 'Drive traffic to a link', 'Build trust'],
  audience: ['General audience', 'Small business owners', 'Online shoppers', 'Home buyers and renters', 'Parents', 'Students',
    'Young professionals', 'Freelancers', 'Local community', 'Content creators'],
  format: ['Storytelling', 'Tips list', 'How-to', 'Question', 'Announcement', 'Offer or promo', 'Before and after', 'Behind the scenes', 'Myth vs fact'],
  style: ['Conversational', 'Friendly', 'Professional', 'Persuasive', 'Fun', 'Inspirational', 'Bold', 'Minimal'],
  hook: ['Curiosity', 'Question', 'Bold statement', 'Problem or pain point', 'Story opener', 'Benefit first', 'No hook'],
  framework: [['', ['Automatic']],
    ['Persuasive & marketing', ['AIDA: Attention, Interest, Desire, Action', 'PAS: Problem, Agitate, Solution', 'BAB: Before, After, Bridge',
      'FAB: Features, Advantages, Benefits', '4Ps: Promise, Picture, Proof, Push', 'ACCA: Awareness, Comprehension, Conviction, Action']],
    ['Storytelling', ["Hero's Journey", 'STAR: Situation, Task, Action, Result', 'Pixar Story Spine', 'Hook-Story-Offer',
      'Problem-Struggle-Resolution', 'ABT: And, But, Therefore']],
    ['Educational & explanatory', ['PREP: Point, Reason, Example, Point', 'PEEL: Point, Evidence, Explanation, Link', 'What-Why-How',
      'Feynman Technique', 'SCQA: Situation, Complication, Question, Answer', '5W1H: Who, What, When, Where, Why, How']],
    ['Journalism & news', ['Inverted Pyramid', 'Hourglass Structure', 'Chronological Structure', 'Nut Graf Structure',
      'Problem-Cause-Impact', 'Question-and-Answer (Q&A)']],
    ['Opinion & thought leadership', ['Claim-Evidence-Reasoning (CER)', 'Toulmin Argument Model', 'Thesis-Antithesis-Synthesis',
      'Point-Counterpoint', 'Observation-Insight-Action', 'Problem-Insight-Recommendation']],
    ['Social media engagement', ['Hook-Value-CTA', 'Question-Context-Discussion', 'Myth-Reality-Lesson', 'Mistake-Consequence-Fix',
      'Personal Experience-Lesson', 'Contrarian Take']]],
  cta: ['None', 'Comment below', 'Send me a message', 'Visit the link', 'Buy now', 'Book or call', 'Share with a friend', 'Follow for more'],
};
// Claude writes in any language: these are suggestions, and any other can be typed.
const AI_LANGS = ['English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Russian', 'Ukrainian',
  'Arabic', 'Hebrew', 'Persian', 'Hindi', 'Hinglish', 'Bengali', 'Urdu', 'Tamil', 'Indonesian', 'Malay', 'Filipino', 'Taglish', 'Thai',
  'Vietnamese', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese', 'Korean', 'Swahili', 'Greek', 'Swedish', 'Norwegian',
  'Danish', 'Finnish', 'Czech', 'Romanian', 'Hungarian', 'Spanglish'];
// The computer's own language to start with, e.g. "es-MX" -> Spanish.
const deviceLanguage = () => {
  try { const n = new Intl.DisplayNames(['en'], { type: 'language' }).of((navigator.language || 'en').split('-')[0]); return AI_LANGS.includes(n) ? n : 'English'; } catch { return 'English'; }
};
const AI_LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long'], ['custom', 'Custom']];
// "12 words · 74 characters" (emojis count as one character each).
const countText = (t) => { const s = t.trim(); return `${s ? s.split(/\s+/).length : 0} words · ${[...s].length} characters`; };
const AI_KEY = 'autoposter.ai-style';
const loadStyle = () => { try { return JSON.parse(localStorage.getItem(AI_KEY)) || {}; } catch { return {}; } };
const AI_DEFAULTS = { goal: 'Engage', audience: 'General audience', format: 'Storytelling', style: 'Conversational', hook: 'Curiosity',
  length: 'medium', limit_n: 100, limit_unit: 'words', emojis: true, hashtags: false, no_slop: true, framework: 'Automatic', cta: 'None' };

const Label = ({ children }) => <Typography variant="body2" fontWeight={650} color="text.secondary" mb={0.75}>{children}</Typography>;
// A box to type anything in, with suggestions to pick from (grouped lists show their headings).
// Until the person types, every suggestion shows, not just the ones matching the current value.
const filterSuggestions = createFilterOptions();
function Field({ label, value, options, onChange, placeholder }) {
  const grouped = Array.isArray(options[0]);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Label>{label}</Label>
      <Autocomplete freeSolo autoSelect disableClearable forcePopupIcon openOnFocus size="small" value={value}
        options={grouped ? options.flatMap(([, items]) => items) : options}
        groupBy={grouped ? (o) => options.find(([, items]) => items.includes(o))?.[0] || '' : undefined}
        filterOptions={(opts, state) => (state.inputValue === value ? opts : filterSuggestions(opts, state))}
        onChange={(_, v) => v && onChange(v)}
        slotProps={{ listbox: { sx: { maxHeight: 380 } } }}
        renderInput={(params) => <TextField {...params} placeholder={placeholder || 'Pick or type your own'} />} />
    </Box>
  );
}

/**
 * Write with AI: say what the post is about (or improve the draft), pick the goal, audience, format, style and hook,
 * and Claude writes three options on the person's own Claude subscription. "Use this" puts one in the post
 * (and its link in the first comment).
 */
function AiWriter({ open, onClose, draft, platforms, onUse }) {
  const [brief, setBrief] = useState('');
  const [extra, setExtra] = useState('');
  const [mode, setMode] = useState('new');
  const [advanced, setAdvanced] = useState(false);
  const [style, setStyle] = useState(() => {
    const saved = loadStyle();
    return { ...AI_DEFAULTS, language: deviceLanguage(), ...saved, language: /^[a-z]+$/.test(saved.language || '') ? deviceLanguage() : saved.language || deviceLanguage() };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [options, setOptions] = useState([]);
  useEffect(() => { if (open) { setMode(draft.trim() ? 'improve' : 'new'); setError(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => { const next = { ...style, ...patch }; setStyle(next); try { localStorage.setItem(AI_KEY, JSON.stringify(next)); } catch { /* private window */ } };
  const improving = mode === 'improve' && draft.trim();
  async function write() {
    setBusy(true);
    setError('');
    setOptions([]);
    try {
      const r = await api.aiCompose({ ...style, brief, extra, draft: improving ? draft : '', platforms });
      setOptions(r.options);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const seg = { flex: 1, textTransform: 'none', fontWeight: 650, border: 0, borderRadius: '3px !important', color: 'text.secondary',
    '&.Mui-selected': { bgcolor: '#15171C', color: '#fff', '&:hover': { bgcolor: '#15171C' } } };
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Sparkles size={20} color="#FF5A1F" /> Write with AI
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ pt: 0.5 }}>
          {draft.trim() && (
            <ToggleButtonGroup exclusive fullWidth size="small" value={mode} onChange={(_, v) => v && setMode(v)} sx={{ bgcolor: '#F4F2EE', p: 0.5, borderRadius: '3px' }}>
              <ToggleButton value="improve" sx={seg}>Improve my draft</ToggleButton>
              <ToggleButton value="new" sx={seg}>Write something new</ToggleButton>
            </ToggleButtonGroup>
          )}
          <Box>
            <Label>{improving ? 'Anything to change? (optional)' : 'What is your post about?'}</Label>
            <TextField multiline minRows={3} fullWidth autoFocus value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder={improving ? 'e.g. make it shorter and end with a question' : 'Describe the topic, your main point, and any facts or details to include (prices, dates, links)…'}
              helperText={brief.trim() ? countText(brief) : ' '} />
          </Box>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <Field label="Writing goal" value={style.goal} options={AI.goal} onChange={(v) => set({ goal: v })} />
            <Field label="Target audience" value={style.audience} options={AI.audience} onChange={(v) => set({ audience: v })} />
            <Field label="Content format" value={style.format} options={AI.format} onChange={(v) => set({ format: v })} />
            <Field label="Writing style" value={style.style} options={AI.style} onChange={(v) => set({ style: v })} />
            <Field label="Hook style" value={style.hook} options={AI.hook} onChange={(v) => set({ hook: v })} />
            <Field label="Language" value={style.language} options={AI_LANGS} onChange={(v) => set({ language: v })} />
          </Box>
          <Box>
            <Label>Length</Label>
            <ToggleButtonGroup exclusive fullWidth size="small" value={style.length} onChange={(_, v) => v && set({ length: v })}
              sx={{ bgcolor: '#F4F2EE', p: 0.5, borderRadius: '3px' }}>
              {AI_LENGTHS.map(([k, l]) => <ToggleButton key={k} value={k} sx={seg}>{l}</ToggleButton>)}
            </ToggleButtonGroup>
            {style.length === 'custom' && (
              <Stack direction="row" spacing={1} mt={1.25}>
                <TextField size="small" type="number" value={style.limit_n} sx={{ width: 110 }}
                  slotProps={{ htmlInput: { min: 1, max: style.limit_unit === 'characters' ? 5000 : 1000 } }}
                  onChange={(e) => set({ limit_n: e.target.value })} />
                <TextField select size="small" value={style.limit_unit} onChange={(e) => set({ limit_unit: e.target.value })} sx={{ width: 150 }}>
                  <MenuItem value="words">words</MenuItem>
                  <MenuItem value="characters">characters</MenuItem>
                </TextField>
              </Stack>
            )}
          </Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <FormControlLabel control={<Checkbox size="small" checked={style.emojis} onChange={(e) => set({ emojis: e.target.checked })} />} label="Emojis" />
            <FormControlLabel control={<Checkbox size="small" checked={style.hashtags} onChange={(e) => set({ hashtags: e.target.checked })} />} label="Hashtags" />
            <Tooltip title="Bans the words, phrases and habits that make posts read as AI-written (delve, game-changing, &quot;In today's fast-paced world&quot;, &quot;Let that sink in&quot;, em dashes, &quot;What do you think?&quot;...). Anything that slips through is reworded automatically.">
              <FormControlLabel control={<Checkbox size="small" checked={style.no_slop} onChange={(e) => set({ no_slop: e.target.checked })} />} label="No AI slop" />
            </Tooltip>
            <Box flex={1} />
            <Button size="small" variant="outlined" color="secondary" onClick={() => setAdvanced(!advanced)}
              endIcon={<ChevronDown size={15} style={{ transition: 'transform .2s', transform: advanced ? 'rotate(180deg)' : 'none' }} />}
              sx={{ borderRadius: '3px' }}>
              {advanced ? 'Hide advanced' : 'Show advanced'}
            </Button>
          </Stack>
          {advanced && (
            <Stack spacing={2} sx={{ pt: 2, borderTop: 1, borderColor: 'divider' }}>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                <Field label="Writing framework" value={style.framework} options={AI.framework} onChange={(v) => set({ framework: v })} placeholder="Type any framework, or pick one" />
                <Field label="Call to action" value={style.cta} options={AI.cta} onChange={(v) => set({ cta: v })} />
              </Box>
              <Box>
                <Label>Additional instructions</Label>
                <TextField multiline minRows={2} fullWidth value={extra} onChange={(e) => setExtra(e.target.value)}
                  placeholder="Facts to keep, keywords, things to avoid, an example of your writing style…" />
              </Box>
            </Stack>
          )}
          {busy && (
            <Box>
              <Typography variant="body2" color="text.secondary" mb={0.75}>Claude is writing three options… (about 15 seconds)</Typography>
              <LinearProgress sx={{ borderRadius: '3px' }} />
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {options.map((o, i) => (
            <Box key={i} sx={{ p: 1.75, border: 1, borderColor: 'divider', borderRadius: '3px', bgcolor: '#FBFAF7' }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary" fontWeight={700}>Option {i + 1}</Typography>
                <Typography variant="caption" color="text.secondary">{countText(o.body)}</Typography>
              </Stack>
              <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: 14, mt: 0.5 }}>{o.body}</Typography>
              {o.first_comment && (
                <Typography fontSize={13} color="text.secondary" mt={1} sx={{ whiteSpace: 'pre-wrap' }}><b>First comment:</b> {o.first_comment}</Typography>
              )}
              <Button size="small" variant="contained" startIcon={<Check size={15} />} sx={{ mt: 1.25 }} onClick={() => { onUse(o); onClose(); }}>Use this</Button>
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button color="secondary" disabled={busy} onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={busy || (!brief.trim() && !improving)} onClick={write}
          startIcon={options.length ? <RotateCcw size={16} /> : <Sparkles size={16} />}>
          {busy ? 'Writing…' : options.length ? 'Write new options' : 'Write'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const COMMENT_KINDS = [['link', 'Share a link'], ['question', 'Ask a question'], ['details', 'Extra details'], ['thanks', 'Thank you']];

/** Writes the first comment from the post: a link with a nudge, a question, extra details or a thank-you. */
function CommentWriter({ open, onClose, post, onUse }) {
  const [kind, setKind] = useState('link');
  const [notes, setNotes] = useState('');
  const [emojis, setEmojis] = useState(true);
  const [noSlop, setNoSlop] = useState(() => loadStyle().no_slop ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [options, setOptions] = useState([]);
  useEffect(() => { if (open) setError(''); }, [open]);
  async function write() {
    setBusy(true);
    setError('');
    setOptions([]);
    try {
      const r = await api.aiComment({ post, notes, kind, emojis, no_slop: noSlop, language: loadStyle().language || deviceLanguage() });
      setOptions(r.options);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const seg = { flex: 1, textTransform: 'none', fontWeight: 650, border: 0, borderRadius: '3px !important', color: 'text.secondary',
    '&.Mui-selected': { bgcolor: '#15171C', color: '#fff', '&:hover': { bgcolor: '#15171C' } } };
  const needsNotes = kind === 'link' && !/https?:\/\//.test(post) && !/https?:\/\//.test(notes);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Sparkles size={20} color="#FF5A1F" /> Write the first comment
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ pt: 0.5 }}>
          {!post.trim() && <Alert severity="info">Write the post first: the comment is written to go with it.</Alert>}
          <Box>
            <Label>What should the comment do?</Label>
            <ToggleButtonGroup exclusive fullWidth size="small" value={kind} onChange={(_, v) => v && setKind(v)}
              sx={{ bgcolor: '#F4F2EE', p: 0.5, borderRadius: '3px', flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
              {COMMENT_KINDS.map(([k, l]) => <ToggleButton key={k} value={k} sx={seg}>{l}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>
          <Box>
            <Label>{kind === 'link' ? 'The link to share' : 'Anything to include (optional)'}</Label>
            <TextField fullWidth multiline minRows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder={kind === 'link' ? 'https://… (and a word on what it is, if you like)' : 'e.g. sizes, opening hours, delivery areas'} />
            {needsNotes && <Typography variant="caption" color="text.secondary">Paste the link here: Claude never makes one up.</Typography>}
          </Box>
          <Stack direction="row">
            <FormControlLabel control={<Checkbox size="small" checked={emojis} onChange={(e) => setEmojis(e.target.checked)} />} label="Emojis" />
            <FormControlLabel control={<Checkbox size="small" checked={noSlop} onChange={(e) => setNoSlop(e.target.checked)} />} label="No AI slop" />
          </Stack>
          {busy && <LinearProgress sx={{ borderRadius: '3px' }} />}
          {error && <Alert severity="error">{error}</Alert>}
          {options.map((o, i) => (
            <Stack key={i} direction="row" alignItems="center" spacing={1.5}
              sx={{ p: 1.5, border: 1, borderColor: 'divider', borderRadius: '3px', bgcolor: '#FBFAF7' }}>
              <Typography sx={{ flex: 1, whiteSpace: 'pre-wrap', fontSize: 14 }}>{o}</Typography>
              <Button size="small" variant="contained" startIcon={<Check size={15} />} sx={{ flex: 'none' }} onClick={() => { onUse(o); onClose(); }}>Use</Button>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button color="secondary" disabled={busy} onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={busy || !post.trim() || needsNotes} onClick={write}
          startIcon={options.length ? <RotateCcw size={16} /> : <Sparkles size={16} />}>
          {busy ? 'Writing…' : options.length ? 'Write new options' : 'Write'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// The same "Write with AI" button for the post and the first comment.
const AiButton = ({ onClick, children = 'Write with AI' }) => (
  <Button size="small" variant="outlined" startIcon={<Sparkles size={16} />} onClick={onClick}
    sx={{ borderColor: 'primary.main', color: 'primary.main', borderRadius: '3px', flex: 'none', whiteSpace: 'nowrap' }}>{children}</Button>
);

const IMAGE_KINDS = ['Promo or sale', 'Product spotlight', 'Quote', 'Tips list', 'Announcement', 'Event', 'Question', 'Before and after',
  'Listing (home, car, item)', 'Behind the scenes', 'Thank you'];
const IMAGE_STYLES = ['Bold', 'Minimal', 'Elegant', 'Playful', 'Modern', 'Corporate', 'Retro', 'Dark', 'Pastel', 'Luxury'];
const IMAGE_SIZES = [['square', 'Square 1:1', '1080 × 1080 · feed'], ['portrait', 'Portrait 4:5', '1080 × 1350 · feed, best on phones'],
  ['story', 'Story 9:16', '1080 × 1920 · stories, reels'], ['landscape', 'Landscape 1.91:1', '1200 × 630 · link previews, LinkedIn']];
const IMAGE_KEY = 'autoposter.ai-image';

// A photo shrunk to at most 1600px on its longest side, as a JPEG data URL (small enough to send to the designer).
function photoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be read")); };
    img.src = url;
  });
}

/**
 * Create image with AI: Claude designs three post graphics (headline, colors, shapes; or text over the person's own
 * photo), and the desktop app turns them into PNGs. "Add to post" attaches one.
 */
function ImageMaker({ open, onClose, post, photos, onAdd }) {
  const [brief, setBrief] = useState('');
  const [style, setStyle] = useState(() => {
    try { return { kind: 'Promo or sale', look: 'Bold', colors: '', size: 'square', ...JSON.parse(localStorage.getItem(IMAGE_KEY)) }; } catch { return { kind: 'Promo or sale', look: 'Bold', colors: '', size: 'square' }; }
  });
  const [mine, setMine] = useState([]); // the person's own photos for the design (up to 4)
  const [over, setOver] = useState(false);
  const pick = React.useRef(null);
  const minePreviews = useMemo(() => mine.map((f) => ({ f, url: URL.createObjectURL(f) })), [mine]);
  useEffect(() => () => minePreviews.forEach((x) => URL.revokeObjectURL(x.url)), [minePreviews]);
  const addMine = (list) => setMine((cur) => [...cur, ...[...list].filter((f) => f.type.startsWith('image/'))].slice(0, 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [images, setImages] = useState([]);
  const [added, setAdded] = useState(new Set());
  // Opens with the post's own photos ready to use; they can be removed, and others uploaded or dropped.
  useEffect(() => { if (open) { setError(''); setMine(photos.slice(0, 4)); setAdded(new Set()); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => { const next = { ...style, ...patch }; setStyle(next); try { localStorage.setItem(IMAGE_KEY, JSON.stringify(next)); } catch { /* private window */ } };
  async function create() {
    setBusy(true);
    setError('');
    setImages([]);
    try {
      const own = await Promise.all(mine.map(photoDataUrl));
      const r = await api.aiImage({ brief, post, kind: style.kind, style: style.look, colors: style.colors, size: style.size, photos: own,
        language: loadStyle().language || deviceLanguage() });
      setImages(r.images);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function add(src, i) {
    const blob = await (await fetch(src)).blob();
    onAdd(new File([blob], `ai-image-${Date.now()}-${i + 1}.png`, { type: 'image/png' }));
    setAdded(new Set([...added, i]));
  }
  const seg = { flex: 1, textTransform: 'none', fontWeight: 650, border: 0, borderRadius: '3px !important', color: 'text.secondary', lineHeight: 1.2,
    '&.Mui-selected': { bgcolor: '#15171C', color: '#fff', '&:hover': { bgcolor: '#15171C' } } };
  const ratio = { square: '1', portrait: '4 / 5', story: '9 / 16', landscape: '1200 / 630' }[style.size];
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Sparkles size={20} color="#FF5A1F" /> Create image with AI
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.25} sx={{ pt: 0.5 }}>
          <Box>
            <Label>What should the image say or show?</Label>
            <TextField multiline minRows={2} fullWidth autoFocus value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder={post.trim() ? 'Optional: Claude reads your post. Add a headline or details to feature, e.g. "20% off this weekend"' : 'e.g. Handmade soy candles, 20% off this weekend, free shipping over $40'} />
          </Box>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' } }}>
            <Field label="Kind of image" value={style.kind} options={IMAGE_KINDS} onChange={(v) => set({ kind: v })} />
            <Field label="Style" value={style.look} options={IMAGE_STYLES} onChange={(v) => set({ look: v })} />
            <Box>
              <Label>Colors</Label>
              <TextField fullWidth size="small" value={style.colors} onChange={(e) => set({ colors: e.target.value })} placeholder="e.g. orange and black, or #FF5A1F" />
            </Box>
          </Box>
          <Box>
            <Label>Size</Label>
            <ToggleButtonGroup exclusive fullWidth size="small" value={style.size} onChange={(_, v) => v && set({ size: v })} sx={{ bgcolor: '#F4F2EE', p: 0.5, borderRadius: '3px' }}>
              {IMAGE_SIZES.map(([k, l, d]) => (
                <ToggleButton key={k} value={k} sx={seg}><Box>{l}<Box component="span" sx={{ display: 'block', fontSize: 11, opacity: 0.7, fontWeight: 500 }}>{d}</Box></Box></ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
          <Box>
            <Label>Your photos (optional, up to 4)</Label>
            <Box onDragEnter={(e) => { e.preventDefault(); setOver(true); }} onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
              onDrop={(e) => { e.preventDefault(); setOver(false); addMine(e.dataTransfer.files); }}
              sx={{ p: 1.25, border: '1.5px dashed', borderColor: over ? 'primary.main' : 'divider', borderRadius: '3px', bgcolor: over ? '#FFF3EE' : '#FBFAF7',
                display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
              <input ref={pick} hidden type="file" accept="image/*" multiple onChange={(e) => { addMine(e.target.files); e.target.value = ''; }} />
              {minePreviews.map(({ f, url }, i) => (
                <Box key={url} sx={{ position: 'relative', width: 72, height: 72, borderRadius: '3px', overflow: 'hidden', flex: 'none' }}>
                  <img src={url} alt={f.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <IconButton size="small" aria-label="Remove" onClick={() => setMine(mine.filter((_, j) => j !== i))}
                    sx={{ position: 'absolute', top: 3, right: 3, p: 0.3, bgcolor: 'rgba(0,0,0,.55)', color: '#fff', '&:hover': { bgcolor: 'rgba(0,0,0,.75)' } }}>
                    <X size={12} />
                  </IconButton>
                </Box>
              ))}
              {mine.length < 4 && (
                <Box role="button" tabIndex={0} onClick={() => pick.current.click()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick.current.click(); } }}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, height: 72, cursor: 'pointer', color: 'text.secondary',
                    '&:hover': { color: 'primary.main' } }}>
                  <ImagePlus size={20} />
                  <Typography fontSize={13.5} fontWeight={600}>
                    {mine.length ? 'Add another' : <>Drop photos here or <Box component="span" sx={{ color: 'primary.main' }}>browse</Box>, to design with your own pictures</>}
                  </Typography>
                </Box>
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {mine.length > 1 ? 'Claude combines them in each design (collage, grid or side by side).' : mine.length ? 'Claude designs around your photo.' : 'No photos: Claude designs with type, colors and shapes.'}
            </Typography>
          </Box>
          {busy && (
            <Box>
              <Typography variant="body2" color="text.secondary" mb={0.75}>Claude is designing three images… (about 30 seconds)</Typography>
              <LinearProgress sx={{ borderRadius: '3px' }} />
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {images.length > 0 && (
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: `repeat(${style.size === 'landscape' ? 2 : 3}, 1fr)` } }}>
              {images.map((src, i) => (
                <Box key={i}>
                  <Box component="img" src={src} alt={`Design ${i + 1}`} sx={{ width: '100%', aspectRatio: ratio, objectFit: 'cover', display: 'block',
                    borderRadius: '3px', border: 1, borderColor: 'divider' }} />
                  <Button fullWidth size="small" variant={added.has(i) ? 'outlined' : 'contained'} disabled={added.has(i)} sx={{ mt: 1 }}
                    startIcon={<Check size={15} />} onClick={() => add(src, i)}>{added.has(i) ? 'Added to post' : 'Add to post'}</Button>
                </Box>
              ))}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button color="secondary" disabled={busy} onClick={onClose}>{added.size ? 'Done' : 'Close'}</Button>
        <Button variant="contained" disabled={busy || (!brief.trim() && !post.trim())} onClick={create}
          startIcon={images.length ? <RotateCcw size={16} /> : <Sparkles size={16} />}>
          {busy ? 'Designing…' : images.length ? 'Design new options' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function localInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export default function Compose({ onScheduled, goDestinations, initialWhen, ready, goSetup }) {
  const [destinations, setDestinations] = useState(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [when, setWhen] = useState(() => localInputValue(initialWhen || new Date(Date.now() + 15 * 60_000)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [firstComment, setFirstComment] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [aiOpen, setAiOpen] = useState(false);
  const [placeQuery, setPlaceQuery] = useState('');
  const [maxBytes, setMaxBytes] = useState(CHROME_BYTES);
  useEffect(() => { api.status().then((st) => st.max_upload_bytes && setMaxBytes(st.max_upload_bytes)).catch(() => {}); }, []);
  const [commentAiOpen, setCommentAiOpen] = useState(false);
  const [imageAiOpen, setImageAiOpen] = useState(false);
  const [accountPick, setAccountPick] = useState({}); // platform -> account ids; unset: that platform's default account

  useEffect(() => { api.destinations().then(setDestinations).catch((e) => setError(e.message)); }, []);
  useEffect(() => { api.accounts().then(setAccounts).catch(() => {}); }, []);

  const enabled = (destinations || []).filter((d) => d.enabled && PLATFORMS[d.platform]?.posting);
  const previews = useMemo(() => files.map((f) => ({ f, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const hasVideo = files.some((f) => f.type.startsWith('video/'));
  const mediaProblem =
    totalBytes > maxBytes ? `Attachments must total ${sizeLabel(maxBytes)} or less${maxBytes === CHROME_BYTES ? ' (Chrome upload limit; the desktop app takes up to 4 GB)' : ''}.`
    : hasVideo && files.length > 1 ? 'Attach either one video or images, not both.'
    : '';
  const groupCount = enabled.filter((d) => selected.has(d.id) && d.type === 'group').length;
  // Who posts in a Facebook group: the group's own setting (Destinations page).
  const groupAuthor = (d) => d.post_as || null;
  const kinds = files.map((f) => (f.type.startsWith('video/') ? 'video' : 'image'));
  // Per-platform rules: Instagram needs media, TikTok needs a video, X takes 4 photos.
  const platformProblems = [...new Set(enabled.filter((d) => selected.has(d.id)).map((d) => d.platform))]
    .map((pf) => platformMediaProblem(pf, kinds)).filter(Boolean);
  const hints = [...new Set(enabled.filter((d) => selected.has(d.id)).map((d) => PLATFORMS[d.platform].hint).filter(Boolean))];

  // Which of your accounts post (Accounts page): one, some or all per platform. Each ticked account posts on its own
  // to every chosen place on that platform. Nothing picked yet: the platform's default account.
  // A Facebook "account" that is really one of another account's Pages (page_of) isn't a login: it's picked as a Page.
  const accountsOf = (pf) => accounts.filter((a) => a.platform === pf && !a.page_of);
  // A pick is an account id, or "p<page id>" for one of a Facebook account's Pages (it posts in groups as the Page).
  // Nothing is ticked to start: each post says who posts it.
  const picksOf = (pf) => (accountsOf(pf).length ? accountPick[pf] ?? [] : []);
  const pageById = (key) => accounts.flatMap((a) => (a.pages || []).map((pg) => ({ ...pg, account: a }))).find((pg) => `p${pg.id}` === key);
  // An account's own profile (its feed): only that account posts there, and only when it is ticked in "Who".
  // "Who" is who posts; "Where" is where it goes. A feed whose account isn't ticked posts nothing.
  const ownerOf = (d) => (d.type === 'profile' ? accounts.find((a) => a.platform === d.platform && a.profile_url === d.url) : null);
  const ownerTicked = (d) => { const o = ownerOf(d); return Boolean(o) && picksOf(d.platform).includes(o.id); };
  // Groups get every pick (accounts and Pages); other places get the picked accounts, a Page counting as its account.
  const picksFor = (d) => {
    const o = ownerOf(d);
    if (o) return ownerTicked(d) ? [o.id] : [];
    const picks = picksOf(d.platform);
    if (d.type === 'group') return picks;
    return [...new Set(picks.map((k) => (typeof k === 'string' ? pageById(k)?.account.id : k)).filter(Boolean))];
  };
  const [openPages, setOpenPages] = useState({}); // account id -> its Pages are shown in "Who"
  const togglePick = (pf, id) => {
    const cur = new Set(picksOf(pf));
    cur.has(id) ? cur.delete(id) : cur.add(id);
    setAccountPick({ ...accountPick, [pf]: [...cur] });
  };
  const pickAll = (pf, on) => setAccountPick({ ...accountPick, [pf]: on ? [...new Set([...picksOf(pf), ...accountsOf(pf).map((a) => a.id)])] : [] });
  const chosen = enabled.filter((d) => selected.has(d.id) && (!ownerOf(d) || ownerTicked(d)));
  // Platforms to pick accounts for: those of the places ticked in "Where", or every platform with accounts before that.
  const chosenPlatforms = [...new Set(chosen.filter((d) => !ownerOf(d)).map((d) => d.platform))];
  const pickPlatforms = (chosenPlatforms.length ? chosenPlatforms : [...new Set(accounts.map((a) => a.platform))])
    .filter((pf) => accountsOf(pf).length);
  const missingAccount = chosen.find((d) => !ownerOf(d) && accountsOf(d.platform).length && !picksFor(d).length);
  const postCount = chosen.reduce((n, d) => n + (ownerOf(d) ? picksFor(d).length : Math.max(picksFor(d).length, 1)), 0);

  // The places in "Where" matching the search (name, link, platform or kind), your own feeds first.
  const words = placeQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const shownPlaces = [...enabled].sort((x, y) => Boolean(ownerOf(y)) - Boolean(ownerOf(x)))
    .filter((d) => words.every((w) => `${d.name} ${d.url} ${PLATFORMS[d.platform]?.label || ''} ${typeLabel(d.platform, d.type)}`.toLowerCase().includes(w)));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('body', body);
      form.append('scheduled_at', new Date(when).toISOString());
      if (firstComment.trim()) form.append('first_comment', firstComment.trim());
      for (const d of chosen) form.append('destination_ids', String(d.id));
      form.append('destination_accounts', JSON.stringify(Object.fromEntries(chosen.filter((d) => !ownerOf(d)).map((d) => [d.id, picksFor(d)]))));
      for (const f of files) form.append('media', f);
      await api.createPost(form);
      setBody(''); setFiles([]); setSelected(new Set()); setFirstComment(''); setAccountPick({});
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

  const canSubmit = !busy && !mediaProblem && !platformProblems.length && selected.size && !missingAccount && (body.trim() || files.length);

  return (
    <Box component="form" onSubmit={submit}
      sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: '1.5fr 1fr' }, alignItems: 'start' }}>
      {ready === false && (
        <Alert severity="warning" sx={{ gridColumn: '1 / -1' }}
          action={<Button color="inherit" size="small" onClick={goSetup}>Open Setup</Button>}>
          Setup isn't finished. You can schedule posts now, but they wait in the queue until every Setup check passes.
        </Alert>
      )}
      <Panel title="Post" action={
        <AiButton onClick={() => setAiOpen(true)} />}>
        <AiWriter open={aiOpen} onClose={() => setAiOpen(false)} draft={body}
          platforms={[...new Set(chosen.map((d) => d.platform))]}
          onUse={(o) => { setBody(o.body); if (o.first_comment) setFirstComment(o.first_comment); }} />
        <TextField multiline minRows={9} fullWidth placeholder="What do you want to post?"
          value={body} onChange={(e) => setBody(e.target.value)}
          helperText={body.trim() ? countText(body) : null} slotProps={{ formHelperText: { sx: { textAlign: 'right', mr: 0 } } }} />
        <Stack direction="row" alignItems="center" justifyContent="space-between" mt={2} mb={-1}>
          <Typography variant="body2" fontWeight={650} color="text.secondary" noWrap>Photos or video</Typography>
          <AiButton onClick={() => setImageAiOpen(true)}>Create image with AI</AiButton>
        </Stack>
        <ImageMaker open={imageAiOpen} onClose={() => setImageAiOpen(false)} post={body}
          photos={files.filter((f) => f.type.startsWith('image/') && !f.name.startsWith('ai-image-'))} onAdd={(f) => setFiles((cur) => [...cur, f].slice(0, 10))} />
        <MediaDrop files={files} previews={previews} totalBytes={totalBytes} maxBytes={maxBytes} onAdd={(list) => setFiles([...files, ...list].slice(0, 10))}
          onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
        {mediaProblem && <Alert severity="error" sx={{ mt: 2 }}>{mediaProblem}</Alert>}
        <Stack direction="row" alignItems="center" justifyContent="space-between" mt={2.5} mb={1}>
          <Typography variant="body2" fontWeight={650} color="text.secondary" noWrap>First comment (optional)</Typography>
          <AiButton onClick={() => setCommentAiOpen(true)} />
        </Stack>
        <TextField multiline minRows={2} fullWidth placeholder="e.g. Get it here: https://…"
          value={firstComment} onChange={(e) => setFirstComment(e.target.value)} />
        <CommentWriter open={commentAiOpen} onClose={() => setCommentAiOpen(false)} post={body} onUse={setFirstComment} />
      </Panel>

      <Stack spacing={2.5}>
        {pickPlatforms.length > 0 && <Panel title="Who">
          {pickPlatforms.map((pf) => {
            const list = accountsOf(pf);
            const picks = picksOf(pf);
            const picked = list.filter((a) => picks.includes(a.id)).length;
            return (
              <Box key={pf} sx={{ '&:not(:last-of-type)': { mb: 2.25 } }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <PlatformIcon platform={pf} size={16} />
                    <Typography variant="body2" fontWeight={700}>Post from · {PLATFORMS[pf]?.label || pf}</Typography>
                  </Stack>
                  {list.length > 1 && (
                    <Button size="small" sx={{ minWidth: 0, px: 1, py: 0, fontSize: 12.5 }} onClick={() => pickAll(pf, picked < list.length)}>
                      {picked < list.length ? 'Select all' : 'Clear'}
                    </Button>
                  )}
                </Stack>
                <Stack direction="row" flexWrap="wrap" useFlexGap gap={1}>
                  {list.map((a) => <AccountChoice key={a.id} a={a} on={picks.includes(a.id)} onToggle={() => togglePick(pf, a.id)} />)}
                </Stack>
                {/* Each Facebook account's Pages: no login of their own, the account switches into the Page to post in groups. */}
                {list.filter((a) => a.pages?.length).map((a) => {
                  const shown = openPages[a.id] ? a.pages : a.pages.filter((pg) => picks.includes(`p${pg.id}`));
                  return (
                    <Box key={`pages-${a.id}`} mt={1.5}>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Typography variant="caption" color="text.secondary" fontWeight={650}>As a Page · {a.name}</Typography>
                        <Button size="small" onClick={() => setOpenPages({ ...openPages, [a.id]: !openPages[a.id] })}
                          sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: 12 }}>
                          {openPages[a.id] ? 'Hide' : `Show ${a.pages.length} Page${a.pages.length === 1 ? '' : 's'}`}
                        </Button>
                      </Stack>
                      {shown.length > 0 && (
                        <Stack direction="row" flexWrap="wrap" useFlexGap gap={1} mt={0.75}>
                          {shown.map((pg) => (
                            <AccountChoice key={pg.id} a={{ id: pg.id, name: pg.name }} on={picks.includes(`p${pg.id}`)}
                              src={pg.avatar_v ? `/api/pages/${pg.id}/avatar?v=${pg.avatar_v}` : null}
                              title={`${pg.name} (Page) · posts in groups as this Page, through ${a.name}`}
                              onToggle={() => togglePick(pf, `p${pg.id}`)} />
                          ))}
                        </Stack>
                      )}
                    </Box>
                  );
                })}
                {pf === 'facebook' && picks.some((k) => typeof k === 'string') && (
                  <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                    Pages post in groups as the Page; the group has to allow Pages. Anywhere else, the Page's account posts.
                  </Typography>
                )}
              </Box>
            );
          })}
        </Panel>}

        <Panel title="Where" action={<Typography variant="caption" color="text.secondary">{chosen.length} selected</Typography>}>
          {/* Search by name, link or platform; "Select all shown" ticks every match. */}
          <Stack direction="row" spacing={1} alignItems="center" mb={1.25}>
            <TextField size="small" fullWidth value={placeQuery} onChange={(e) => setPlaceQuery(e.target.value)}
              placeholder={`Search ${enabled.length} places`}
              slotProps={{ input: {
                startAdornment: <Box sx={{ mr: 1, display: 'flex', color: 'text.secondary' }}><Search size={16} /></Box>,
                endAdornment: placeQuery ? <IconButton size="small" aria-label="Clear search" onClick={() => setPlaceQuery('')}><X size={14} /></IconButton> : null,
              } }} />
            {shownPlaces.length > 0 && (
              <Button size="small" sx={{ flex: 'none', whiteSpace: 'nowrap' }}
                onClick={() => setSelected((cur) => {
                  const n = new Set(cur);
                  const usable = shownPlaces.filter((d) => !ownerOf(d) || ownerTicked(d));
                  const allOn = usable.every((d) => n.has(d.id));
                  usable.forEach((d) => (allOn ? n.delete(d.id) : n.add(d.id)));
                  return n;
                })}>
                {shownPlaces.every((d) => selected.has(d.id)) ? 'Clear shown' : placeQuery ? `Select ${shownPlaces.length} shown` : 'Select all'}
              </Button>
            )}
          </Stack>
          {placeQuery && <Typography variant="caption" color="text.secondary" display="block" mb={0.75}>{shownPlaces.length} of {enabled.length} places</Typography>}
          <Stack spacing={0.75} sx={{ maxHeight: 340, overflowY: 'auto', mx: -1, px: 1 }}>
            {!shownPlaces.length && <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>No places match "{placeQuery}".</Typography>}
            {shownPlaces.map((d) => {
              const owner = ownerOf(d);
              const off = Boolean(owner) && !ownerTicked(d); // its account isn't ticked in "Who"
              const on = selected.has(d.id) && !off;
              return (
                <Box key={d.id}>
                <Box component="label" sx={{ opacity: off ? 0.55 : 1,
                  display: 'flex', alignItems: 'center', gap: 1.25, p: 1, pr: 1.5, borderRadius: 2.5, cursor: off ? 'default' : 'pointer',
                  border: 1, borderColor: on ? 'primary.main' : 'transparent', bgcolor: on ? '#FFF3EE' : 'transparent',
                  transition: 'all .15s', '&:hover': { bgcolor: on ? '#FFF3EE' : 'background.default' } }}>
                  <Checkbox size="small" checked={on} disabled={off} onChange={() => toggle(d.id)} sx={{ p: 0.5 }} />
                  <TypeBadge type={d.type} withLabel={false} />
                  <Typography fontWeight={650} fontSize={14} noWrap sx={{ flex: 1 }}>{d.name}</Typography>
                  {d.platform === 'facebook' && d.type === 'group' && groupAuthor(d) && (
                    <Typography variant="caption" color="primary.main" fontWeight={650} noWrap sx={{ flex: 'none', maxWidth: 140 }}>as {groupAuthor(d)}</Typography>
                  )}
                  {owner ? (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 'none' }}>
                      {off ? `Tick ${owner.name} under Who to post here` : `${owner.name}'s ${PLATFORMS[d.platform].label} feed`}
                    </Typography>
                  ) : d.platform !== 'facebook' && (
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 'none' }}>
                      {PLATFORMS[d.platform].label}{d.type !== 'profile' ? ` · ${typeLabel(d.platform, d.type)}` : ''}
                    </Typography>
                  )}
                </Box>
                </Box>
              );
            })}
          </Stack>
          {missingAccount && <Alert severity="warning" sx={{ mt: 1.5 }}>Tick at least one {PLATFORMS[missingAccount.platform]?.label || ''} account under "Post from".</Alert>}
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
            Your computer must be on and awake with Autoposter running. Accounts not logged in inside Autoposter post through Chrome.
          </Typography>
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          <Button type="submit" variant="contained" size="large" fullWidth disabled={!canSubmit}
            startIcon={<Send size={18} />} sx={{ mt: 2.5, py: 1.25 }}>
            {busy ? 'Scheduling…' : selected.size ? `Schedule ${postCount} post${postCount === 1 ? '' : 's'}` : 'Pick a destination'}
          </Button>
        </Panel>
      </Stack>
    </Box>
  );
}
