// Fuentes de novedades de «Lanzamientos». Cada fila/evento pertenece a UNA fuente. Se
// guarda lo APAGADO (no lo encendido): una fuente nueva aparece activada por defecto.
export const SRC_OFF_KEY = 'liderarrr:calendar:sourcesOff';

export const BASE_SOURCES = [
  { id: 'mb', label: 'MusicBrainz · tus artistas', hint: 'Próximos y Estrenados' },
  { id: 'labels', label: 'MusicBrainz · tus sellos', hint: 'De tus sellos' },
  { id: 'deezer', label: 'Deezer · tu colección', hint: 'Discos y canciones nuevas' },
  { id: 'discover', label: 'Deezer · artistas afines', hint: 'Descubre' },
];

export const curatorSourceId = (source, username) => `radar:${source}:${username}`;

export function loadSourcesOff() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SRC_OFF_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function saveSourcesOff(set) {
  try {
    localStorage.setItem(SRC_OFF_KEY, JSON.stringify([...set]));
  } catch {
    /* sin persistencia si el navegador no deja */
  }
}

// Fuente de una fila de lista, según la pestaña en la que está.
export function rowSource(view, r) {
  if (view === 'radar') return curatorSourceId(r.source, r.curator_username);
  if (view === 'labels') return 'labels';
  if (view === 'descubre') return 'discover';
  if (view === 'novedades' || view === 'canciones') return 'deezer';
  return 'mb'; // upcoming | recent
}

// Fuente de un evento del calendario Mes, según su tipo.
export function kindSource(kind, x) {
  if (kind === 'upcoming' || kind === 'recent') return 'mb';
  if (kind === 'label') return 'labels';
  if (kind === 'novedad' || kind === 'single') return 'deezer';
  if (kind === 'descubre') return 'discover';
  return curatorSourceId(x.source, x.curator_username); // radar
}
