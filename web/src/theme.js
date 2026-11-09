import { createTheme, alpha } from '@mui/material/styles';

const ink = '#15171C';
const paper = '#F5F3EE';
const signal = '#FF5B1F';
const line = '#E4E0D7';

export const tokens = { ink, paper, signal, line, inkSoft: '#23262E', inkMuted: '#8C909A' };

export const STATUS_COLOR = {
  queued: { fg: '#4A4E58', bg: '#ECEAE4' },
  running: { fg: '#5A3FD1', bg: '#ECE8FC' },
  submitted: { fg: '#147A46', bg: '#DDF3E6' },
  pending_approval: { fg: '#1C5FD1', bg: '#E1EBFC' },
  awaiting_join: { fg: '#0E8A7E', bg: '#DDF3F0' },
  failed: { fg: '#C42B1C', bg: '#FCE3DF' },
  needs_check: { fg: '#9A5B00', bg: '#FDEFD6' },
  needs_login: { fg: '#9A5B00', bg: '#FDEFD6' },
  cancelled: { fg: '#8C909A', bg: '#F0EEE9' },
  delayed: { fg: '#B54708', bg: '#FDEBD3' },
};

export const TYPE_COLOR = { profile: '#1C5FD1', page: '#7A3FD1', group: '#0E8A7E' };

const display = '"Bricolage Grotesque Variable", "Manrope Variable", sans-serif';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: signal, contrastText: '#fff' },
    secondary: { main: ink },
    background: { default: paper, paper: '#FFFFFF' },
    text: { primary: ink, secondary: '#646873' },
    divider: line,
    success: { main: '#147A46' },
    warning: { main: '#C77A00' },
    error: { main: '#C42B1C' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Manrope Variable", sans-serif',
    h1: { fontFamily: display, fontWeight: 700, fontSize: '2rem', letterSpacing: '-0.02em' },
    h2: { fontFamily: display, fontWeight: 650, fontSize: '1.15rem', letterSpacing: '-0.01em' },
    h3: { fontFamily: display, fontWeight: 700, fontSize: '2rem', letterSpacing: '-0.03em' },
    button: { textTransform: 'none', fontWeight: 650 },
    overline: { fontWeight: 700, letterSpacing: '0.12em', fontSize: '0.68rem' },
  },
  components: {
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { border: `1px solid ${line}`, backgroundImage: 'none' } },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 10, paddingInline: 16 },
        containedPrimary: { boxShadow: `0 6px 18px -8px ${alpha(signal, 0.7)}` },
      },
    },
    MuiChip: { styleOverrides: { root: { fontWeight: 650, borderRadius: 8 } } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { backgroundColor: '#FBFAF7', borderRadius: 10, '& fieldset': { borderColor: line } },
      },
    },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiListItemButton: { styleOverrides: { root: { borderRadius: 10 } } },
  },
});
