import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTokensCss, tokens } from '../src/theme/tokens';

writeFileSync(resolve(import.meta.dirname, '../src/theme/tokens.css'), renderTokensCss(tokens));
