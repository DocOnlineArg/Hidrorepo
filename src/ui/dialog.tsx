/**
 * Diálogos dentro de la página (confirmar, avisar, pedir texto, exportar).
 * Sustituyen a confirm/alert/prompt y a las descargas, que algunos visores
 * embebidos bloquean.
 */
import { useEffect, useRef, useState } from 'react';

type DialogReq =
  | { kind: 'confirm'; message: string; okText: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'alert'; message: string; resolve: () => void }
  | { kind: 'prompt'; message: string; resolve: (v: string | null) => void }
  | { kind: 'export'; filename: string; text: string; type: string; resolve: () => void };

/** En la versión publicada el visor no permite descargas: solo se ofrece copiar. */
const PUBLISHED = import.meta.env.VITE_PUBLISHED === '1';

let current: DialogReq | null = null;
const listeners = new Set<() => void>();
const set = (d: DialogReq | null) => {
  current = d;
  listeners.forEach((l) => l());
};

export function askConfirm(message: string, opts: { okText?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => set({ kind: 'confirm', message, okText: opts.okText ?? 'Continuar', danger: !!opts.danger, resolve }));
}
export function showMessage(message: string): Promise<void> {
  return new Promise((resolve) => set({ kind: 'alert', message, resolve }));
}
export function askText(message: string): Promise<string | null> {
  return new Promise((resolve) => set({ kind: 'prompt', message, resolve }));
}
/** Muestra el contenido para copiarlo y ofrece la descarga si el entorno la permite. */
export function exportText(filename: string, text: string, type = 'application/json'): Promise<void> {
  return new Promise((resolve) => set({ kind: 'export', filename, text, type, resolve }));
}

export function DialogHost() {
  const [, force] = useState(0);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const l = () => {
      setText('');
      setCopied(false);
      force((x) => x + 1);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const d = current;
  if (!d) return null;
  const close = () => set(null);
  const cancel = () => {
    if (d.kind === 'confirm') d.resolve(false);
    else if (d.kind === 'prompt') d.resolve(null);
    else d.resolve();
    close();
  };
  return (
    <div className="dialog-backdrop" onClick={cancel} onKeyDown={(e) => e.key === 'Escape' && cancel()}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {d.kind !== 'export' && <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{d.message}</p>}
        {d.kind === 'prompt' && (
          <input id="dialog-text" type="text" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && (d.resolve(text.trim()), close())} />
        )}
        {d.kind === 'export' && (
          <>
            <h3>{d.filename}</h3>
            <textarea id="dialog-export" ref={ref} readOnly value={d.text} rows={12} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: '0.75rem' }} />
          </>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {d.kind === 'export' && (
            <>
              <button
                className="btn"
                onClick={() => {
                  navigator.clipboard?.writeText(d.text).then(
                    () => setCopied(true),
                    () => ref.current?.select(),
                  ) ?? ref.current?.select();
                }}
              >
                {copied ? 'Copiado' : 'Copiar'}
              </button>
              {!PUBLISHED && <button
                className="btn"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([d.text], { type: d.type }));
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = d.filename;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Descargar
              </button>}
            </>
          )}
          {(d.kind === 'confirm' || d.kind === 'prompt') && (
            <button className="btn" onClick={cancel}>
              Cancelar
            </button>
          )}
          <button
            className={`btn ${d.kind === 'confirm' && d.danger ? 'danger' : 'primary'}`}
            autoFocus={d.kind !== 'prompt'}
            disabled={d.kind === 'prompt' && !text.trim()}
            onClick={() => {
              if (d.kind === 'confirm') d.resolve(true);
              else if (d.kind === 'prompt') d.resolve(text.trim());
              else d.resolve();
              close();
            }}
          >
            {d.kind === 'confirm' ? d.okText : d.kind === 'prompt' ? 'Aceptar' : 'Cerrar'}
          </button>
        </div>
      </div>
    </div>
  );
}
