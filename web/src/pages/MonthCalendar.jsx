import { agendaEvents } from '../agenda.js';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, Download, ExternalLink, Loader2, Check } from 'lucide-react';
import { api } from '../api.js';
import { Spinner, AddToChallengeButton, WantButton } from '../components.jsx';

import { aviso } from '../avisos.jsx';

// Vista MES tipo Google Calendar: una rejilla mensual que junta TODAS las fuentes de
// lanzamientos en su día — Próximos y Estrenados recientemente (MusicBrainz), De tus
// sellos, Radar (curadores) y Discos nuevos / Canciones nuevas (Deezer). Se cargan una vez con una
// ventana amplia y se re-agrupan al navegar de mes (sin repetir peticiones).

const KIND = {
  upcoming: { label: 'Próximo', dot: '#0ea5e9' },
  recent: { label: 'Estreno', dot: '#b9852f' },
  label: { label: 'Sello', dot: '#d97706' },
  novedad: { label: 'Disco nuevo', dot: '#10b981' },
  single: { label: 'Canción', dot: '#ec4899' },
  radar: { label: 'Radar', dot: '#8b5cf6' },
  descubre: { label: 'Descubre', dot: '#2dd4bf' },
};
const KIND_ORDER = ['upcoming', 'recent', 'label', 'novedad', 'single', 'radar', 'descubre'];
// Todas las fuentes disponibles salvo las desactivadas por el usuario.
const DEFAULT_ON = { upcoming: true, recent: true, label: true, novedad: true, single: true, radar: true, descubre: true };
const SOURCES_KEY = 'liderarrr:calendar:sources';
const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const nkey = (s) => String(s || '').normalize('NFD').toLowerCase().replace(/[^a-z0-9]+/g, '');
const iso = (d) => d.toISOString().slice(0, 10);
const monthsAgoIso = (n) => iso(new Date(Date.now() - n * 30 * 86400000));

export default function MonthCalendar({ onSearch, srcOff, format, edition }) {
  const [layout, setLayout] = useState('week');
  const [owned, setOwned] = useState(false);
  const [events, setEvents] = useState(null);
  const [err, setErr] = useState(null);
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [selected, setSelected] = useState(iso(new Date()));
  const [grab, setGrab] = useState({}); // key -> 'busy' | 'done'
  // qué fuentes mostrar (elección del usuario, persistida). Se parte de DEFAULT_ON y se
  // fusiona con lo guardado, para que fuentes nuevas aparezcan con su valor por defecto.
  const [enabled, setEnabled] = useState(() => {
    try {
      return { ...DEFAULT_ON, ...(JSON.parse(localStorage.getItem(SOURCES_KEY) || '{}')) };
    } catch {
      return { ...DEFAULT_ON };
    }
  });
  const toggleSource = (k) =>
    setEnabled((p) => {
      const next = { ...p, [k]: !p[k] };
      try {
        localStorage.setItem(SOURCES_KEY, JSON.stringify(next));
      } catch {
        /* sin persistencia si el navegador no deja */
      }
      return next;
    });

  useEffect(() => {
    const since = monthsAgoIso(14); // ventana amplia; navegar de mes solo re-agrupa
    let active = true;
    const requests = { upcoming: api.upcoming(true), recent: api.recentReleases(since,true),
      label: api.labelReleases(since), radar: api.radar(since,false), novedad: api.newReleases(true),
      single: api.newSongs(400,true), descubre: api.globalReleases(45,false,true) };
    Promise.allSettled(Object.values(requests)).then(results => {
      if (!active) return;
      const data = {};
      const failed = [];
      Object.keys(requests).forEach((key,i) => {
        const response = results[i];
        data[key] = response.status === 'fulfilled' ? response.value : [];
        if (response.status === 'rejected') failed.push(KIND[key].label);
      });
      setEvents(data);
      setErr(failed.join(', '));
    });
    return () => { active = false; };
  }, []);
  const visible = useMemo(() => events ? agendaEvents(events,enabled,srcOff,format,edition)
    .filter(e => owned || !e.is_owned) : [], [events,enabled,srcOff,format,edition,owned]);
  const byDay = useMemo(() => {
    const days = {};
    for (const e of visible) (days[e.date] ||= []).push(e);
    return days;
  }, [visible]);

  // celdas de la rejilla: 6 semanas (42 días) desde el lunes de la 1ª semana del mes
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(cursor.y, cursor.m, 1));
    const offset = (first.getUTCDay() + 6) % 7; // 0 = lunes
    const start = new Date(first);
    start.setUTCDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      return { key: iso(d), day: d.getUTCDate(), inMonth: d.getUTCMonth() === cursor.m };
    });
  }, [cursor]);

  const today = iso(new Date());
  const go = (delta) => setCursor((c) => {
    const d = new Date(Date.UTC(c.y, c.m + delta, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  const goToday = () => {
    const n = new Date();
    setCursor({ y: n.getFullYear(), m: n.getMonth() });
    setSelected(today);
  };

  const doGrab = async (e) => {
    const key = `${e.date}:${nkey(e.artist)}:${nkey(e.title)}`;
    setGrab((p) => ({ ...p, [key]: 'busy' }));
    try {
      const ctx = { artist: e.artist, album: e.title };
      if (e.rg_mbid) ctx.rg_mbid = e.rg_mbid;
      const res = await api.grabBest(`${e.artist} ${e.title}`, ctx);
      if (!res.grabbed) {
        aviso(`No se pudo agarrar: ${res.reason || 'sin release'}`, 'error');
        setGrab((p) => ({ ...p, [key]: undefined }));
        return;
      }
      setGrab((p) => ({ ...p, [key]: 'done' }));
    } catch (err) {
      aviso(err.message, 'error');
      setGrab((p) => ({ ...p, [key]: undefined }));
    }
  };


  if (!events) return <Spinner label="Reuniendo todas las fuentes…" />;

  const selEvents = byDay[selected] || [];

  return (
    <div>
      {err && <p role="alert">Fuentes que no han respondido · {err}</p>}
      <div className="flex flex-wrap gap-3 mb-4">
        <button className="btn" onClick={() => setLayout(layout === 'week' ? 'month' : 'week')}>{layout === 'week' ? 'Ver mes' : 'Ver semana'}</button>
        <label><input type="checkbox" checked={owned} onChange={e => setOwned(e.target.checked)} /> Incluir los que ya tengo</label>
      </div>
      {layout === 'week' && <WeekAgenda events={visible} onSearch={onSearch} />}
      {layout === 'month' && <>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1">
          <button onClick={() => go(-1)} className="p-1.5 rounded-lg border border-ink-800 bg-ink-850 hover:bg-ink-800" aria-label="Mes anterior">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => go(1)} className="p-1.5 rounded-lg border border-ink-800 bg-ink-850 hover:bg-ink-800" aria-label="Mes siguiente">
            <ChevronRight size={16} />
          </button>
          <button onClick={goToday} className="text-xs px-2 py-1.5 rounded-lg border border-ink-800 bg-ink-850 hover:bg-ink-800 ml-1">
            Hoy
          </button>
        </div>
        <h2 className="font-display text-lg capitalize">
          {MONTHS[cursor.m]} {cursor.y}
        </h2>
      </div>

      {/* filtros de fuentes: pulsa para mostrar/ocultar cada tipo (se recuerda tu elección) */}
      <div className="flex flex-wrap gap-2 mb-3">
        {KIND_ORDER.map((k) => {
          const on = !!enabled[k];
          return (
            <button
              key={k}
              onClick={() => toggleSource(k)}
              title={on ? 'Ocultar' : 'Mostrar'}
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg border transition ${
                on ? 'border-ink-700 bg-ink-850 text-neutral-300' : 'border-ink-800 bg-ink-900 text-neutral-600 opacity-60'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: on ? KIND[k].dot : 'transparent', border: on ? 'none' : `1px solid ${KIND[k].dot}` }}
              />
              {KIND[k].label}
            </button>
          );
        })}
      </div>

      {/* rejilla */}
      <div className="grid grid-cols-7 gap-px bg-ink-800 rounded-lg overflow-hidden border border-ink-800">
        {WEEKDAYS.map((w) => (
          <div key={w} className="bg-ink-900 text-[11px] uppercase tracking-wide text-neutral-600 px-2 py-1.5 text-center">
            {w}
          </div>
        ))}
        {cells.map((c) => {
          const evs = byDay[c.key] || [];
          const isToday = c.key === today;
          const isSel = c.key === selected;
          return (
            <button
              key={c.key}
              onClick={() => setSelected(c.key)}
              className={`bg-ink-900 min-h-[68px] md:min-h-[92px] p-1.5 text-left align-top flex flex-col gap-1 transition ${
                c.inMonth ? '' : 'opacity-40'
              } ${isSel ? 'ring-2 ring-gold-500/60 ring-inset' : 'hover:bg-ink-850'}`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs ${isToday ? 'bg-gold-500 text-black rounded-full w-5 h-5 inline-flex items-center justify-center' : 'text-neutral-400'}`}
                >
                  {c.day}
                </span>
                {evs.length > 0 && <span className="text-[10px] text-neutral-600 md:hidden">{evs.length}</span>}
              </div>
              {/* móvil: puntitos; escritorio: pastillas con texto */}
              <div className="flex flex-wrap gap-1 md:hidden">
                {evs.slice(0, 6).map((e, i) => (
                  <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ background: KIND[e.primary].dot }} />
                ))}
              </div>
              <div className="hidden md:flex md:flex-col gap-0.5 min-w-0">
                {evs.slice(0, 3).map((e, i) => (
                  <span
                    key={i}
                    title={`${e.artist} — ${e.title}`}
                    className="text-[11px] text-neutral-300 truncate inline-flex items-center gap-1"
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND[e.primary].dot }} />
                    <span className="truncate">
                      {e.artist} — {e.title}
                    </span>
                  </span>
                ))}
                {evs.length > 3 && <span className="text-[10px] text-neutral-600">+{evs.length - 3} más</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/* detalle del día seleccionado */}
      <div className="mt-4">
        <h3 className="text-sm text-neutral-400 mb-2 capitalize">
          {new Date(selected + 'T00:00:00Z').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
        </h3>
        {selEvents.length === 0 ? (
          <p className="text-sm text-neutral-600">Sin lanzamientos este día.</p>
        ) : (
          <div className="space-y-1.5">
            {selEvents.map((e, i) => {
              const key = `${e.date}:${nkey(e.artist)}:${nkey(e.title)}`;
              return (
                <div key={i} className="card px-3 py-2 release-row text-sm">
                  <div className="release-main">
                    <div className="flex flex-col gap-1 shrink-0">
                      {e.kinds.map((k) => (
                        <span key={k} className="w-2 h-2 rounded-full" style={{ background: KIND[k].dot }} title={KIND[k].label} />
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate clamp-mobile" title={`${e.artist} — ${e.title}`}>
                        {e.artist_id ? (
                          <Link to={`/artista/${e.artist_id}`} className="hover:text-gold-400">
                            {e.artist}
                          </Link>
                        ) : (
                          <span>{e.artist}</span>
                        )}
                        <span className="text-neutral-500"> — {e.title}</span>
                      </div>
                      <div className="text-xs text-neutral-600 flex items-center gap-2 flex-wrap">
                        <span>{e.kinds.map((k) => KIND[k].label).join(' · ')}</span>
                        {e.reason && <span className="text-sky-400/80">{e.reason}</span>}
                        {e.ahead && <span className="text-amber-400/80" title="MusicBrainz aún no lo lista">⚡ MB no lo tiene</span>}
                        {e.is_owned && <span className="text-emerald-400/70">ya lo tienes</span>}
                      </div>
                    </div>
                  </div>
                  <div className="release-actions">
                    <button
                      onClick={() => onSearch(`${e.artist} ${e.title}`)}
                      className="text-xs px-1.5 py-0.5 rounded border border-ink-700 bg-ink-850 hover:bg-ink-800 inline-flex items-center gap-1"
                    >
                      <Search size={12} /> Buscar
                    </button>
                    <AddToChallengeButton artist={e.artist} title={e.title} />
                    {!e.is_owned && (
                      <WantButton artist={e.artist} title={e.title} releaseDate={e.date} origin="calendario" />
                    )}
                    {grab[key] === 'done' ? (
                      <span className="text-emerald-400 text-xs inline-flex items-center gap-1">
                        <Check size={13} /> pedido
                      </span>
                    ) : (
                      <button
                        onClick={() => doGrab(e)}
                        disabled={grab[key] === 'busy'}
                        className="text-xs px-1.5 py-0.5 rounded border border-gold-500/40 bg-gold-500/10 text-gold-300 hover:bg-gold-500/20 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {grab[key] === 'busy' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Descargar
                      </button>
                    )}
                    {e.url && (
                      <a href={e.url} target="_blank" rel="noreferrer" className="text-xs text-gold-400 hover:underline inline-flex items-center gap-0.5">
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>}
    </div>
  );
}

function WeekAgenda({events,onSearch}) {
  const [offset,setOffset] = useState(0);
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()));
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay()+6)%7 + offset*7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate()+6);
  const rows = events.filter(e => e.date.length === 10 && e.date >= iso(start) && e.date <= iso(end));
  const partial = events.filter(e => e.date.length < 10 && (iso(start).startsWith(e.date) || iso(end).startsWith(e.date)));
  const display = date => new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(date);
  const next = events.find(e => e.date.length === 10 && e.date > iso(end));
  const list = items => items.map(e => <button key={JSON.stringify([e.id,e.date,e.category])}
    onClick={() => onSearch(`${e.artist} ${e.title}`)}
    className="card w-full p-3 mb-2 text-left">
    <small>{e.date} · {e.origins.join(' · ')}{e.reason && ` · ${e.reason}`}</small><div>{e.artist} — <strong>{e.title}</strong></div>
  </button>);
  return <section>
    <div className="flex flex-wrap items-center gap-3 mb-3">
      <button aria-label="Semana anterior" onClick={() => setOffset(offset-1)}>←</button>
      <strong>{display(start)} – {display(end)}</strong>
      <button aria-label="Semana siguiente" onClick={() => setOffset(offset+1)}>→</button>
      <button onClick={() => setOffset(0)}>Esta semana</button>
    </div>
    {rows.length ? list(rows) : <p className="mb-4 text-neutral-400">Sin entradas esta semana con estos filtros.</p>}
    {!rows.length && next && <button className="btn mb-3" onClick={() => setOffset(offset + Math.floor((Date.parse(next.date) - start.getTime()) / 604800000))}>Ir a la próxima entrada · {next.date}</button>}
    {!!partial.length && <><h3>Anunciados sin día exacto</h3>{list(partial)}</>}
  </section>;
}
