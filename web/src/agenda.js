import { kindSource } from './sources.js';
import { matchesRelease } from './releaseFilters.js';

const norm = value => String(value || '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const identity = r => JSON.stringify([norm(r.artist), norm(r.title)]);
const datePattern = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;

export function agendaEvents(data, enabled, off, format, section) {
  const groups = new Map();
  const ids = new Map();
  const entries = Object.entries(data).flatMap(([kind, rows]) =>
    rows.filter(r => r.artist && r.title).map(row => ({ kind, row })));
  for (const { row } of entries) {
    if (row.rg_mbid) {
      const name = identity(row);
      if (!ids.has(name)) ids.set(name, new Set());
      ids.get(name).add(row.rg_mbid);
    }
  }
  for (const { kind, row } of entries) {
    const name = identity(row);
    const candidates = ids.get(name);
    const key = row.rg_mbid || (candidates?.size === 1 ? [...candidates][0] : name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ kind, row });
  }
  const result = [];
  for (const [id, group] of groups) {
    const visible = group.filter(({kind,row}) => enabled[kind] && !off?.has(kindSource(kind,row)));
    if (!visible.length) continue;
    const first = group.map(x => x.row.first_release).filter(Boolean).sort()[0];
    const events = new Map();
    for (const {kind,row} of visible) {
      const mention = kind === 'radar';
      const release = row.release_date || row.first_release;
      const edition = matchesRelease({...row, first_release:first}, 'all', 'reissue') ? 'reissue'
        : first && release && first === release ? 'new' : 'unknown';
      const category = mention ? 'radar' : edition;
      const date = mention ? row.list_date : release;
      if (!datePattern.test(date || '') || (section !== 'all' && category !== section)) continue;
      if (format !== 'all' && !group.some(x => matchesRelease(x.row, format, 'all'))) continue;
      const key = category + ':' + date;
      let event = events.get(key);
      if (!event) {
        event = {...row, id, date, category, primary:kind, kinds:[], origins:[], reason:row.reason || (row.tracked || row.tracked_artist ? 'Artista seguido' : row.labels ? 'Sello seguido' : ''), is_owned:group.some(x => x.row.is_owned || x.row.owned)};
        events.set(key,event);
      }
      if (!event.kinds.includes(kind)) event.kinds.push(kind);
      const origin = row.curator || row.labels || (kind === 'upcoming' || kind === 'recent' ? 'MusicBrainz' : row.source || 'Deezer');
      if (!event.origins.includes(origin)) event.origins.push(origin);
    }
    result.push(...events.values());
  }
  return result.sort((a,b) => a.date.localeCompare(b.date) || a.artist.localeCompare(b.artist));
}
