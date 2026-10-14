export type ThemeTokens = {
  bg: string; side: string; surface: string; ink: string; muted: string; line: string; line2: string;
  navon: string; brand: string; onbrand: string; brandtx: string; red: string; amb: string; grn: string;
};

export const tokens: { light: ThemeTokens; dark: ThemeTokens } = {
  light: { bg: '#FFF9F4', side: '#FFFFFF', surface: '#FFFFFF', ink: '#2A211C', muted: '#7A6C61', line: '#F0E3D8', line2: '#DFCBBB', navon: '#FCEBE1', brand: '#C2461F', onbrand: '#FFFFFF', brandtx: '#C2461F', red: '#B42318', amb: '#A15C07', grn: '#1E7A46' },
  dark: { bg: '#1A1411', side: '#1F1814', surface: '#241C18', ink: '#F6EDE6', muted: '#B3A398', line: '#382B24', line2: '#54443A', navon: '#33241D', brand: '#E8703F', onbrand: '#1A1411', brandtx: '#F08A5D', red: '#FF8A7A', amb: '#F2C063', grn: '#72D49B' },
};

const vars = (t: ThemeTokens) => Object.entries(t).map(([k, v]) => `  --cp-${k}: ${v};`).join('\n');

export function renderTokensCss(t: typeof tokens): string {
  return [
    '/* Généré par scripts/gen-tokens.ts — ne pas modifier à la main. */',
    `:root {\n${vars(t.light)}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${vars(t.dark).split('\n').map((l) => `  ${l}`).join('\n')}\n    color-scheme: dark;\n  }\n}`,
    `:root[data-theme="dark"] {\n${vars(t.dark)}\n  color-scheme: dark;\n}`,
    'body { margin: 0; background: var(--cp-bg); color: var(--cp-ink); font-family: Figtree, system-ui, sans-serif; font-size: 16px; }',
    '',
  ].join('\n\n');
}
