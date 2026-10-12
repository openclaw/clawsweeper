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

export function linePath(values: number[], top: number) {
  if (!values.length) return '';
  const dx = values.length > 1 ? 1000 / (values.length - 1) : 0;
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index * dx).toFixed(2)},${(100 - (value / top) * 100).toFixed(2)}`).join('');
}

export function areaPath(values: number[], top: number) {
  const line = linePath(values, top);
  return line ? `${line}L1000,100L0,100Z` : '';
}

// Indices for evenly spaced x-axis labels, always including the first and last point.
export function labelIndices(count: number, wanted = 6) {
  if (count <= wanted) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (wanted - 1);
  return Array.from({ length: wanted }, (_, index) => Math.round(index * step));
}
