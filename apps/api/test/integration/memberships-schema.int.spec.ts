import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
let seq = 0;

async function insertUser(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  const cols = { id, email, first_name: 'Awa', last_name: 'Diop', password_hash: HASH, ...extra };
  const keys = Object.keys(cols);
  await app.query(`insert into app.users (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
  return id;
}

async function insertClass(name: string, status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE'): Promise<string> {
  const id = uuidv7();
  await app.query(`insert into app.classes (id, name, level, academic_year) values ($1, $2, 'L3', '2026-2027')`, [id, name]);
  if (status === 'ARCHIVED') await asOwner((owner) => owner.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [id]));
  return id;
}

async function asOwner<T>(fn: (owner: pg.Client) => Promise<T>): Promise<T> {
  const owner = await connectAs('cp_owner', db);
  try { return await fn(owner); } finally { await owner.end(); }
}

async function insertMembership(userId: string, classId: string, role: 'STUDENT' | 'DELEGATE' = 'STUDENT'): Promise<string> {
  const id = uuidv7();
  await app.query(
    `insert into app.class_memberships (id, user_id, class_id, role) values ($1, $2, $3, $4)`,
    [id, userId, classId, role],
  );
  return id;
}

async function insertEnrollment(userId: string, classId: string): Promise<string> {
  const id = uuidv7();
  await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [id, userId, classId]);
  return id;
}

describe('class_memberships (§ 2.2)', () => {
  it('insère une appartenance active avec les valeurs par défaut', async () => {
    const u = await insertUser('m1@example.com');
    const c = await insertClass(`M${++seq}`);
    const id = await insertMembership(u, c);
    const r = await app.query(
      `select role, left_at, left_reason, joined_at > now() - interval '1 minute' as joined_recently from app.class_memberships where id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ role: 'STUDENT', left_at: null, left_reason: null, joined_recently: true });
  });

  it('une seule appartenance active par utilisateur ; la clôture libère la place', async () => {
    const u = await insertUser('m2@example.com');
    const c1 = await insertClass(`M${++seq}`);
    const c2 = await insertClass(`M${++seq}`);
    const first = await insertMembership(u, c1);
    await expect(insertMembership(u, c2)).rejects.toMatchObject({ code: '23505', constraint: 'membership_one_active' });
    await app.query(`update app.class_memberships set left_at = now(), left_reason = 'TRANSFER' where id = $1`, [first]);
    await insertMembership(u, c2);
  });

  it('clôture : date et motif toujours ensemble', async () => {
    const u = await insertUser('m3@example.com');
    const c = await insertClass(`M${++seq}`);
    const id = await insertMembership(u, c);
    await expect(app.query(`update app.class_memberships set left_at = now() where id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'membership_departure' });
    await expect(app.query(`update app.class_memberships set left_reason = 'REMOVED' where id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'membership_departure' });
    await app.query(`update app.class_memberships set left_at = now(), left_reason = 'REMOVED' where id = $1`, [id]);
  });

  it('note de départ : de 1 à 500 caractères, et seulement avec une clôture', async () => {
    const u = await insertUser('m4@example.com');
    const c = await insertClass(`M${++seq}`);
    const id = await insertMembership(u, c);
    await expect(app.query(`update app.class_memberships set left_note = 'sans clôture' where id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'membership_departure' });
    await expect(app.query(`update app.class_memberships set left_at = now(), left_reason = 'REMOVED', left_note = '' where id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'membership_note_len' });
    await expect(app.query(`update app.class_memberships set left_at = now(), left_reason = 'REMOVED', left_note = $2 where id = $1`, [id, 'x'.repeat(501)]))
      .rejects.toMatchObject({ code: '23514', constraint: 'membership_note_len' });
    await app.query(`update app.class_memberships set left_at = now(), left_reason = 'REMOVED', left_note = $2 where id = $1`, [id, 'x'.repeat(500)]);
  });

  it('refuse une appartenance dans une classe archivée', async () => {
    const u = await insertUser('m5@example.com');
    const c = await insertClass(`M${++seq}`, 'ARCHIVED');
    await expect(insertMembership(u, c)).rejects.toMatchObject({ code: '23514', message: 'membership: class is not active' });
  });

  it.each([
    { label: 'un compte suspendu', extra: { status: 'SUSPENDED' } },
    { label: 'un administrateur', extra: { global_role: 'ADMIN' } },
  ])('refuse une appartenance de $label', async ({ extra }) => {
    const u = await insertUser(`m6${seq++}@example.com`, extra);
    const c = await insertClass(`M${++seq}`);
    await expect(insertMembership(u, c)).rejects.toMatchObject({ code: '23514', message: 'membership: user cannot join' });
  });
});

describe('délégués : déclencheur membership_delegate_limit (§ 0.2, R8)', () => {
  it('jusqu’à deux délégués par classe, limite suivie par classe', async () => {
    const c1 = await insertClass(`M${++seq}`);
    const c2 = await insertClass(`M${++seq}`);
    const members = await Promise.all([1, 2, 3, 4].map((i) => insertUser(`d${seq}u${i}@example.com`)));
    const m = await Promise.all(members.slice(0, 3).map((u) => insertMembership(u, c1)));
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[0]]);
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[1]]);
    await expect(app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[2]]))
      .rejects.toMatchObject({ code: '23514', message: 'membership: delegate limit reached' });
    // La limite vaut par classe : une autre classe nomme ses propres délégués.
    const other = await insertMembership(members[3]!, c2);
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [other]);
  });

  it('la limite suit max_delegates ; une révocation libère une place', async () => {
    const c = await insertClass(`M${++seq}`);
    const members = await Promise.all([1, 2, 3, 4].map((i) => insertUser(`e${seq}u${i}@example.com`)));
    const m = await Promise.all(members.map((u) => insertMembership(u, c)));
    await asOwner((owner) => owner.query(`update app.classes set max_delegates = 3 where id = $1`, [c]));
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[0]]);
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[1]]);
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[2]]);
    await app.query(`update app.class_memberships set role = 'STUDENT' where id = $1`, [m[0]]);
    await app.query(`update app.class_memberships set role = 'DELEGATE' where id = $1`, [m[3]]);
  });

  it('cp_app ne peut pas changer max_delegates (aucun droit accordé)', async () => {
    const c = await insertClass(`M${++seq}`);
    await expect(app.query(`update app.classes set max_delegates = 5 where id = $1`, [c])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('subjects (§ 2.2)', () => {
  it('une matière par classe, unicité insensible à la casse', async () => {
    const c1 = await insertClass(`M${++seq}`);
    const c2 = await insertClass(`M${++seq}`);
    const id = uuidv7();
    await app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Algorithmique')`, [id, c1]);
    await expect(app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'ALGORITHMIQUE')`, [uuidv7(), c1]))
      .rejects.toMatchObject({ code: '23505', constraint: 'subjects_one_name_per_class' });
    await app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Algorithmique')`, [uuidv7(), c2]);
  });

  it('nom de 2 à 60 caractères', async () => {
    const c = await insertClass(`M${++seq}`);
    await expect(app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'a')`, [uuidv7(), c]))
      .rejects.toMatchObject({ code: '23514', constraint: 'subjects_name_len' });
    await expect(app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, $3)`, [uuidv7(), c, 'x'.repeat(61)]))
      .rejects.toMatchObject({ code: '23514', constraint: 'subjects_name_len' });
    await app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, $3)`, [uuidv7(), c, 'x'.repeat(60)]);
  });

  it('refuse une matière dans une classe archivée', async () => {
    const c = await insertClass(`M${++seq}`, 'ARCHIVED');
    await expect(app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Russes')`, [uuidv7(), c]))
      .rejects.toMatchObject({ code: '23514', message: 'subjects: class is not active' });
  });
});

describe('enrollment complété (§ 0.3, R9)', () => {
  it('refuse une demande d’une personne déjà membre ; l’accepte après clôture', async () => {
    const c = await insertClass(`M${++seq}`);
    const u = await insertUser('r1@example.com');
    const m = await insertMembership(u, c);
    await expect(insertEnrollment(u, c)).rejects.toMatchObject({ code: '23514', message: 'enrollment: user is already a member' });
    await app.query(`update app.class_memberships set left_at = now(), left_reason = 'REMOVED' where id = $1`, [m]);
    await insertEnrollment(u, c);
  });
});

describe('droits de cp_app (§ 2.2)', () => {
  it('écrit les appartenances et les matières, mais ne supprime aucune ligne', async () => {
    const c = await insertClass(`M${++seq}`);
    const u = await insertUser('p1@example.com');
    const m = await insertMembership(u, c);
    const s = uuidv7();
    await app.query(`insert into app.subjects (id, class_id, name) values ($1, $2, 'Physique')`, [s, c]);
    await expect(app.query('delete from app.class_memberships where id = $1', [m])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('delete from app.subjects where id = $1', [s])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('delete from app.users where id = $1', [u])).rejects.toMatchObject({ code: '42501' });
  });
});
