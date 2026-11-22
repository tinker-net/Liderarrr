import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { confirmar } from '../avisos.jsx';

export default function LibrarySyncSettings() {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () =>
      api.librarySyncStatus()
        .then((i) => {
          setInfo(i);
          setErr(null);
        })
        .catch((e) => setErr(e.message)),
    []
  );
  useEffect(() => {
    load();
  }, [load]);

  const running = !!info?.status?.running;
  useEffect(() => {
    const t = setInterval(load, running ? 2000 : 10_000);
    return () => clearInterval(t);
  }, [running, load]);

  const confirmRemoval = async (blocked) => {
    const accepted = await confirmar(
      `¿Retirar de la biblioteca las fichas de ${blocked.count} álbumes que ya no están en disco?`,
      { aceptar: 'Retirar fichas', peligro: true }
    );
    if (!accepted) return;
    try {
      await api.confirmMissingAlbums(blocked.confirmation);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  if (err && !info) return <div className="mt-3 text-sm text-red-400">Álbumes desaparecidos: {err}</div>;
  if (!info) return null;

  const last = info.last;
  const blocked = !running && last?.blocked;
  const fmtDate = (ms) => new Date(ms).toLocaleString('es');

  return (
    <div className="mt-3 border-t border-ink-800 pt-3">
      <h3 className="text-sm text-neutral-300">Álbumes desaparecidos</h3>
      <p className="text-xs text-neutral-500 mt-0.5">
        «Identificar y sincronizar» y el refresco nocturno comprueban si faltan álbumes en disco.
        Aquí puedes ver el resultado y confirmar las bajas grandes.
      </p>

      {running && (
        <p role="status" className="mt-2 text-xs text-neutral-400">
          Comprobando álbumes desaparecidos…
        </p>
      )}
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}

      {last && !running && (
        <p className="text-xs text-neutral-500 mt-3">
          Última pasada: {fmtDate(last.at)} ({last.trigger === 'watch' ? 'cambio en disco' : last.trigger === 'nightly' ? 'nocturna' : last.trigger === 'auto' ? 'automática' : 'manual'}) ·{' '}
          {last.removed > 0
            ? `${last.removed.toLocaleString('es')} ${last.removed === 1 ? 'álbum quitado' : 'álbumes quitados'} de la base (${last.removedTracks.toLocaleString('es')} pistas)`
            : 'nada que quitar'}
          {last.error || last.scanError ? ` · error: ${last.error || last.scanError}` : ''}
        </p>
      )}
      {!last && <p className="text-xs text-neutral-600 mt-3">Todavía no se ha hecho ninguna pasada.</p>}

      {last?.removed > 0 && last.removedSample?.length > 0 && !running && (
        <details className="mt-2 text-xs text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">Ver cuáles</summary>
          <ul className="mt-1 space-y-0.5">
            {last.removedSample.map((s, i) => (
              <li key={i} className="truncate">{s}</li>
            ))}
            {last.removed > last.removedSample.length && <li>…y {last.removed - last.removedSample.length} más</li>}
          </ul>
        </details>
      )}

      {last?.skippedRoots?.length > 0 && !running && (
        <p className="text-xs text-amber-400/80 mt-2">
          No se pudo leer la carpeta de música ({last.skippedRoots.join(', ')}): se ha omitido para no borrar nada por error.
        </p>
      )}

      {blocked && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <div className="flex items-start gap-2 text-amber-300">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div className="min-w-0">
              {last.blocked.changedSinceConfirmation
                ? 'La lista de bajas cambió desde la última confirmación. Revisa la lista actual.'
                : 'Pasada detenida por seguridad. Comprueba que tu música está accesible.'}{' '}
              {last.blocked.count.toLocaleString('es')} de {last.blocked.evaluated.toLocaleString('es')} álbumes
              parecen haber desaparecido. Si los has quitado a propósito, confirma la retirada de sus fichas.
              <ul className="mt-1.5 text-xs text-amber-200/70 space-y-0.5">
                {last.blocked.sample.map((s, i) => (
                  <li key={i} className="truncate">{s}</li>
                ))}
                {last.blocked.count > last.blocked.sample.length && <li>…y más</li>}
              </ul>
              <button
                onClick={() => confirmRemoval(last.blocked)}
                className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-amber-500/50 text-amber-200 hover:bg-amber-500/20"
              >
                Quitarlos de la base igualmente
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
