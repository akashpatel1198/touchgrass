// Single dark-mode palette. Gym/walk lighting and the "phone is the remote" framing
// both make a permanent dark theme the right call. No theme-switching, no light mode.
//
// Single accent color picked for high contrast on dark surfaces. System fonts.

export const colors = {
  bg: "#0b0b0d",
  surface: "#16171b",
  surfaceElevated: "#1f2127",
  border: "#2a2d35",
  text: "#e6e7eb",
  textMuted: "#8b8f9a",
  textDim: "#5b5f68",
  accent: "#7cf2c2",
  accentMuted: "#3a8868",
  danger: "#ff6b6b",
  warning: "#f5b95a",
  ok: "#7cf2c2",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;

export const fontSizes = {
  xs: 12,
  sm: 14,
  body: 16,
  lg: 18,
  title: 22,
  display: 28,
} as const;
