// Axis maths shared by the SVG charts. Plots use a 0..1000 x 0..100 viewBox with
// preserveAspectRatio="none"; labels are HTML positioned by percent, so text never stretches.

export function niceMax(max: number, ticks = 4) {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(candidate => candidate >= raw)!;
  return { top: step * ticks, step };
}

export function ticks(top: number, step: number) {
  const values: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) values.push(value);
  return values;
}

// null marks a missing observation: the line breaks there instead of dropping to zero.
export function linePath(values: (number | null)[], top: number) {
  if (!values.length) return '';
  const dx = values.length > 1 ? 1000 / (values.length - 1) : 0;
  let path = '';
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    path += `${drawing ? 'L' : 'M'}${(index * dx).toFixed(2)},${(100 - (value / top) * 100).toFixed(2)}`;
    drawing = true;
  });
  return path;
}

// A line has no visible segment when both neighboring observations are missing.
export function isolatedPoints(values: (number | null)[]) {
  return values.flatMap((value, index) => value !== null &&
    (values[index - 1] ?? null) === null && (values[index + 1] ?? null) === null
    ? [{ index, value }] : []);
}

// One filled region per run of observed values; gaps stay empty.
export function areaPath(values: (number | null)[], top: number) {
  const dx = values.length > 1 ? 1000 / (values.length - 1) : 0;
  let path = '';
  let start = -1;
  const closeRun = (end: number) => {
    if (start < 0) return;
    const run = values.slice(start, end + 1);
    path += run.map((value, offset) => `${offset ? 'L' : 'M'}${((start + offset) * dx).toFixed(2)},${(100 - ((value ?? 0) / top) * 100).toFixed(2)}`).join('');
    path += `L${(end * dx).toFixed(2)},100L${(start * dx).toFixed(2)},100Z`;
    start = -1;
  };
  values.forEach((value, index) => {
    if (value === null) closeRun(index - 1);
    else if (start < 0) start = index;
  });
  closeRun(values.length - 1);
  return path;
}

// Indices for evenly spaced x-axis labels, always including the first and last point.
export function labelIndices(count: number, wanted = 6) {
  if (count <= wanted) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (wanted - 1);
  return Array.from({ length: wanted }, (_, index) => Math.round(index * step));
}
