import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import {
  BarChart2, Bookmark, Earth, Heart, MessageCircle, MoreHorizontal, Music2, Repeat2, Send, Share2, ThumbsUp, Users, ArrowBigUp, ArrowBigDown,
} from 'lucide-react';
import { api, inApp, PLATFORMS, formatWhen } from './api.js';
import { JobStatusChip } from './components.jsx';

// How each platform shows a post: how much text before "See more", the text limit, and the font it uses.
const SYSTEM = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const RULES = {
  facebook: { limit: 63206, cut: 480, lines: 5, more: 'See more' },
  linkedin: { limit: 3000, cut: 210, lines: 3, more: '…more' },
  x: { limit: 280, cut: 280, lines: 99, more: 'Show more' },
  threads: { limit: 500, cut: 500, lines: 99, more: 'Show more' },
  instagram: { limit: 2200, cut: 125, lines: 2, more: '… more' },
  tiktok: { limit: 2200, cut: 80, lines: 2, more: 'more' },
  reddit: { limit: 40000, cut: 600, lines: 8, more: 'Read more' },
};

// Facebook's own date style: "November 8 at 4:00 PM".
const fbWhen = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`; };

const handleOf = (url = '') => {
  const m = url.replace(/\/+$/, '').match(/\/(?:in\/|user\/|u\/|@)?([^/?#]+)$/);
  return m ? m[1].replace(/^@/, '') : 'you';
};

// Links, #hashtags and @mentions in the platform's link color.
function Rich({ text, color }) {
  const parts = text.split(/(https?:\/\/\S+|#[\p{L}\p{N}_]+|@[\w.]+)/gu);
  return parts.map((p, i) => (/^(https?:\/\/|#|@)/.test(p) && p.length > 1
    ? <Box key={i} component="span" sx={{ color, fontWeight: 500 }}>{p}</Box> : <React.Fragment key={i}>{p}</React.Fragment>));
}

// The post text, cut where the platform cuts it, with its own "See more".
function Body({ text, platform, color, sx, big }) {
  const r = RULES[platform] || RULES.facebook;
  const [open, setOpen] = useState(false);
  const long = text.length > r.cut || text.split('\n').length > r.lines;
  const shown = open || !long ? text : text.slice(0, r.cut).split('\n').slice(0, r.lines).join('\n').replace(/\s+\S*$/, '');
  if (!text) return null;
  return (
    <Typography component="div" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: SYSTEM, ...sx, ...(big ? { fontSize: 24, lineHeight: 1.25 } : {}) }}>
      <Rich text={shown} color={color} />
      {long && !open && (
        <>{platform === 'linkedin' || platform === 'instagram' ? '' : '… '}
          <Box component="button" onClick={() => setOpen(true)} sx={{ all: 'unset', cursor: 'pointer', fontWeight: 600, color: platform === 'x' || platform === 'threads' ? color : 'inherit', opacity: platform === 'x' || platform === 'threads' ? 1 : 0.75 }}>
            {r.more}
          </Box>
        </>
      )}
    </Typography>
  );
}

function Avatar({ src, name, size = 40, square = false }) {
  const [bad, setBad] = useState(false);
  const letters = (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  return src && !bad
    ? <Box component="img" src={src} alt="" onError={() => setBad(true)} sx={{ width: size, height: size, borderRadius: square ? '8px' : '50%', objectFit: 'cover', flex: 'none' }} />
    : <Box sx={{ width: size, height: size, borderRadius: square ? '8px' : '50%', bgcolor: '#8B93A1', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: size * 0.38, flex: 'none' }}>{letters}</Box>;
}

const Media = ({ m, sx }) => (m.kind === 'video'
  ? <Box component="video" src={m.url} muted controls sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', bgcolor: '#000', ...sx }} />
  : <Box component="img" src={m.url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...sx }} />);

// Facebook's photo layouts: 1 full, 2 side by side, 3 = one big + two, 4 = 2x2, 5+ = 2 over 3 with "+N".
function FbGrid({ media }) {
  const n = media.length;
  if (!n) return null;
  if (n === 1) return <Box sx={{ maxHeight: 520, overflow: 'hidden', bgcolor: '#000' }}><Media m={media[0]} sx={{ maxHeight: 520, objectFit: 'contain' }} /></Box>;
  const cell = (m, i, extra) => (
    <Box key={i} sx={{ position: 'relative', aspectRatio: '1', overflow: 'hidden' }}>
      <Media m={m} />
      {extra > 0 && <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(0,0,0,.45)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 30, fontWeight: 700 }}>+{extra}</Box>}
    </Box>
  );
  if (n === 2) return <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' }}>{media.map((m, i) => cell(m, i))}</Box>;
  if (n === 3) {
    return (
      <Box sx={{ display: 'grid', gap: '2px' }}>
        <Box sx={{ aspectRatio: '2 / 1', overflow: 'hidden' }}><Media m={media[0]} /></Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' }}>{media.slice(1).map((m, i) => cell(m, i))}</Box>
      </Box>
    );
  }
  if (n === 4) return <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' }}>{media.map((m, i) => cell(m, i))}</Box>;
  return (
    <Box sx={{ display: 'grid', gap: '2px' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px' }}>{media.slice(0, 2).map((m, i) => cell(m, i))}</Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2px' }}>{media.slice(2, 5).map((m, i) => cell(m, i, i === 2 ? n - 5 : 0))}</Box>
    </Box>
  );
}

// X and Threads: up to 4 in a rounded grid.
function RoundGrid({ media, max = 4, radius = 16 }) {
  const list = media.slice(0, max);
  if (!list.length) return null;
  return (
    <Box sx={{ mt: 1.25, borderRadius: `${radius}px`, overflow: 'hidden', border: '1px solid #CFD9DE', display: 'grid', gap: '2px',
      gridTemplateColumns: list.length > 1 ? '1fr 1fr' : '1fr', aspectRatio: list.length === 1 ? 'auto' : '16 / 9' }}>
      {list.map((m, i) => (
        <Box key={i} sx={{ overflow: 'hidden', gridRow: list.length === 3 && i === 0 ? 'span 2' : 'auto', maxHeight: list.length === 1 ? 510 : 'none' }}><Media m={m} /></Box>
      ))}
    </Box>
  );
}

const Action = ({ icon: Icon, label, color = '#65676B', size = 18 }) => (
  <Stack direction="row" alignItems="center" spacing={0.75} sx={{ color, fontSize: 14, fontWeight: 600, fontFamily: SYSTEM }}>
    <Icon size={size} strokeWidth={1.9} />{label && <span>{label}</span>}
  </Stack>
);

function Facebook({ p }) {
  const group = p.type === 'group';
  const short = !p.media.length && p.text.length < 85 && !p.text.includes('\n');
  return (
    <Box sx={{ bgcolor: '#fff', borderRadius: '8px', boxShadow: '0 1px 2px rgba(0,0,0,.2)', fontFamily: SYSTEM, color: '#050505', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1.25} sx={{ p: '12px 16px 0' }}>
        {group ? (
          <Box sx={{ position: 'relative', width: 44, height: 44, flex: 'none' }}>
            <Box sx={{ width: 40, height: 40, borderRadius: '8px', bgcolor: '#E4E6EB', display: 'grid', placeItems: 'center', color: '#65676B' }}><Users size={20} /></Box>
            <Box sx={{ position: 'absolute', right: 0, bottom: 0, border: '2px solid #fff', borderRadius: '50%' }}><Avatar src={p.avatar} name={p.author} size={24} /></Box>
          </Box>
        ) : <Avatar src={p.avatar} name={p.author} />}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 15, lineHeight: 1.33, fontFamily: SYSTEM }} noWrap>{group ? p.place : p.author}</Typography>
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ color: '#65676B', fontSize: 13, fontFamily: SYSTEM }}>
            {group && <><span style={{ fontWeight: 600, color: '#65676B' }}>{p.author}</span><span>·</span></>}
            <span>{p.when}</span><span>·</span>{group ? <Users size={12} /> : <Earth size={12} />}
          </Stack>
        </Box>
        <MoreHorizontal size={20} color="#65676B" />
      </Stack>
      <Body text={p.text} platform="facebook" color="#0064D1" big={short} sx={{ fontSize: 15, lineHeight: 1.34, p: '4px 16px 12px' }} />
      <FbGrid media={p.media} />
      <Stack direction="row" justifyContent="space-between" sx={{ mx: 2, py: 1, borderBottom: '1px solid #CED0D4', color: '#65676B', fontSize: 14 }}>
        <span>Be the first to react</span>{p.comment && <span>1 comment</span>}
      </Stack>
      <Stack direction="row" justifyContent="space-around" sx={{ py: 0.75, mx: 2 }}>
        <Action icon={ThumbsUp} label="Like" /><Action icon={MessageCircle} label="Comment" /><Action icon={Share2} label="Share" />
      </Stack>
      {p.comment && (
        <Stack direction="row" spacing={1} sx={{ p: '4px 16px 14px', borderTop: '1px solid #CED0D4', pt: 1.5 }}>
          <Avatar src={p.avatar} name={p.author} size={32} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ bgcolor: '#F0F2F5', borderRadius: '18px', px: 1.5, py: 1 }}>
              <Typography sx={{ fontWeight: 600, fontSize: 13, fontFamily: SYSTEM }}>{p.author} <Box component="span" sx={{ fontWeight: 600, color: '#65676B', fontSize: 12 }}>Author</Box></Typography>
              <Typography component="div" sx={{ fontSize: 15, fontFamily: SYSTEM, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><Rich text={p.comment} color="#0064D1" /></Typography>
            </Box>
            <Stack direction="row" spacing={1.5} sx={{ pl: 1.5, mt: 0.25, fontSize: 12, fontWeight: 700, color: '#65676B', fontFamily: SYSTEM }}><span>Just now</span><span>Like</span><span>Reply</span></Stack>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

function Tweetish({ p, threads }) {
  const color = threads ? '#0095F6' : '#1D9BF0';
  const row = (text, media, isReply) => (
    <Stack direction="row" spacing={1.5} sx={{ position: 'relative' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Avatar src={p.avatar} name={p.author} size={threads ? 36 : 40} />
        {!isReply && p.comment && <Box sx={{ width: 2, flex: 1, bgcolor: '#CFD9DE', mt: 0.5 }} />}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, pb: !isReply && p.comment ? 2 : 0 }}>
        <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ fontFamily: SYSTEM, fontSize: 15, minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 700, fontFamily: SYSTEM, fontSize: 15, color: '#0F1419' }}>{threads ? p.handle : p.author}</Typography>
          {!threads && <Typography noWrap sx={{ color: '#536471', fontFamily: SYSTEM, fontSize: 15 }}>@{p.handle} · now</Typography>}
          {threads && <Typography sx={{ color: '#999', fontFamily: SYSTEM, fontSize: 15 }}>now</Typography>}
        </Stack>
        <Body text={text} platform={threads ? 'threads' : 'x'} color={color} sx={{ fontSize: 15, lineHeight: 1.33, color: '#0F1419', mt: 0.25 }} />
        <RoundGrid media={media} max={threads ? 10 : 4} radius={threads ? 8 : 16} />
        <Stack direction="row" justifyContent={threads ? 'flex-start' : 'space-between'} spacing={threads ? 2.5 : 0} sx={{ mt: 1.25, maxWidth: 425 }}>
          {threads
            ? [Heart, MessageCircle, Repeat2, Send].map((I, i) => <Action key={i} icon={I} color="#424242" size={19} />)
            : [MessageCircle, Repeat2, Heart, BarChart2, Bookmark].map((I, i) => <Action key={i} icon={I} color="#536471" />)}
        </Stack>
      </Box>
    </Stack>
  );
  return (
    <Box sx={{ bgcolor: '#fff', border: '1px solid #EFF3F4', borderRadius: threads ? '16px' : 0, p: 2, fontFamily: SYSTEM }}>
      {row(p.text, p.media, false)}
      {p.comment && row(p.comment, [], true)}
    </Box>
  );
}

function LinkedIn({ p }) {
  return (
    <Box sx={{ bgcolor: '#fff', borderRadius: '8px', border: '1px solid #E0DFDC', fontFamily: SYSTEM, color: 'rgba(0,0,0,.9)', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1} sx={{ p: '12px 16px 0' }}>
        <Avatar src={p.avatar} name={p.author} size={48} square={p.type === 'page'} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 14, fontFamily: SYSTEM }} noWrap>{p.author} <Box component="span" sx={{ fontWeight: 400, color: 'rgba(0,0,0,.6)' }}>• You</Box></Typography>
          {p.type === 'group' && <Typography noWrap sx={{ fontSize: 12, color: 'rgba(0,0,0,.6)', fontFamily: SYSTEM }}>in {p.place}</Typography>}
          <Stack direction="row" alignItems="center" spacing={0.5} sx={{ fontSize: 12, color: 'rgba(0,0,0,.6)' }}><span>now •</span><Earth size={12} /></Stack>
        </Box>
        <MoreHorizontal size={20} color="rgba(0,0,0,.6)" />
      </Stack>
      <Body text={p.text} platform="linkedin" color="#0A66C2" sx={{ fontSize: 14, lineHeight: 1.43, p: '8px 16px 8px' }} />
      {p.media.length > 0 && <FbGrid media={p.media} />}
      <Box sx={{ mx: 2, borderTop: '1px solid #E0DFDC', mt: 1 }} />
      <Stack direction="row" justifyContent="space-around" sx={{ py: 0.75 }}>
        {[[ThumbsUp, 'Like'], [MessageCircle, 'Comment'], [Repeat2, 'Repost'], [Send, 'Send']].map(([I, l]) => <Action key={l} icon={I} label={l} color="rgba(0,0,0,.6)" />)}
      </Stack>
      {p.comment && (
        <Stack direction="row" spacing={1} sx={{ p: '4px 16px 14px' }}>
          <Avatar src={p.avatar} name={p.author} size={32} square={p.type === 'page'} />
          <Box sx={{ bgcolor: '#F2F2F2', borderRadius: '0 8px 8px 8px', px: 1.5, py: 1, flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600, fontSize: 14, fontFamily: SYSTEM }}>{p.author} <Box component="span" sx={{ fontSize: 12, fontWeight: 400, color: 'rgba(0,0,0,.6)' }}>• Author</Box></Typography>
            <Typography component="div" sx={{ fontSize: 14, fontFamily: SYSTEM, whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.5 }}><Rich text={p.comment} color="#0A66C2" /></Typography>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

function Instagram({ p }) {
  const first = p.media[0];
  return (
    <Box sx={{ bgcolor: '#fff', border: '1px solid #DBDBDB', borderRadius: '8px', fontFamily: SYSTEM, color: '#262626', overflow: 'hidden', maxWidth: 470, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ p: 1.5 }}>
        <Box sx={{ p: '2px', borderRadius: '50%', background: 'linear-gradient(45deg,#F9CE34,#EE2A7B,#6228D7)' }}><Box sx={{ p: '2px', bgcolor: '#fff', borderRadius: '50%' }}><Avatar src={p.avatar} name={p.author} size={32} /></Box></Box>
        <Typography sx={{ fontWeight: 600, fontSize: 14, fontFamily: SYSTEM, flex: 1 }}>{p.handle}</Typography>
        <MoreHorizontal size={20} />
      </Stack>
      <Box sx={{ aspectRatio: first?.kind === 'video' ? '4 / 5' : '1', bgcolor: '#EFEFEF', position: 'relative' }}>
        {first ? <Media m={first} /> : <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: '#8E8E8E', fontSize: 14 }}>Instagram needs a photo or video</Box>}
        {p.media.length > 1 && <Box sx={{ position: 'absolute', top: 12, right: 12, bgcolor: 'rgba(0,0,0,.6)', color: '#fff', borderRadius: '12px', px: 1, fontSize: 12, fontWeight: 600 }}>1/{p.media.length}</Box>}
      </Box>
      <Stack direction="row" spacing={2} sx={{ px: 1.5, pt: 1.25, color: '#262626' }}>
        <Heart size={24} /><MessageCircle size={24} /><Send size={24} /><Box flex={1} />
        {p.media.length > 1 && <Stack direction="row" spacing={0.5} sx={{ position: 'absolute', left: '50%' }} />}
        <Bookmark size={24} />
      </Stack>
      {p.media.length > 1 && (
        <Stack direction="row" spacing={0.5} justifyContent="center" sx={{ mt: -2.5, mb: 1 }}>
          {p.media.slice(0, 10).map((_, i) => <Box key={i} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: i ? '#C7C7C7' : '#0095F6' }} />)}
        </Stack>
      )}
      <Box sx={{ px: 1.5, pt: 1, pb: 1.5 }}>
        <Body text={`${p.handle} ${p.text}`} platform="instagram" color="#00376B" sx={{ fontSize: 14, lineHeight: 1.4 }} />
        {p.comment && <Typography component="div" sx={{ fontSize: 14, mt: 0.5, fontFamily: SYSTEM }}><b>{p.handle}</b> <Rich text={p.comment} color="#00376B" /></Typography>}
        <Typography sx={{ fontSize: 10, color: '#8E8E8E', textTransform: 'uppercase', mt: 0.75, letterSpacing: '.2px' }}>Just now</Typography>
      </Box>
    </Box>
  );
}

function TikTok({ p }) {
  const video = p.media.find((m) => m.kind === 'video');
  return (
    <Box sx={{ width: 320, mx: 'auto', aspectRatio: '9 / 16', bgcolor: '#000', borderRadius: '12px', overflow: 'hidden', position: 'relative', fontFamily: SYSTEM, color: '#fff' }}>
      {video ? <Media m={video} /> : <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: '#aaa', fontSize: 14, px: 3, textAlign: 'center' }}>TikTok needs a video</Box>}
      <Stack spacing={2.25} alignItems="center" sx={{ position: 'absolute', right: 10, bottom: 90 }}>
        <Avatar src={p.avatar} name={p.author} size={44} />
        {[Heart, MessageCircle, Bookmark, Share2].map((I, i) => <I key={i} size={30} fill="#fff" strokeWidth={1} />)}
      </Stack>
      <Box sx={{ position: 'absolute', left: 12, right: 64, bottom: 16, textShadow: '0 1px 2px rgba(0,0,0,.6)' }}>
        <Typography sx={{ fontWeight: 700, fontSize: 15, fontFamily: SYSTEM }}>{p.handle}</Typography>
        <Body text={p.text} platform="tiktok" color="#fff" sx={{ fontSize: 14, lineHeight: 1.35, fontWeight: 600 }} />
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75, fontSize: 13 }}><Music2 size={13} /><span>original sound · {p.handle}</span></Stack>
      </Box>
    </Box>
  );
}

function Reddit({ p }) {
  const [title, ...rest] = p.text.split('\n');
  return (
    <Box sx={{ bgcolor: '#fff', border: '1px solid #EDEFF1', borderRadius: '8px', fontFamily: SYSTEM, color: '#1A1A1B', p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ fontSize: 12, color: '#576F76' }}>
        <Avatar src={null} name={p.place} size={24} />
        <b style={{ color: '#1A1A1B' }}>{p.type === 'group' ? p.place.replace(/^(r\/)?/, 'r/') : `u/${p.handle}`}</b><span>• now</span>
      </Stack>
      <Typography sx={{ fontWeight: 600, fontSize: 18, mt: 1, fontFamily: SYSTEM, lineHeight: 1.3 }}>{title}</Typography>
      <Body text={rest.join('\n').trim()} platform="reddit" color="#0079D3" sx={{ fontSize: 14, lineHeight: 1.5, mt: 0.75, color: '#2A3C42' }} />
      <RoundGrid media={p.media} max={20} radius={16} />
      <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ bgcolor: '#E5EBEE', borderRadius: '20px', px: 1, py: 0.5, fontSize: 12, fontWeight: 700 }}>
          <ArrowBigUp size={18} /><span>Vote</span><ArrowBigDown size={18} />
        </Stack>
        <Box sx={{ bgcolor: '#E5EBEE', borderRadius: '20px', px: 1.25, py: 0.5 }}><Action icon={MessageCircle} label={p.comment ? '1' : '0'} color="#1A1A1B" size={16} /></Box>
        <Box sx={{ bgcolor: '#E5EBEE', borderRadius: '20px', px: 1.25, py: 0.5 }}><Action icon={Share2} label="Share" color="#1A1A1B" size={16} /></Box>
      </Stack>
      {p.comment && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, pl: 0.5 }}>
          <Avatar src={p.avatar} name={p.author} size={24} />
          <Box><Typography sx={{ fontSize: 12, fontWeight: 600, fontFamily: SYSTEM }}>{p.handle} <span style={{ color: '#0079D3' }}>OP</span></Typography>
            <Typography component="div" sx={{ fontSize: 14, fontFamily: SYSTEM, whiteSpace: 'pre-wrap' }}><Rich text={p.comment} color="#0079D3" /></Typography></Box>
        </Stack>
      )}
    </Box>
  );
}

const VIEWS = { facebook: Facebook, x: (props) => <Tweetish {...props} />, threads: (props) => <Tweetish {...props} threads />, linkedin: LinkedIn, instagram: Instagram, tiktok: TikTok, reddit: Reddit };

/**
 * What a scheduled post will look like on its platform: the author (account or Page) with their picture, where it
 * goes, the text cut where the platform cuts it, the photos laid out the platform's way, and the first comment.
 */
export function PostPreview({ job, onClose }) {
  const [media, setMedia] = useState([]);
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    if (!job) return;
    setMedia([]);
    api.postMedia(job.post_id).then(setMedia).catch(() => {});
    api.accounts().then(setAccounts).catch(() => {});
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!job) return null;
  const platform = job.destination_platform || 'facebook';
  const account = accounts.find((a) => a.id === job.account_ref);
  const asPage = job.post_as && job.post_as !== '@self' ? account?.pages?.find((pg) => pg.name === job.post_as) : null;
  const ownPage = job.destination_type === 'page';
  const author = asPage?.name || job.post_as && job.post_as !== '@self' && job.post_as || (ownPage ? job.destination_name : job.account_name) || 'You';
  const avatar = asPage?.avatar_v ? `/api/pages/${asPage.id}/avatar?v=${asPage.avatar_v}` : !ownPage && account?.avatar_v ? `/api/accounts/${account.id}/avatar?v=${account.avatar_v}` : null;
  const p = {
    text: job.post_body || '', comment: job.first_comment || '', media, author, avatar, type: job.destination_type, place: job.destination_name,
    handle: handleOf(ownPage ? job.destination_url : job.account_url || job.destination_url), when: fbWhen(job.scheduled_at),
  };
  const View = VIEWS[platform] || Facebook;
  const rule = RULES[platform] || RULES.facebook;
  const chars = [...p.text].length;
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { bgcolor: '#F0F2F5' } } }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontFamily: '"Bricolage Grotesque Variable"', fontWeight: 700, fontSize: 20 }} noWrap>Preview on {PLATFORMS[platform]?.label || platform}</Typography>
            <Typography variant="body2" color="text.secondary" noWrap>{formatWhen(job.scheduled_at)} · {job.destination_name}</Typography>
          </Box>
          <JobStatusChip job={job} />
        </Stack>
      </DialogTitle>
      <DialogContent>
        {chars > rule.limit && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>{PLATFORMS[platform]?.label} allows {rule.limit.toLocaleString()} characters; this post has {chars.toLocaleString()}. It may be cut or refused.</Alert>
        )}
        <View p={p} />
        <Typography variant="caption" color="text.secondary" display="block" mt={1.25}>
          Posting as <b>{author}</b>{job.account_name && author !== job.account_name ? <> through {job.account_name}</> : null} · {chars.toLocaleString()} characters
          {media.length ? ` · ${media.length} ${media.some((m) => m.kind === 'video') ? 'video' : media.length === 1 ? 'photo' : 'photos'}` : ''}.
          Reactions and counts are placeholders.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        {(job.post_url || job.destination_url) && (
          <Button color="secondary" href={inApp(job.post_url || job.destination_url, job.account_ref)} target="_blank" rel="noreferrer" onClick={onClose}>
            {job.post_url ? 'Open the live post' : `Open ${job.destination_type === 'group' ? 'the group' : 'the page'}`}
          </Button>
        )}
        <Box flex={1} />
        <Button variant="contained" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
