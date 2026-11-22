export const formats = {
  all: 'Todos los formatos', album: 'Álbumes', single: 'Singles', ep: 'EP',
  compilation: 'Recopilatorios', live: 'Directos', other: 'Otros o sin clasificar',
};

export const editions = {
  all: 'Todas las ediciones', new: 'Novedades', reissue: 'Reediciones', unknown: 'Edición sin confirmar',
};

function releaseFormat(row) {
  const secondary = String(row.secondary_types || '').toLowerCase();
  if (secondary.includes('compilation')) return 'compilation';
  if (secondary.includes('live')) return 'live';
  const type = String(row.primary_type || row.record_type || '').toLowerCase();
  if (type === 'compile' || type === 'compilation') return 'compilation';
  return ['album', 'single', 'ep'].includes(type) ? type : 'other';
}

function releaseEdition(row) {
  if (/\b(?:reissue(?:d)?|reedici[oó]n|remaster(?:ed|izado)?|anniversary edition)\b/i.test(row.title || '')) return 'reissue';
  // Las fechas de un release group de MusicBrainz corresponden al primer lanzamiento.
  if (row.first_release && (!row.release_date || row.first_release === row.release_date)) return 'new';
  if (row.first_release && row.release_date > row.first_release) return 'reissue';
  return 'unknown';
}

export function matchesRelease(row, format, edition) {
  return (format === 'all' || releaseFormat(row) === format) &&
    (edition === 'all' || releaseEdition(row) === edition);
}
