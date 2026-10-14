type RunDay = { date: string; total: number; success: number };
type TimingDay = { date: string; reviewP50: number | null; reviewP90: number | null };

// Keep missing calendar days on the axis so a sparse archive cannot join
// observations across a gap or pull older samples into the requested window.
export function reviewTimingWindow(days: TimingDay[], asOf: string, length: number): TimingDay[] {
  const end = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const byDate = new Map(days.map(day => [day.date, day]));
  return Array.from({ length }, (_, index) => {
    const date = new Date(end - (length - index) * 86_400_000).toISOString().slice(0, 10);
    const sample = byDate.get(date);
    return { date, reviewP50: sample?.reviewP50 ?? null, reviewP90: sample?.reviewP90 ?? null };
  });
}

// Only complete UTC days belong in a comparison. Missing history is not a day
// with zero failures, and a partial window cannot establish a period delta.
export function summarizeRunWindow(days: RunDay[], asOf: string, length: number, offset = 0) {
  const end = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - offset * 86_400_000;
  const start = end - length * 86_400_000;
  const selected = days.filter((day) => {
    const time = Date.parse(`${day.date}T00:00:00Z`);
    return time >= start && time < end;
  });
  const total = selected.reduce((sum, day) => sum + day.total, 0);
  const success = selected.reduce((sum, day) => sum + day.success, 0);
  return {
    total,
    success,
    recordedDays: new Set(selected.map((day) => day.date)).size,
    requestedDays: length,
    rate: total ? success / total : null,
  };
}
