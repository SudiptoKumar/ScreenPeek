export async function catalogueCounts(db: D1Database) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN type = 'movie' THEN 1 ELSE 0 END) AS movies,
      SUM(CASE WHEN type = 'tv' THEN 1 ELSE 0 END) AS series
    FROM titles WHERE hidden = 0 AND deleted = 0 AND deleted_at IS NULL
  `).first<{ total: number; movies: number | null; series: number | null }>();
  return { total: row?.total ?? 0, movies: row?.movies ?? 0, series: row?.series ?? 0 };
}
