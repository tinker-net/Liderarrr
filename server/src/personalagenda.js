import { db } from './db.js';
import { lidarrConfig } from './lidarr.js';
import { normName } from './matchkey.js';

function agendaArtists() {
  const config = lidarrConfig();
  return db.prepare(`SELECT id, name, mbid FROM artists a WHERE EXISTS
    (SELECT 1 FROM tracked_artists t WHERE t.artist_id=a.id AND t.facet='artist')
    OR (? AND EXISTS (SELECT 1 FROM agenda_lidarr_artists l WHERE l.mbid=a.mbid))
    ORDER BY name COLLATE NOCASE`).all(Number(Boolean(config.url && config.key)));
}

export function personalAgenda(now = new Date()) {
  const artists = agendaArtists();
  const ids = new Set(artists.map(a => a.id));
  const mbids = new Map(artists.filter(a => a.mbid).map(a => [a.mbid,a]));
  const names = new Map();
  for (const a of artists) {
    const key = normName(a.name);
    names.set(key,names.has(key) ? null : a);
  }
  const cutoff = new Date(now.getTime()-30*86400000).toISOString().slice(0,10);
  const releases = [];
  const catalog = new Map();
  const byGroup = new Map();
  function record(r,source) {
    const a = r.artist_mbid ? mbids.get(r.artist_mbid) : names.get(normName(r.artist));
    if (!a && !ids.has(r.artist_id)) return;
    const artistId = a?.id || r.artist_id;
    const key = artistId + ':' + normName(r.title);
    const row = {...r, artist_id:artistId, source};
    if (!catalog.has(key) || row.date < catalog.get(key).date) catalog.set(key,row);
    if (r.rg_mbid) byGroup.set(r.rg_mbid,row);
    // La fecha parcial conserva su precisión y nunca se coloca en un día inventado.
    if (row.date >= cutoff.slice(0,row.date.length)) releases.push(row);
  }
  for (const r of db.prepare(`SELECT rg.artist_id,rg.artist_mbid,a.name AS artist,rg.title,rg.rg_mbid,rg.first_release AS date
    FROM release_groups rg JOIN artists a ON a.id=rg.artist_id WHERE rg.primary_type IN ('Album','EP')
    AND rg.first_release != '' AND rg.rg_mbid NOT IN (SELECT rg_mbid FROM dismissed_albums)`).iterate()) {
    if (ids.has(r.artist_id)) record(r,'mb');
  }
  for (const r of db.prepare(`SELECT g.artist_mbid,g.artist_credit AS artist,g.title,g.rg_mbid,g.first_release AS date
    FROM label_release_groups g JOIN tracked_labels l USING(label_mbid) WHERE g.first_release != ''
    AND g.rg_mbid NOT IN (SELECT rg_mbid FROM dismissed_albums)`).iterate()) record(r,'labels');
  for (const r of db.prepare(`SELECT n.*,a.name AS artist FROM agenda_announcements n JOIN artists a ON a.id=n.artist_id`).all()) {
    if (ids.has(r.artist_id) && !catalog.has(r.artist_id+':'+normName(r.title)) && r.date>=cutoff) releases.push({...r,source:'official'});
  }
  const mentions = [];
  for (const r of db.prepare(`SELECT i.artist,i.artist_mbid,i.rg_mbid,i.title,i.list_date AS date,i.url,c.source,c.username,c.name AS curator
    FROM radar_items i JOIN curators c ON c.id=i.curator_id WHERE i.dismissed=0 AND i.list_date>=? ORDER BY i.list_date DESC`).iterate(cutoff)) {
    const a = r.artist_mbid ? mbids.get(r.artist_mbid) : names.get(normName(r.artist));
    if (!a || !r.title) continue;
    const original = byGroup.get(r.rg_mbid) || catalog.get(a.id+':'+normName(r.title));
    mentions.push({...r,artist_id:a.id,original:original?.date || null});
  }
  const suggestions = db.prepare(`SELECT a.id,a.name,COUNT(DISTINCT b.id) AS albums FROM artists a
    JOIN albums b ON b.artist_id=a.id AND b.match_state!='dismissed' GROUP BY a.id ORDER BY albums DESC`).all()
    .filter(a => !ids.has(a.id));
  const plays = db.prepare(`SELECT artist,COUNT(*) AS plays FROM listens WHERE source IN ('lastfm','listenbrainz') AND ts>=?
    GROUP BY artist COLLATE NOCASE ORDER BY plays DESC`).all(now.getTime()-90*86400000);
  const counts = new Map(plays.map(a => [normName(a.artist),a.plays]));
  for (const a of suggestions) a.plays = counts.get(normName(a.name)) || 0;
  const known = new Set(suggestions.map(a => normName(a.name)));
  for (const a of plays) if (!known.has(normName(a.artist)) && !names.has(normName(a.artist))) suggestions.push({name:a.artist,plays:a.plays,albums:0});
  suggestions.sort((a,b)=>b.plays-a.plays || b.albums-a.albums);
  return {artists,releases,mentions,suggestions:suggestions.slice(0,12)};
}

export function registerAgenda(app) {
  app.get('/api/agenda', async () => personalAgenda());
  app.post('/api/agenda/announcement', async (req,reply) => {
    const {artist_id,title,date,url} = req.body || {};
    if (!agendaArtists().some(a=>a.id===Number(artist_id)) || typeof title!=='string' || !title.trim() || title.length>500 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date ||
      typeof url!=='string' || !URL.canParse(url) || !['https:','http:'].includes(new URL(url).protocol)) {
      return reply.code(400).send({error:'Comprueba el artista, el título, el día y el enlace oficial.'});
    }
    db.prepare(`INSERT INTO agenda_announcements VALUES (?,?,?,?) ON CONFLICT(artist_id,title)
      DO UPDATE SET date=excluded.date,url=excluded.url`).run(Number(artist_id),title.trim(),date,url);
    return {ok:true};
  });
}
