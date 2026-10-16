/** Gráfico temporal SVG ligero (sin dependencias), con bandas de objetivo y límites. */
import type { Series } from '../../core/history';
import { formatSimTime } from '../../core/util';

export interface ChartSeries {
  label: string;
  data: Series;
  color: string;
  dashed?: boolean;
  /** Escalón (para estados ON/OFF). */
  step?: boolean;
  /** Transformación de valores (p. ej. EC a µS/cm). */
  map?: (v: number) => number;
}

export interface ChartProps {
  series: ChartSeries[];
  from: number;
  to: number;
  unit?: string;
  band?: { lo: number; hi: number } | null;
  lines?: { y: number; label: string; tone: 'bad' | 'warn' }[];
  yMin?: number;
  yMax?: number;
  height?: number;
  decimals?: number;
}

const W = 600;
const PAD = { l: 44, r: 8, t: 8, b: 20 };

function niceTicks(lo: number, hi: number, n = 4): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function Chart({ series, from, to, unit = '', band, lines = [], yMin, yMax, height = 170, decimals = 1 }: ChartProps) {
  const H = height;
  const pts = series.map((s) => {
    const out: [number, number][] = [];
    const { t, v } = s.data;
    let i0 = 0;
    while (i0 < t.length && t[i0] < from) i0++;
    const n = t.length - i0;
    const stride = Math.max(1, Math.floor(n / 400));
    for (let i = i0; i < t.length; i += stride) {
      const val = v[i];
      if (val === null || !Number.isFinite(val)) out.push([t[i], NaN]);
      else out.push([t[i], s.map ? s.map(val) : val]);
    }
    return out;
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) for (const [, y] of p) if (Number.isFinite(y)) {
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  if (band) {
    lo = Math.min(lo, band.lo);
    hi = Math.max(hi, band.hi);
  }
  for (const l of lines) {
    lo = Math.min(lo, l.y);
    hi = Math.max(hi, l.y);
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (yMin !== undefined) lo = yMin;
  if (yMax !== undefined) hi = yMax;
  if (hi - lo < 1e-6) {
    hi += 0.5;
    lo -= 0.5;
  }
  const padY = (hi - lo) * 0.08;
  lo -= yMin === undefined ? padY : 0;
  hi += yMax === undefined ? padY : 0;
  const span = Math.max(1, to - from);
  const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = niceTicks(lo, hi);
  const xticks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * span);

  const path = (p: [number, number][], step?: boolean) => {
    let d = '';
    let pen = false;
    let prevY = 0;
    for (const [t, v] of p) {
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const X = x(t).toFixed(1);
      const Y = y(v).toFixed(1);
      if (!pen) d += `M${X},${Y}`;
      else if (step) d += `H${X}V${Y}`;
      else d += `L${X},${Y}`;
      pen = true;
      prevY = v;
    }
    void prevY;
    return d;
  };

  const empty = pts.every((p) => p.length === 0);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Gráfico ${series.map((s) => s.label).join(', ')}`}>
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(tv)} y2={y(tv)} stroke="var(--chart-grid)" />
            <text x={PAD.l - 4} y={y(tv) + 3} fontSize="10" textAnchor="end" fill="var(--muted)">
              {tv.toFixed(Math.max(0, decimals))}
            </text>
          </g>
        ))}
        {xticks.map((tv, i) => (
          <text key={i} x={x(tv)} y={H - 5} fontSize="10" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fill="var(--muted)">
            {formatSimTime(tv, false).slice(0, 5)}
          </text>
        ))}
        {band && <rect x={PAD.l} width={W - PAD.l - PAD.r} y={y(band.hi)} height={Math.max(0, y(band.lo) - y(band.hi))} fill="var(--ok)" opacity={0.12} />}
        {lines.map((l, i) => (
          <line key={i} x1={PAD.l} x2={W - PAD.r} y1={y(l.y)} y2={y(l.y)} stroke={`var(--${l.tone})`} strokeDasharray="4 3" opacity={0.8}>
            <title>{l.label}</title>
          </line>
        ))}
        {pts.map((p, i) => (
          <path
            key={i}
            d={path(p, series[i].step)}
            fill="none"
            stroke={series[i].color}
            strokeWidth={series[i].dashed ? 1.2 : 1.8}
            strokeDasharray={series[i].dashed ? '5 4' : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {empty && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--muted)" fontSize="12">
            Sin datos en el intervalo
          </text>
        )}
        <text x={PAD.l + 4} y={PAD.t + 10} fontSize="10" fill="var(--muted)">
          {unit}
        </text>
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.label} className={s.dashed ? 'dashed' : ''} style={{ ['--c' as string]: s.color }}>
            {s.label}
          </span>
        ))}
        {band && <span style={{ ['--c' as string]: 'var(--ok)' }}>banda objetivo</span>}
      </div>
    </div>
  );
}
