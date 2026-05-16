import { neon } from '@neondatabase/serverless';

async function migrate() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = neon(url);

  console.log('Running migration: create race_analyses table...');

  await sql`
    CREATE TABLE IF NOT EXISTS race_analyses (
      race_id       TEXT PRIMARY KEY,
      track_code    TEXT NOT NULL,
      race_number   INTEGER NOT NULL,
      post_time_utc TIMESTAMPTZ NOT NULL,
      status        TEXT NOT NULL,
      prob_source   TEXT NOT NULL,
      computed_at   TIMESTAMPTZ NOT NULL,
      data          JSONB NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_race_analyses_track
    ON race_analyses(track_code)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_race_analyses_post_time
    ON race_analyses(post_time_utc)
  `;

  console.log('Creating tracked_tracks table...');

  await sql`
    CREATE TABLE IF NOT EXISTS tracked_tracks (
      track_code TEXT PRIMARY KEY,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    INSERT INTO tracked_tracks (track_code)
    VALUES ('CD')
    ON CONFLICT (track_code) DO NOTHING
  `;

  console.log('Migration complete.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
