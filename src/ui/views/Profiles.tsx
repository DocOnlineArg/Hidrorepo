import { useState } from 'react';
import { useEngine } from '../context';
import { Card, Chip, NumInput, Reasons, TextInput } from '../components/common';
import type { ProfileId } from '../../core/types';
import { PROFILE_FIELDS, diffProfiles, profileProblems } from '../../core/profiles';
import { ecFromDisplay, ecToDisplay, formatSimTime } from '../../core/util';

const IDS: ProfileId[] = ['veg', 'flower'];

export function ProfilesView() {
  const { engine: e } = useEngine();
  const [switched, setSwitched] = useState<{ label: string; a: unknown; b: unknown }[] | null>(null);
  const [problems, setProblems] = useState<Record<ProfileId, string[]>>({ veg: [], flower: [] });
  const P = e.config.profiles;
  const diffs = new Set(diffProfiles(P.veg, P.flower).map((d) => d.path));
  const ecU = e.config.ecDisplayUnit;
  const isEc = (path: string) => path.startsWith('reservoir.ec.');

  const renderInput = (id: ProfileId, path: string, unit: string) => {
    const f = PROFILE_FIELDS.find((x) => x.path === path)!;
    const v = f.get(P[id]);
    if (typeof v === 'boolean') return <input type="checkbox" checked={v} aria-label={`${f.label} ${id}`} onChange={(ev) => e.updateProfile(id, path, ev.target.checked)} />;
    if (unit === 'HH:MM') return <TextInput value={v as string | null} placeholder="HH:MM" pattern={/^\d{1,2}:\d{2}$/} width={80} onCommit={(nv) => e.updateProfile(id, path, nv)} />;
    const num = v as number | null;
    return (
      <NumInput
        value={num === null ? null : isEc(path) ? ecToDisplay(num, ecU) : num}
        allowNull
        width={90}
        ariaLabel={`${f.label} ${id}`}
        onCommit={(nv) => e.updateProfile(id, path, nv === null ? null : isEc(path) ? ecFromDisplay(nv, ecU) : nv)}
      />
    );
  };

  return (
    <>
      <div className="section-title">
        <h2>Perfiles ambientales</h2>
        <small>Activo: {e.profile.name}</small>
      </div>
      <p className="note warn">
        No se proporcionan valores agronómicos por defecto: todos los objetivos empiezan sin configurar. Introduzca los valores de su cultivo y productos y valide el perfil. Cualquier edición invalida el perfil hasta volver a validarlo. Cambiar de perfil actualiza las reglas sin borrar el historial.
      </p>
      <div className="grid wide">
        {IDS.map((id) => {
          const p = P[id];
          const probs = profileProblems(p);
          return (
            <Card
              key={id}
              title={
                <div>
                  <h3>{p.name}</h3>
                  <div className="row" style={{ marginTop: 4 }}>
                    <Chip tone={p.validated ? 'ok' : 'warn'}>{p.validated ? `Validado ${p.validatedAt ? formatSimTime(p.validatedAt) : ''}` : 'Sin validar'}</Chip>
                    {p.example && <Chip tone="warn">VALORES DE EJEMPLO</Chip>}
                    {e.config.activeProfile === id && <Chip tone="accent">ACTIVO</Chip>}
                  </div>
                </div>
              }
              extra={
                <>
                  {!p.validated ? (
                    <button
                      className="btn small primary"
                      onClick={() => {
                        const v = e.validateProfile(id);
                        setProblems((x) => ({ ...x, [id]: v.reasons }));
                      }}
                    >
                      Validar
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => e.invalidateProfile(id)}>
                      Retirar validación
                    </button>
                  )}
                  <button className="btn small" disabled={e.config.activeProfile === id} onClick={() => setSwitched(e.setActiveProfile(id))}>
                    Activar
                  </button>
                </>
              }
            >
              <small>{probs.length === 0 ? 'Configuración completa y coherente.' : `${probs.length} problema(s) pendientes para validar.`}</small>
              {problems[id].length > 0 && !p.validated && <Reasons reasons={problems[id]} />}
            </Card>
          );
        })}
      </div>
      {switched && (
        <Card title="Cambio de perfil aplicado" extra={<button className="btn small" onClick={() => setSwitched(null)}>Cerrar</button>}>
          {switched.length === 0 ? (
            <small>Los perfiles son idénticos.</small>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
              {switched.map((d) => (
                <li key={d.label}>
                  {d.label}: <strong>{String(d.a ?? '—')}</strong> → <strong>{String(d.b ?? '—')}</strong>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <Card title={`Editor y comparación (${diffs.size} parámetros distintos)`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Parámetro</th>
                <th>Unidad</th>
                <th>{P.veg.name}</th>
                <th>{P.flower.name}</th>
              </tr>
            </thead>
            <tbody>
              {PROFILE_FIELDS.map((f) => (
                <tr key={f.path} className={diffs.has(f.path) ? 'diff' : ''}>
                  <td>{f.label}</td>
                  <td>
                    <small>{isEc(f.path) ? ecU : f.unit}</small>
                  </td>
                  <td>{renderInput('veg', f.path, f.unit)}</td>
                  <td>{renderInput('flower', f.path, f.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <small>Las filas resaltadas cambian al pasar de un perfil al otro. Vacío = sin configurar.</small>
      </Card>
    </>
  );
}
