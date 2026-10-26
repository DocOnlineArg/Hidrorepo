import { useEffect, useState, type ReactNode } from 'react';
import type { Quality, SensorStatus, Severity } from '../../core/types';
import { formatSimTime } from '../../core/util';

export function Card({ title, extra, children, tone }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; tone?: 'alert' | 'warnb' }) {
  return (
    <section className={`card ${tone ?? ''}`}>
      {(title || extra) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {extra && <div className="row">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | '';

export function Chip({ tone = '', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

export const STATUS_LABEL: Record<SensorStatus, string> = {
  ok: 'Conectado',
  disconnected: 'Desconectado',
  fault: 'Fallo',
  out_of_range: 'Fuera de rango',
  stale: 'Sin datos recientes',
  uncalibrated: 'Sin calibración',
  suspect: 'Sospechoso',
};

export function statusTone(s: SensorStatus): Tone {
  return s === 'ok' ? 'ok' : s === 'uncalibrated' || s === 'suspect' ? 'warn' : 'bad';
}

export const QUALITY_LABEL: Record<Quality, string> = { good: 'Buena', uncertain: 'Incierta', bad: 'Inválida' };

export function severityTone(s: Severity): Tone {
  return s === 'critical' ? 'bad' : s === 'warning' ? 'warn' : 'info';
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Crítica', warning: 'Aviso', info: 'Info' };

/** Entrada numérica que confirma al salir o con Enter; admite vacío (= null). */
export function NumInput({
  value,
  onCommit,
  step = 'any',
  min,
  max,
  allowNull = false,
  width,
  disabled,
  ariaLabel,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  step?: number | 'any';
  min?: number;
  max?: number;
  allowNull?: boolean;
  width?: number;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === null ? '' : String(+value.toFixed(6)));
  }, [value, focused]);
  const parsed = text.trim() === '' ? null : Number(text.replace(',', '.'));
  const invalid =
    (parsed === null && !allowNull) ||
    (parsed !== null && (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)));
  const commit = () => {
    setFocused(false);
    if (invalid) {
      setText(value === null ? '' : String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      className={invalid ? 'invalid' : ''}
      style={width ? { width } : undefined}
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={allowNull ? 'sin configurar' : ''}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function TextInput({ value, onCommit, placeholder, width, pattern }: { value: string | null; onCommit: (v: string | null) => void; placeholder?: string; width?: number; pattern?: RegExp }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const invalid = pattern ? text !== '' && !pattern.test(text) : false;
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      className={invalid ? 'invalid' : ''}
      style={width ? { width } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (invalid) return setText(value ?? '');
        const v = text.trim() === '' ? null : text.trim();
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function Field({ label, children, unit }: { label: string; children: ReactNode; unit?: string }) {
  return (
    <label className="field">
      {label}
      <span className="inline">
        {children}
        {unit && <small>{unit}</small>}
      </span>
    </label>
  );
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)} aria-pressed={o.value === value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Level({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100));
  return (
    <div className="level" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function SimTime({ t }: { t: number | null }) {
  return <span className="mono">{t === null ? '—' : formatSimTime(t)}</span>;
}

export function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem' }}>
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

/** Mensaje temporal tras una acción (p. ej. orden rechazada por seguridad). */
export function useFlash(): [{ ok: boolean; reasons: string[] } | null, (v: { ok: boolean; reasons: string[] } | null) => void] {
  const [msg, setMsg] = useState<{ ok: boolean; reasons: string[] } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 8000);
    return () => clearTimeout(id);
  }, [msg]);
  return [msg, setMsg];
}

export function Flash({ msg, okText = 'Orden aceptada' }: { msg: { ok: boolean; reasons: string[] } | null; okText?: string }) {
  if (!msg) return null;
  return (
    <div className={`note ${msg.ok ? '' : 'bad'}`} role="status">
      {msg.ok ? okText : 'Orden rechazada por la capa de seguridad:'}
      {!msg.ok && <Reasons reasons={msg.reasons} />}
    </div>
  );
}
