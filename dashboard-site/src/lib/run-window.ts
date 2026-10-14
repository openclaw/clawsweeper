type RunDay = { date: string; total: number; success: number };

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
