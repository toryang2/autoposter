import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, IconButton, Paper, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api, TYPE_LABEL } from '../api.js';
import { STATUS_COLOR, TYPE_COLOR, tokens } from '../theme.js';
import { delayText, EmptyState, JobStatusChip, Panel } from '../components.jsx';
import { PostPreview } from '../preview.jsx';

// Clicking a post anywhere on the calendar opens its preview (how it looks on its platform).
const PreviewContext = React.createContext(() => {});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_IN_CELL = 3;
const HOUR_PX = 56;
const EVENT_MIN = 45; // posts are instant, so each one is drawn as a 45-minute block

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const sameDay = (a, b) => dayKey(a) === dayKey(b);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const isPastDay = (d) => d < startOfDay(new Date());
const timeOf = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
const longDay = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// The days a view covers. Month: six full weeks from the Sunday on or before the 1st.
function visibleDays(view, anchor) {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'week') {
    const start = addDays(startOfDay(anchor), -anchor.getDay());
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function shiftAnchor(view, anchor, n) {
  if (view === 'day') return addDays(anchor, n);
  if (view === 'week') return addDays(anchor, 7 * n);
  return new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);
}

function viewTitle(view, anchor, days) {
  if (view === 'month') return [anchor.toLocaleDateString(undefined, { month: 'long' }), String(anchor.getFullYear())];
  if (view === 'day') return [anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), String(anchor.getFullYear())];
  const a = days[0];
  const b = days[6];
  const fmt = (d, opts) => d.toLocaleDateString(undefined, opts);
  const range = a.getMonth() === b.getMonth()
    ? `${fmt(a, { month: 'long' })} ${a.getDate()}–${b.getDate()}`
    : `${fmt(a, { month: 'short', day: 'numeric' })} – ${fmt(b, { month: 'short', day: 'numeric' })}`;
  return [range, String(b.getFullYear())];
}

// Default time for a new post: the given time, or 9:00 AM on that day; never in the past.
function slotFor(day, hour) {
  const now = new Date();
  const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour ?? 9, 0);
  return t > now ? t : new Date(now.getTime() + 15 * 60_000);
}

// Side-by-side lanes for posts whose 45-minute blocks overlap.
function layoutDay(jobs) {
  const sorted = [...jobs].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const item of cluster) {
      let lane = lanes.findIndex((end) => end <= item.start);
      if (lane === -1) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = item.start + EVENT_MIN;
      item.lane = lane;
    }
    for (const item of cluster) out.push({ ...item, lanes: lanes.length });
    cluster = [];
  };
  for (const job of sorted) {
    const d = new Date(job.scheduled_at);
    const start = d.getHours() * 60 + d.getMinutes();
    if (cluster.length && start >= clusterEnd) flush();
    cluster.push({ job, start });
    clusterEnd = Math.max(clusterEnd, start + EVENT_MIN);
  }
  if (cluster.length) flush();
  return out;
}

function CellEntry({ job, onClick }) {
  const preview = React.useContext(PreviewContext);
  const c = STATUS_COLOR[job.delay ? 'delayed' : job.status];
  return (
    <Box component="button" onClick={(e) => { onClick(e); preview(job); }} title={`${TYPE_LABEL[job.destination_type]} · ${job.destination_name}`}
      sx={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.75,
        px: 0.75, py: 0.4, borderRadius: '3px', bgcolor: c.bg, borderLeft: `3px solid ${TYPE_COLOR[job.destination_type]}`,
        opacity: job.status === 'cancelled' ? 0.55 : 1, '&:hover': { filter: 'brightness(0.96)' } }}>
      <Typography sx={{ fontSize: 11, fontWeight: 700, color: c.fg, flex: 'none' }}>{timeOf(job.scheduled_at)}</Typography>
      <Typography noWrap sx={{ fontSize: 11.5, fontWeight: 600, color: tokens.ink, minWidth: 0 }}>{job.destination_name}</Typography>
    </Box>
  );
}

function DayCell({ day, month, jobs, selected, onSelect, onAdd }) {
  const today = sameDay(day, new Date());
  const inMonth = day.getMonth() === month;
  const past = isPastDay(day);
  const extra = jobs.length - MAX_IN_CELL;

  return (
    <Box onClick={onSelect} role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${longDay(day)}, ${jobs.length} post${jobs.length === 1 ? '' : 's'}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      sx={{ position: 'relative', minHeight: { xs: 64, md: 124 }, p: { xs: 0.5, md: 1 }, cursor: 'pointer',
        borderRight: 1, borderBottom: 1, borderColor: 'divider',
        bgcolor: selected ? '#FFF3EE' : inMonth ? '#fff' : '#FAF9F6', transition: 'background-color .15s',
        outline: selected ? `2px solid ${tokens.signal}` : 'none', outlineOffset: -2, zIndex: selected ? 1 : 0,
        '&:hover': { bgcolor: selected ? '#FFF3EE' : '#FCFBF8' }, '&:hover .add, &:focus-within .add': { opacity: 1 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb={0.75}>
        <Box sx={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center',
          bgcolor: today ? 'primary.main' : 'transparent', color: today ? '#fff' : inMonth ? (past ? 'text.secondary' : 'text.primary') : '#B9B6AE',
          fontWeight: today ? 800 : 650, fontSize: 13 }}>
          {day.getDate()}
        </Box>
        {!past && (
          <Tooltip title="Schedule on this day">
            <IconButton className="add" size="small" aria-label={`Schedule on ${day.toLocaleDateString()}`}
              onClick={(e) => { e.stopPropagation(); onAdd(day); }}
              sx={{ opacity: 0, transition: 'opacity .15s', p: 0.4, color: 'primary.main', display: { xs: 'none', md: 'inline-flex' } }}>
              <Plus size={15} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {/* Desktop: entries. Mobile: coloured dots. */}
      <Stack spacing={0.5} sx={{ display: { xs: 'none', md: 'flex' } }}>
        {jobs.slice(0, MAX_IN_CELL).map((j) => <CellEntry key={j.id} job={j} onClick={(e) => { e.stopPropagation(); onSelect(); }} />)}
        {extra > 0 && <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: 'text.secondary', pl: 0.5 }}>+{extra} more</Typography>}
      </Stack>
      <Stack direction="row" flexWrap="wrap" gap={0.4} sx={{ display: { xs: 'flex', md: 'none' }, pl: 0.5 }}>
        {jobs.slice(0, 6).map((j) => <Box key={j.id} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: STATUS_COLOR[j.delay ? 'delayed' : j.status].fg }} />)}
      </Stack>
    </Box>
  );
}

function MonthView({ days, month, byDay, selected, onSelect, onAdd }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
      {WEEKDAYS.map((w) => (
        <Typography key={w} variant="overline" sx={{ px: { xs: 0.5, md: 1 }, py: 1, color: 'text.secondary', borderRight: 1, borderBottom: 1,
          borderColor: 'divider', bgcolor: '#FAF9F6', lineHeight: 1.6 }}>{w}</Typography>
      ))}
      {days.map((d) => (
        <DayCell key={dayKey(d)} day={d} month={month} jobs={byDay.get(dayKey(d)) || []}
          selected={sameDay(d, selected)} onSelect={() => onSelect(d)} onAdd={(day) => onAdd(day)} />
      ))}
    </Box>
  );
}

function TimeEvent({ item, compact, onClick }) {
  const preview = React.useContext(PreviewContext);
  const { job, start, lane, lanes } = item;
  const c = STATUS_COLOR[job.delay ? 'delayed' : job.status];
  const width = 100 / lanes;
  return (
    <Box component="button" onClick={(e) => { onClick(e); preview(job); }} title={`${timeOf(job.scheduled_at)} · ${job.destination_name}`}
      sx={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', position: 'absolute', zIndex: 2,
        top: (start / 60) * HOUR_PX + 1, height: (EVENT_MIN / 60) * HOUR_PX - 2,
        left: `calc(${lane * width}% + 3px)`, width: `calc(${width}% - 6px)`,
        px: 1, py: 0.5, borderRadius: '3px', overflow: 'hidden', bgcolor: c.bg,
        borderLeft: `3px solid ${TYPE_COLOR[job.destination_type]}`, opacity: job.status === 'cancelled' ? 0.55 : 1,
        boxShadow: '0 1px 2px rgba(21,23,28,.08)', '&:hover': { filter: 'brightness(0.96)', zIndex: 3 } }}>
      <Typography noWrap sx={{ fontSize: 11, fontWeight: 700, color: c.fg, lineHeight: 1.3 }}>{timeOf(job.scheduled_at)}</Typography>
      <Typography noWrap sx={{ fontSize: 12, fontWeight: 650, color: tokens.ink, lineHeight: 1.3 }}>{job.destination_name}</Typography>
      {!compact && <Typography noWrap sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.3 }}>{job.post_body}</Typography>}
    </Box>
  );
}

function TimeGridView({ days, byDay, selected, onSelect, onAdd }) {
  const scroller = useRef(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  // Open scrolled to an hour before the earliest post in view, or 7 AM.
  useEffect(() => {
    const starts = days.flatMap((d) => (byDay.get(dayKey(d)) || []).map((j) => new Date(j.scheduled_at).getHours()));
    const hour = starts.length ? Math.max(0, Math.min(...starts) - 1) : 7;
    if (scroller.current) scroller.current.scrollTop = hour * HOUR_PX;
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const single = days.length === 1;
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;

  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: cols, borderBottom: 1, borderColor: 'divider', bgcolor: '#FAF9F6' }}>
        <Box sx={{ borderRight: 1, borderColor: 'divider' }} />
        {days.map((d) => {
          const today = sameDay(d, now);
          const count = (byDay.get(dayKey(d)) || []).length;
          return (
            <Box key={dayKey(d)} onClick={() => onSelect(d)} role="button" tabIndex={0}
              aria-label={`${longDay(d)}, ${count} post${count === 1 ? '' : 's'}`}
              sx={{ cursor: 'pointer', py: 1, px: 1, borderRight: 1, borderColor: 'divider', textAlign: single ? 'left' : 'center',
                bgcolor: sameDay(d, selected) && !single ? '#FFF3EE' : 'transparent' }}>
              <Typography variant="overline" sx={{ color: today ? 'primary.main' : 'text.secondary', lineHeight: 1.4, display: 'block' }}>
                {WEEKDAYS[d.getDay()]}
              </Typography>
              <Stack direction="row" alignItems="center" justifyContent={single ? 'flex-start' : 'center'} spacing={1}>
                <Box sx={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  bgcolor: today ? 'primary.main' : 'transparent', color: today ? '#fff' : isPastDay(d) ? 'text.secondary' : 'text.primary',
                  fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 750, fontSize: 16 }}>
                  {d.getDate()}
                </Box>
                {count > 0 && <Typography variant="caption" color="text.secondary" fontWeight={600}>{count} post{count === 1 ? '' : 's'}</Typography>}
              </Stack>
            </Box>
          );
        })}
      </Box>

      <Box ref={scroller} sx={{ maxHeight: { xs: 520, md: 640 }, overflowY: 'auto' }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: cols, position: 'relative' }}>
          <Box sx={{ borderRight: 1, borderColor: 'divider' }}>
            {Array.from({ length: 24 }, (_, h) => (
              <Box key={h} sx={{ height: HOUR_PX, position: 'relative' }}>
                {h > 0 && (
                  <Typography sx={{ position: 'absolute', top: -8, right: 8, fontSize: 11, color: 'text.secondary', fontWeight: 600 }}>
                    {hourLabel(h)}
                  </Typography>
                )}
              </Box>
            ))}
          </Box>

          {days.map((d) => {
            const items = layoutDay(byDay.get(dayKey(d)) || []);
            const today = sameDay(d, now);
            return (
              <Box key={dayKey(d)} sx={{ position: 'relative', borderRight: 1, borderColor: 'divider',
                bgcolor: isPastDay(d) ? '#FAF9F6' : '#fff' }}>
                {Array.from({ length: 24 }, (_, h) => {
                  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h + 1);
                  const open = slot > now;
                  return (
                    <Box key={h} onClick={() => open && onAdd(d, h)}
                      aria-label={open ? `Schedule ${longDay(d)} at ${hourLabel(h)}` : undefined}
                      sx={{ height: HOUR_PX, borderTop: h ? 1 : 0, borderColor: '#EFECE6', cursor: open ? 'pointer' : 'default',
                        position: 'relative', '&:hover .slot': { opacity: open ? 1 : 0 } }}>
                      <Stack className="slot" direction="row" alignItems="center" spacing={0.5}
                        sx={{ opacity: 0, transition: 'opacity .12s', position: 'absolute', inset: 2, px: 1, borderRadius: '3px',
                          border: `1px dashed ${tokens.signal}`, color: 'primary.main', bgcolor: '#FFF7F3' }}>
                        <Plus size={13} />
                        <Typography sx={{ fontSize: 11.5, fontWeight: 700 }}>{hourLabel(h)}</Typography>
                      </Stack>
                    </Box>
                  );
                })}
                {items.map((item) => (
                  <TimeEvent key={item.job.id} item={item} compact={!single}
                    onClick={(e) => { e.stopPropagation(); onSelect(d); }} />
                ))}
                {today && (
                  <Box sx={{ position: 'absolute', left: 0, right: 0, top: nowTop, height: 2, bgcolor: 'primary.main', zIndex: 4, pointerEvents: 'none',
                    '&::before': { content: '""', position: 'absolute', left: -5, top: -4, width: 10, height: 10, borderRadius: '50%', bgcolor: 'primary.main' } }} />
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function DayAgenda({ day, jobs, onAdd }) {
  const preview = React.useContext(PreviewContext);
  const past = isPastDay(day);
  return (
    <Panel
      title={longDay(day)}
      action={!past && <Button size="small" variant="contained" startIcon={<Plus size={16} />} onClick={() => onAdd(day)}>Schedule</Button>}
      sx={{ position: { lg: 'sticky' }, top: { lg: 24 } }}>
      {!jobs.length ? (
        <EmptyState icon={CalendarDays} title="Nothing on this day">
          {!past && <Typography variant="body2">Use Schedule to plan a post here.</Typography>}
        </EmptyState>
      ) : (
        <Stack spacing={0.75}>
          {/* Latest first: the newest post of the day is on top. */}
          {[...jobs].sort((x, y) => y.scheduled_at.localeCompare(x.scheduled_at)).map((j) => (
            <Box key={j.id} role="button" tabIndex={0} onClick={() => preview(j)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(j); } }}
              sx={{ cursor: 'pointer', '&:hover': { bgcolor: '#FCFBF8', borderColor: '#D9D4CA' }, px: 1.25, py: 0.875, borderRadius: '3px', border: 1, borderColor: 'divider',
              borderLeft: `3px solid ${TYPE_COLOR[j.destination_type]}` }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography fontWeight={800} fontSize={13} sx={{ fontFamily: '"Bricolage Grotesque Variable"', flex: 'none', minWidth: 62 }}>{timeOf(j.scheduled_at)}</Typography>
                <Typography fontWeight={700} fontSize={13} noWrap sx={{ flex: 1, minWidth: 0 }} title={j.destination_name}>{j.destination_name}</Typography>
                <Box sx={{ flex: 'none', '& .MuiChip-root': { height: 22, fontSize: 11.5 } }}><JobStatusChip job={j} /></Box>
              </Stack>
              <Typography noWrap fontSize={12.5} color="text.secondary" mt={0.25} title={j.post_body}>
                {(j.post_body || '(media only)').replace(/\s+/g, ' ')}
              </Typography>
              {j.delay && <Typography variant="caption" fontWeight={600} sx={{ color: '#B54708' }} display="block" noWrap mt={0.25} title={delayText(j.delay)}>{delayText(j.delay)}</Typography>}
              {j.last_error && <Typography variant="caption" color="error" display="block" noWrap mt={0.25} title={j.last_error}>{j.last_error}</Typography>}
            </Box>
          ))}
        </Stack>
      )}
    </Panel>
  );
}

function initialView() {
  try { return ['month', 'week', 'day'].includes(localStorage.getItem('calendarView')) ? localStorage.getItem('calendarView') : 'month'; }
  catch { return 'month'; }
}

export default function Calendar({ onAdd }) {
  const [view, setView] = useState(initialView);
  const [anchor, setAnchor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => new Date());
  const [jobs, setJobs] = useState([]);
  const [previewing, setPreviewing] = useState(null);

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  const load = useCallback(() => {
    api.jobsBetween(days[0], addDays(days.at(-1), 1)).then(setJobs).catch(() => {});
  }, [days]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const j of [...jobs].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))) {
      const k = dayKey(new Date(j.scheduled_at));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(j);
    }
    return map;
  }, [jobs]);

  const changeView = (_, v) => {
    if (!v) return;
    setView(v);
    setAnchor(selected);
    try { localStorage.setItem('calendarView', v); } catch { /* storage unavailable */ }
  };
  const shift = (n) => {
    const next = shiftAnchor(view, anchor, n);
    setAnchor(next);
    setSelected(view === 'week' ? addDays(selected, 7 * n) : next);
  };
  const goToday = () => { const d = new Date(); setAnchor(d); setSelected(d); };
  const select = (d) => { setSelected(d); if (view === 'day') setAnchor(d); };
  const add = (day, hour) => onAdd(slotFor(day, hour));

  const [title, year] = viewTitle(view, anchor, days);
  const inRange = view === 'month'
    ? jobs.filter((j) => new Date(j.scheduled_at).getMonth() === anchor.getMonth()).length
    : jobs.length;
  const rangeWord = { month: 'this month', week: 'this week', day: 'this day' }[view];

  return (
    <PreviewContext.Provider value={setPreviewing}>
    {previewing && <PostPreview job={previewing} onClose={() => setPreviewing(null)} />}
    <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0,1fr) 340px' }, alignItems: 'start' }}>
      <Paper sx={{ overflow: 'hidden' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} spacing={1.5}
          sx={{ px: { xs: 1.5, md: 2.5 }, py: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography noWrap sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 750, fontSize: { xs: 20, md: 24 }, letterSpacing: '-0.02em' }}>
              {title} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500 }}>{year}</Box>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {inRange} post{inRange === 1 ? '' : 's'} {rangeWord}
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" spacing={1}>
            <ToggleButtonGroup exclusive size="small" value={view} onChange={changeView}
              sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 650, px: 1.75, borderColor: 'divider' },
                '& .Mui-selected': { bgcolor: `${tokens.ink} !important`, color: '#fff !important' } }}>
              <ToggleButton value="month">Month</ToggleButton>
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="day">Day</ToggleButton>
            </ToggleButtonGroup>
            <Box sx={{ flex: { xs: 1, sm: 'none' } }} />
            <Button size="small" variant="outlined" color="secondary" onClick={goToday}>Today</Button>
            <IconButton size="small" onClick={() => shift(-1)} aria-label={`Previous ${view}`}><ChevronLeft size={18} /></IconButton>
            <IconButton size="small" onClick={() => shift(1)} aria-label={`Next ${view}`}><ChevronRight size={18} /></IconButton>
          </Stack>
        </Stack>

        {view === 'month'
          ? <MonthView days={days} month={anchor.getMonth()} byDay={byDay} selected={selected} onSelect={select} onAdd={add} />
          : <TimeGridView days={days} byDay={byDay} selected={selected} onSelect={select} onAdd={add} />}

        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ px: 2.5, py: 1.5, borderTop: view === 'month' ? 0 : 1, borderColor: 'divider' }}>
          {Object.entries(TYPE_COLOR).map(([t, c]) => (
            <Stack key={t} direction="row" alignItems="center" spacing={0.75}>
              <Box sx={{ width: 10, height: 10, borderRadius: 0.75, bgcolor: c }} />
              <Typography variant="caption" color="text.secondary" fontWeight={600}>{TYPE_LABEL[t]}</Typography>
            </Stack>
          ))}
          {view !== 'month' && <Typography variant="caption" color="text.secondary">· Click an empty hour to schedule there</Typography>}
        </Stack>
      </Paper>

      <DayAgenda day={selected} jobs={byDay.get(dayKey(selected)) || []} onAdd={(d) => add(d)} />
    </Box>
    </PreviewContext.Provider>
  );
}
