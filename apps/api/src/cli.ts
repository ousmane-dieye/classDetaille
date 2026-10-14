import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { CliModule } from './cli/cli.module.js';
import { CliError, readPassword } from './cli/read-password.js';
import { loadConfig } from './config/load-config.js';
import { ApiError } from './http/errors.js';
import { ClassesService } from './modules/classes/classes.service.js';
import { UsersService } from './modules/users/users.service.js';

// Lot 1a : pnpm --filter @classepulse/api cli <commande> (tsx --conditions=source). `node dist/src/cli.js`
// ne fonctionnera qu'une fois le paquet partagé construit (lot 7).
const USAGE = 'usage : pnpm --filter @classepulse/api cli create-admin --email <email> --first-name <prénom> --last-name <nom>   (mot de passe sur l’entrée standard)\n'
  + '        pnpm --filter @classepulse/api cli create-class --name <nom> --level <niveau> --year <AAAA-AAAA>\n'
  + '        (lot 1a : `node dist/src/cli.js` n’est utilisable qu’une fois le paquet partagé construit, lot 7)\n';

/** Seule la catégorie de l'erreur est affichée : jamais de message ni de trace (une valeur saisie pourrait y figurer). */
function category(e: unknown): string {
  if (e instanceof ApiError || e instanceof CliError) return e.code;
  if (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) return 'INVALID_ARGUMENTS';
  return 'UNEXPECTED';
}

function required(values: Record<string, string | boolean | undefined>, names: string[]): string[] {
  return names.map((n) => {
    const v = values[n];
    if (typeof v !== 'string' || v.length === 0) throw new CliError('INVALID_ARGUMENTS');
    return v;
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'create-admin' && command !== 'create-class') { process.stderr.write(USAGE); return 2; }
  const ctx = await NestFactory.createApplicationContext(CliModule.forRoot(loadConfig(process.env)), { logger: false });
  try {
    if (command === 'create-admin') {
      const { values } = parseArgs({ args: rest, strict: true, options: { email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' } } });
      const [email, firstName, lastName] = required(values, ['email', 'first-name', 'last-name']);
      const password = await readPassword();
      await ctx.get(UsersService).createFirstAdmin({ kind: 'cli', command }, { email: email!, firstName: firstName!, lastName: lastName!, password });
      process.stdout.write('administrateur créé\n');
    } else {
      const { values } = parseArgs({ args: rest, strict: true, options: { name: { type: 'string' }, level: { type: 'string' }, year: { type: 'string' } } });
      const [name, level, academicYear] = required(values, ['name', 'level', 'year']);
      const id = await ctx.get(ClassesService).create({ kind: 'cli', command }, { name: name!, level: level!, academicYear: academicYear! });
      process.stdout.write(`classe créée : ${id}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`erreur : ${category(e)}\n`);
    return 1;
  } finally {
    await ctx.close();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), () => { process.stderr.write('erreur : UNEXPECTED\n'); process.exit(1); });
