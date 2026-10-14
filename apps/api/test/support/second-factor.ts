import { v7 as uuidv7 } from 'uuid';
import { normalizePassword } from '@classepulse/shared';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { cipher } from './mail.js';
import { PASSWORD } from './app.js';
import { connectAs } from './pg.js';

/** Administrateur actif (insertion sous cp_app, comme la CLI) ; mot de passe = PASSWORD. */
export async function createAdmin(db: string, over: { email?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const id = uuidv7();
  const email = over.email ?? `admin.${id}@example.com`;
  const hash = await new PasswordHasher().hash(normalizePassword(PASSWORD));
  const c = await connectAs('cp_app', db);
  try {
    await c.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,'ADMIN')`, [id, email, hash]);
  } finally { await c.end(); }
  if (over.status === 'SUSPENDED') {
    const o = await connectAs('cp_owner', db); // cp_app ne modifie pas le statut
    await o.query(`update app.users set status = 'SUSPENDED' where id = $1`, [id]);
    await o.end();
  }
  return { id, email, password: PASSWORD };
}

/** Le dernier code en clair mis en file pour une adresse (déchiffré avec la clé de test) : remplace la boîte email. */
export async function latestCode(db: string, to: string, kind = 'ADMIN_OTP'): Promise<string> {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query(`select id, payload_encrypted from app.email_outbox where to_address = $1 and kind = $2::app.email_kind and payload_encrypted is not null order by created_at desc, id desc limit 1`, [to, kind]);
    if (!r.rows[0]) throw new Error(`aucun email ${kind} en attente pour ${to}`);
    return cipher.decrypt(r.rows[0].id, r.rows[0].payload_encrypted).code!;
  } finally { await c.end(); }
}

/** Historique de demandes de code : `count` vérifications consommées, créées il y a `ageMinutes` minutes (cp_owner : created_at n'est pas modifiable par cp_app). */
export async function seedHistory(db: string, userId: string, count: number, ageMinutes: number): Promise<void> {
  const o = await connectAs('cp_owner', db);
  try {
    for (let i = 0; i < count; i++) {
      await o.query(
        `insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at, created_at, consumed_at, consumed_reason)
         values ($1::uuid,$2::uuid,'LOGIN', decode(md5($1::text) || md5($2::text), 'hex'), decode(md5($1::text) || md5($2::text), 'hex'),
                 clock_timestamp() - make_interval(mins => $3::int) + interval '10 minutes', clock_timestamp() - make_interval(mins => $3::int), clock_timestamp() - make_interval(mins => $3::int), 'EXPIRED')`,
        [uuidv7(), userId, ageMinutes]);
    }
  } finally { await o.end(); }
}

/** Vieillit toutes les vérifications d'un compte (une vérification consommée ne se modifie plus : les déclencheurs sont neutralisés pour cette seule préparation de donnée, sous postgres). */
export async function ageChallenges(db: string, userId: string, minutes: number): Promise<void> {
  const p = await connectAs('postgres', db);
  try {
    await p.query('set session_replication_role = replica');
    await p.query(`update app.auth_challenges set created_at = created_at - make_interval(mins => $2::int) where user_id = $1::uuid`, [userId, minutes]);
  } finally { await p.end(); }
}

/** Session d'administrateur valide (second facteur renseigné), insérée sous cp_app ; retourne son identifiant. */
export async function createAdminSession(db: string, userId: string): Promise<string> {
  const id = uuidv7();
  const c = await connectAs('cp_app', db);
  try {
    await c.query(
      `insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, second_factor_at, second_factor_method)
       values ($1::uuid, decode(md5($1::text) || md5($2::text), 'hex'), $2::uuid, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '8 hours', clock_timestamp(), 'EMAIL_CODE')`,
      [id, userId]);
  } finally { await c.end(); }
  return id;
}
