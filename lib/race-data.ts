import type { RaceAnalysis } from './types';
import { getRace, listRaces } from './store';
import { getRaceFromDb, listRacesFromDb } from './db';

/**
 * Get a race from the in-memory store (scraper mode) or the DB (viewer mode).
 */
export async function getRaceAny(raceId: string): Promise<RaceAnalysis | null> {
  const mem = getRace(raceId);
  if (mem) return mem;
  return getRaceFromDb(raceId);
}

/**
 * List all recent races from the in-memory store (scraper mode) or the DB (viewer mode).
 */
export async function listRacesAny(): Promise<RaceAnalysis[]> {
  const mem = listRaces();
  if (mem.length > 0) return mem;
  return listRacesFromDb();
}
