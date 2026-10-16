/** Registro histórico de variables en buffers circulares (muestreo periódico). */
export interface Series {
  t: number[];
  v: (number | null)[];
}

export class History {
  series = new Map<string, Series>();
  lastSampleAt: number | null = null;
  constructor(
    public intervalS: number,
    public maxPoints = 8640,
  ) {}

  due(now: number): boolean {
    return this.lastSampleAt === null || now - this.lastSampleAt >= this.intervalS * 1000;
  }

  record(now: number, values: Record<string, number | null>): void {
    this.lastSampleAt = now;
    for (const [k, v] of Object.entries(values)) {
      let s = this.series.get(k);
      if (!s) {
        s = { t: [], v: [] };
        this.series.set(k, s);
      }
      s.t.push(now);
      s.v.push(v);
      if (s.t.length > this.maxPoints) {
        const drop = s.t.length - this.maxPoints;
        s.t.splice(0, drop);
        s.v.splice(0, drop);
      }
    }
  }

  get(key: string): Series {
    return this.series.get(key) ?? { t: [], v: [] };
  }

  /** Valor registrado más cercano (anterior o igual) a `t`. */
  valueAt(key: string, t: number): number | null {
    const s = this.series.get(key);
    if (!s || s.t.length === 0) return null;
    let lo = 0;
    let hi = s.t.length - 1;
    if (t < s.t[0]) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.t[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return s.v[lo];
  }

  range(): { from: number; to: number } | null {
    let from = Infinity;
    let to = -Infinity;
    for (const s of this.series.values()) {
      if (!s.t.length) continue;
      from = Math.min(from, s.t[0]);
      to = Math.max(to, s.t[s.t.length - 1]);
    }
    return isFinite(from) ? { from, to } : null;
  }

  clear(): void {
    this.series.clear();
    this.lastSampleAt = null;
  }
}
