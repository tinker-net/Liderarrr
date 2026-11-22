import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy } from 'lucide-react';
import { api } from '../api.js';
import { Spinner } from '../components.jsx';

const fmtRate = (hz) => `${(hz / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} kHz`;
const PAGE = 200; // filas por «mostrar más»: miles de enlaces de golpe harían lenta la página

// ───────────────────────────── listados ─────────────────────────────

export default function QualityLists() {
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState(null);
  const [listError, setListError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState('rate:44100');
  const [list, setList] = useState(null); // null = cargando
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.qualityLists()
      .then(setSummary)
      .catch((e) => setErr(e.message));
  }, []);

  const tabs = useMemo(() => {
    if (!summary) return [];
    const counts = new Map(summary.sampleRates.map((r) => [r.rate, r.albums]));
    const main = [44100, 48000].map((hz) => ({
      key: `rate:${hz}`,
      label: fmtRate(hz),
      n: counts.get(hz) || 0,
      kind: 'samplerate',
      rate: hz,
    }));
    const others = summary.sampleRates
      .filter((r) => r.rate !== 44100 && r.rate !== 48000)
      .sort((a, b) => a.rate - b.rate)
      .map((r) => ({ key: `rate:${r.rate}`, label: fmtRate(r.rate), n: r.albums, kind: 'samplerate', rate: r.rate }));
    return [
      ...main,
      { key: 'replaygain', label: 'Sin ReplayGain', n: summary.noReplaygain, kind: 'replaygain' },
      { key: 'cover', label: 'Sin carátula', n: summary.noCover, kind: 'cover' },
      ...others,
    ];
  }, [summary]);

  const current = tabs.find((t) => t.key === tab);

  useEffect(() => {
    if (!current) return undefined;
    let alive = true;
    setList(null);
    setListError(null);
    setQ('');
    setLimit(PAGE);
    api.qualityList(current.kind, current.rate)
      .then((r) => alive && setList(r.albums))
      .catch((e) => alive && setListError(e.message));
    return () => {
      alive = false;
    };
  }, [current?.key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!list) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((a) => `${a.album_artist} ${a.title} ${a.path || ''}`.toLowerCase().includes(needle));
  }, [list, q]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((a) => `${a.album_artist} — ${a.title}`).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin permiso de portapapeles: no pasa nada */
    }
  };

  const detail = (a) => {
    if (current.kind === 'samplerate')
      return a.rates.length > 1 ? (
        <span className="text-amber-400/80">mixto · {a.rates.map(fmtRate).join(' + ')}</span>
      ) : (
        <span className="text-neutral-500">{a.at_rate} {a.at_rate === 1 ? 'pista' : 'pistas'}</span>
      );
    if (current.kind === 'replaygain')
      return (
        <span className="text-neutral-500">
          {a.without === a.total ? `${a.total} pistas sin RG` : `${a.without} de ${a.total} sin RG`}
        </span>
      );
    return <span className="text-neutral-500">{a.track_file_count} pistas</span>;
  };

  if (err) return <div className="card p-4 mb-6 text-sm text-red-400">No se pudieron cargar los listados: {err}</div>;
  if (!summary) return <Spinner />;

  return (
    <div className="card p-4 mb-6">
      <h2 className="text-sm text-neutral-400 mb-3">¿Qué álbumes son?</h2>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => {
                if (t.key === tab) return;
                setList(null);
                setListError(null);
                setTab(t.key);
              }}
            className={`text-sm px-3 py-1.5 rounded-lg border transition ${
              tab === t.key
                ? 'border-gold-500/40 bg-gold-500/15 text-gold-300'
                : 'border-ink-800 text-neutral-300 hover:bg-ink-850'
            }`}
          >
            {t.label} <span className="text-neutral-500">· {t.n.toLocaleString('es')}</span>
          </button>
        ))}
      </div>

      {current?.kind === 'samplerate' && (
        <p className="text-xs text-neutral-600 mb-3">
          Álbumes con al menos una pista a {current.label}. Si un álbum mezcla frecuencias, sale en cada lista y lo indica.
        </p>
      )}
      {current?.kind === 'replaygain' && (
        <p className="text-xs text-neutral-600 mb-3">Álbumes con alguna pista sin etiqueta ReplayGain (volumen sin normalizar).</p>
      )}

      {listError ? (
        <div className="text-sm text-red-400">
          <p>{listError}</p>
          <button className="mt-2 underline" onClick={() => setAttempt((n) => n + 1)}>Reintentar</button>
        </div>
      ) : !list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p className="text-neutral-600 text-sm">Ninguno. Nada que mostrar en esta lista.</p>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setLimit(PAGE);
              }}
              placeholder="Filtrar por artista, álbum o carpeta…"
              className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-lg bg-ink-900 border border-ink-800 placeholder:text-neutral-600"
            />
            <button
              onClick={copyAll}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-ink-800 text-neutral-400 hover:bg-ink-850"
              title="Copia «Artista — Álbum» de lo que se ve, una línea por álbum"
            >
              <Copy size={13} /> {copied ? 'Copiado' : 'Copiar lista'}
            </button>
          </div>
          <p className="text-xs text-neutral-600 mb-2">
            {filtered.length.toLocaleString('es')} {filtered.length === 1 ? 'álbum' : 'álbumes'}
            {q.trim() ? ` de ${list.length.toLocaleString('es')}` : ''}
          </p>
          <div className="space-y-0.5 max-h-[32rem] overflow-y-auto">
            {filtered.slice(0, limit).map((a) => (
              <Link key={a.id} to={`/album/${a.id}`} className="block px-2 py-1.5 -mx-2 rounded hover:bg-ink-850/60">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate hover:text-gold-400">
                    {a.album_artist} — {a.title}
                    {a.year ? <span className="text-neutral-500"> ({a.year})</span> : null}
                  </span>
                  <span className="text-xs shrink-0">{detail(a)}</span>
                </div>
                {a.path && <div className="text-[11px] text-neutral-600 truncate">{a.path}</div>}
              </Link>
            ))}
            {filtered.length > limit && (
              <button
                onClick={() => setLimit((l) => l + PAGE)}
                className="w-full text-xs text-neutral-400 hover:text-gold-400 py-2"
              >
                Mostrar {Math.min(PAGE, filtered.length - limit)} más ({(filtered.length - limit).toLocaleString('es')} restantes)
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
