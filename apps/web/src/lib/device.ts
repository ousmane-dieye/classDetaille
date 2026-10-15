type Rule = [RegExp, string];

const BROWSERS: Rule[] = [
  [/\bEdg\//, 'Edge'], // Edge contient la chaîne Chrome : avant, toujours.
  [/\bOPR\/|\bOpera\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: Rule[] = [
  [/\bAndroid\b/, 'Android'],
  [/\biPad\b/, 'iPad'],
  [/\biPhone\b/, 'iPhone'],
  [/\biPod\b/, 'iPod'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(value: string, table: Rule[]): string | null {
  for (const [pattern, name] of table) if (pattern.test(value)) return name;
  return null;
}

/**
 * M14 : « Chrome · Android » dans la liste des sessions. L'objectif n'est pas l'exactitude
 * forensique, seulement que la personne reconnaisse ses propres appareils — et un agent
 * absent ou illisible est dit tel plutôt que deviné.
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Appareil non identifié';
  const browser = firstMatch(userAgent, BROWSERS);
  const system = firstMatch(userAgent, SYSTEMS);
  return `${browser ?? 'Navigateur'} · ${system ?? 'système'}`;
}
