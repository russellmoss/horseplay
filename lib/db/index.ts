import { neon } from '@neondatabase/serverless';
import type { RaceAnalysis } from '../types';

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return neon(url, { fetchOptions: { cache: 'no-store' } });
}

export async function upsertRaceToDb(analysis: RaceAnalysis): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO race_analyses (
      race_id, track_code, race_number, post_time_utc,
      status, prob_source, computed_at, data, updated_at
    ) VALUES (
      ${analysis.race.raceId},
      ${analysis.race.trackCode},
      ${analysis.race.raceNumber},
      ${analysis.race.postTimeUtc},
      ${analysis.race.status},
      ${analysis.probSource},
      ${analysis.computedAt},
      ${JSON.stringify(analysis)}::jsonb,
      NOW()
    )
    ON CONFLICT (race_id) DO UPDATE SET
      status = EXCLUDED.status,
      prob_source = EXCLUDED.prob_source,
      computed_at = EXCLUDED.computed_at,
      data = EXCLUDED.data,
      updated_at = NOW()
  `;
}

export async function listRacesFromDb(): Promise<RaceAnalysis[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT data FROM race_analyses
    WHERE post_time_utc >= NOW() - INTERVAL '24 hours'
    ORDER BY post_time_utc ASC
  `;
  return rows.map((r) => r.data as RaceAnalysis);
}

export async function getRaceFromDb(raceId: string): Promise<RaceAnalysis | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT data FROM race_analyses WHERE race_id = ${raceId} LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0].data as RaceAnalysis;
}

// ── Tracked tracks ──────────────────────────────────────────────

export async function listTrackedTracks(): Promise<string[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT track_code FROM tracked_tracks ORDER BY added_at ASC
  `;
  return rows.map((r) => r.track_code as string);
}

export async function addTrackedTrack(trackCode: string): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO tracked_tracks (track_code)
    VALUES (${trackCode.toUpperCase()})
    ON CONFLICT (track_code) DO NOTHING
  `;
}

export async function removeTrackedTrack(trackCode: string): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM tracked_tracks WHERE track_code = ${trackCode.toUpperCase()}
  `;
}

export async function countTrackedTracks(): Promise<number> {
  const sql = getSql();
  const rows = await sql`SELECT COUNT(*)::int AS cnt FROM tracked_tracks`;
  return (rows[0].cnt as number) ?? 0;
}
