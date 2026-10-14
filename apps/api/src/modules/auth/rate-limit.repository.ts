import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/** Seaux à fenêtre fixe (§ 2.2). Toutes les durées sont calculées par l'horloge de la base. */
@Injectable()
export class RateLimitRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Compte une tentative sur le seau de l'IP ; la fenêtre repart si elle est échue. */
  async hit(key: string, windowSeconds: number): Promise<{ attempts: number; resetIn: number }> {
    const r = await this.prisma.client.$queryRaw<{ attempts: number; reset_in: number }[]>`
      insert into app.rate_limit_buckets as b (key, window_start, attempts) values (${key}, clock_timestamp(), 1)
      on conflict (key) do update set
        attempts = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 1 else b.attempts + 1 end,
        failures = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 0 else b.failures end,
        window_start = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then clock_timestamp() else b.window_start end
      returning attempts,
        greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}::double precision) - clock_timestamp()))))::int as reset_in`;
    return { attempts: r[0]!.attempts, resetIn: r[0]!.reset_in };
  }

  async readFailures(key: string, windowSeconds: number): Promise<{ failures: number; sinceLastMs: number; resetIn: number } | null> {
    const r = await this.prisma.client.$queryRaw<{ failures: number; since_ms: number; reset_in: number }[]>`
      select failures,
             coalesce((extract(epoch from (clock_timestamp() - last_failure_at)) * 1000)::int, 2147483647) as since_ms,
             greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}::double precision) - clock_timestamp()))))::int as reset_in
        from app.rate_limit_buckets
       where key = ${key} and window_start > clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision)`;
    const row = r[0];
    return row ? { failures: row.failures, sinceLastMs: row.since_ms, resetIn: row.reset_in } : null;
  }

  async addIpFailure(key: string): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ failures: number }[]>`
      update app.rate_limit_buckets set failures = failures + 1 where key = ${key} returning failures`;
    return r[0]?.failures ?? 0;
  }

  /**
   * Réserve atomiquement une tentative sur le seau IP + compte : elle compte comme un échec dès cet instant
   * (recordSuccess efface le seau). La ligne n'est mise à jour que si la limite n'est pas atteinte et que le délai
   * croissant (R5) est écoulé ; le verrou de ligne sérialise les tentatives parallèles. Retourne le nombre d'échecs
   * après réservation, ou null si la tentative est refusée.
   */
  async reserveAccountAttempt(key: string, windowSeconds: number, limit: number): Promise<number | null> {
    const r = await this.prisma.client.$queryRaw<{ failures: number }[]>`
      insert into app.rate_limit_buckets as b (key, window_start, failures, last_failure_at) values (${key}, clock_timestamp(), 1, clock_timestamp())
      on conflict (key) do update set
        failures = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 1 else b.failures + 1 end,
        window_start = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then clock_timestamp() else b.window_start end,
        last_failure_at = clock_timestamp()
      where b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision)
         or (b.failures < ${limit}::int
             and (b.last_failure_at is null
                  or clock_timestamp() - b.last_failure_at >= make_interval(secs => case when b.failures <= 0 then 0::double precision else least(power(2, b.failures - 1), 30) end)))
      returning failures`;
    return r[0]?.failures ?? null;
  }

  async clear(key: string): Promise<void> {
    await this.prisma.client.$executeRaw`delete from app.rate_limit_buckets where key = ${key}`;
  }

  /** Compte borné : ne lit jamais plus de `cap` lignes ; les seaux dont la fenêtre est échue ne comptent pas (R14). */
  async rowCountUpTo(cap: number, windowSeconds: number): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from (
        select 1 from app.rate_limit_buckets
         where window_start > clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision)
         limit ${cap}::int) s`;
    return r[0]!.n;
  }
}
