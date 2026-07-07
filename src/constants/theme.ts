/**
 * Grappnel theme tokens. Components read the resolved palette through
 * useThemeColors() (src/hooks/use-theme-colors.ts) so light/dark stay in sync.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    background: '#F7F7FB',
    surface: '#FFFFFF',
    surfaceAlt: '#EFEFF6',
    border: '#E3E3EE',
    text: '#17162B',
    textSecondary: '#5D5C74',
    textTertiary: '#8E8DA6',
    primary: '#5A4FCF',
    onPrimary: '#FFFFFF',
    primarySoft: '#E9E7FB',
    danger: '#D64545',
    dangerSoft: '#FBEAEA',
    success: '#2E9E6B',
    successSoft: '#E4F4EC',
    warning: '#C7861B',
    warningSoft: '#FAF0DC',
    overlay: 'rgba(23, 22, 43, 0.45)',
  },
  dark: {
    background: '#0F0E1A',
    surface: '#1B1A2C',
    surfaceAlt: '#242338',
    border: '#312F49',
    text: '#F2F1FA',
    textSecondary: '#B3B1CC',
    textTertiary: '#807EA0',
    primary: '#8F84F2',
    onPrimary: '#14122A',
    primarySoft: '#2B2847',
    danger: '#E06C6C',
    dangerSoft: '#3A2230',
    success: '#4EC28F',
    successSoft: '#1E3530',
    warning: '#E0A83E',
    warningSoft: '#3A3122',
    overlay: 'rgba(0, 0, 0, 0.55)',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light;
export type ThemePalette = Record<ThemeColor, string>;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const MaxContentWidth = 800;
