import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { splitRoots, isJunkEntry } from './libkey.js';
import { scanStatus } from './scanner.js';
import { matchKey } from './matchkey.js';
import { isStudioAlbum } from './discography.js';
import { regroupDiscs } from './discgroup.js';

// Dos cosas que comparten fichero porque las dos cuelgan de «¿qué hay de verdad en mi
// biblioteca?» y ninguna toca lo que ya existe:
//
//  1. LISTADOS DE CALIDAD — qué álbumes están a 44,1 kHz, a 48 kHz, sin ReplayGain o sin
//     carátula. Solo LEEN lo que el escáner ya guardó (tracks.sample_rate,
//     tracks.has_replaygain, albums.cover): nada que reescanear.
//
//  2. REVISIÓN DE BAJAS — después del escaneo manual o nocturno, quita de la BASE
//     DE DATOS los álbumes cuyos
//     ficheros ya no existen. Hasta ahora el escáner solo añadía o actualizaba: un disco
//     borrado del disco se quedaba para siempre en la base.
//
// REGLA DE ORO: la poda solo borra FILAS. Nunca toca un fichero de música (eso solo lo hace
// albumdelete.js, a mano y con confirmación). Y ante la duda, NO borra: una biblioteca en red
// que no ha montado, un volumen vacío o un error de permisos parecen «se ha borrado todo», y
// vaciar la base por eso sería el peor fallo posible. De ahí las salvaguardas de pruneMissing.

// Mismas extensiones que el escáner (scanner.js). Si allí se añade un formato, añadirlo aquí.
const AUDIO_EXT = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.oga', '.wav', '.wv', '.ape',
  '.alac', '.aiff', '.aif', '.dsf', '.dff', '.mpc', '.tak', '.tta', '.wma',
]);

const LIVE = "a.match_state != 'dismissed'"; // mismo criterio «descriptivo» que queries.js
const ORDER = 'ORDER BY a.album_artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE';
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// ─────────────────────────── 1. LISTADOS DE CALIDAD ───────────────────────────

// Contadores de las pestañas: cuántos ÁLBUMES (no pistas) hay en cada lista.
export function qualityListsSummary() {
  const sampleRates = db
    .prepare(
      `SELECT t.sample_rate AS rate, COUNT(DISTINCT t.album_id) AS albums
       FROM tracks t JOIN albums a ON a.id = t.album_id
       WHERE ${LIVE} AND t.sample_rate IS NOT NULL
       GROUP BY t.sample_rate ORDER BY albums DESC`
    )
    .all();
  const noReplaygain = db
    .prepare(
      `SELECT COUNT(DISTINCT t.album_id) AS n
       FROM tracks t JOIN albums a ON a.id = t.album_id
       WHERE ${LIVE} AND t.has_replaygain = 0`
    )
    .get().n;
  // misma definición que qualityOverview().noCover (queries.js): el número de la tarjeta
  // «Sin carátula» y el de esta lista tienen que cuadrar.
  const noCover = db
    .prepare(`SELECT COUNT(*) AS n FROM albums a WHERE ${LIVE} AND (a.cover IS NULL OR a.cover = '')`)
    .get().n;
  return { sampleRates, noReplaygain, noCover };
}

// Álbumes con AL MENOS una pista a esa frecuencia. Si un álbum mezcla frecuencias (44,1 y
// 48) sale en las dos listas y lleva `rates` con todas, para que no se esconda nada.
export function albumsAtSampleRate(rate) {
  const hz = Math.round(Number(rate));
  if (!Number.isFinite(hz) || hz <= 0) throw new Error('Frecuencia de muestreo no válida');
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.album_artist, a.year, a.path, a.track_file_count,
        COUNT(t.id) AS at_rate,
        (SELECT GROUP_CONCAT(DISTINCT t2.sample_rate) FROM tracks t2
          WHERE t2.album_id = a.id AND t2.sample_rate IS NOT NULL) AS rates
       FROM albums a JOIN tracks t ON t.album_id = a.id AND t.sample_rate = @hz
       WHERE ${LIVE}
       GROUP BY a.id ${ORDER}`
    )
    .all({ hz });
  return rows.map((r) => ({
    ...r,
    rates: String(r.rates || '')
      .split(',')
      .map(Number)
      .filter(Boolean)
      .sort((x, y) => x - y),
  }));
}

// Álbumes con alguna pista sin ReplayGain (el mismo has_replaygain=0 que ya cuenta la
// página de Calidad), con cuántas pistas de cuántas.
export function albumsWithoutReplaygain() {
  return db
    .prepare(
      `SELECT a.id, a.title, a.album_artist, a.year, a.path,
        COUNT(t.id) AS total,
        SUM(CASE WHEN t.has_replaygain = 0 THEN 1 ELSE 0 END) AS without
       FROM albums a JOIN tracks t ON t.album_id = a.id
       WHERE ${LIVE}
       GROUP BY a.id HAVING without > 0 ${ORDER}`
    )
    .all();
}

export function albumsWithoutCover() {
  return db
    .prepare(
      `SELECT a.id, a.title, a.album_artist, a.year, a.path, a.track_file_count
       FROM albums a
       WHERE ${LIVE} AND (a.cover IS NULL OR a.cover = '')
       ${ORDER}`
    )
    .all();
}

// ───────────────────── 2. SINCRONIZACIÓN AUTOMÁTICA (poda) ─────────────────────

// Si la poda va a quitar más de esta fracción de la biblioteca (o más de MAX_COUNT álbumes),
// se DETIENE y pide confirmación: borrar de golpe una cuarta parte de la colección casi
// nunca es intencionado (lo normal es un montaje caído o una ruta cambiada).
const MAX_FRACTION = 0.25;
const MAX_COUNT = 25;

export const syncStatus = {
  running: false,
  phase: 'idle', // idle | pruning | done | error
  trigger: null, // nightly | manual
  startedAt: null,
  finishedAt: null,
  checked: 0,
  removed: 0,
  removedTracks: 0,
  removedSample: [],
  skippedRoots: [],
  blocked: null, // { count, evaluated, sample } cuando la salvaguarda frena la poda
  error: null,
};

function lastResult() {
  try {
    return JSON.parse(getSetting('auto_sync_last') || 'null');
  } catch {
    return null;
  }
}

// Valida el montaje contra audio que ya figura en la biblioteca.
async function rootHealthy(root, albums) {
  try {
    const st = await fs.promises.stat(root);
    if (!st.isDirectory()) return false;
    // Una carpeta accesible puede ser el directorio vacío detrás de un montaje caído.
    // Exige audio de la biblioteca conocida, aunque queden carpetas o archivos auxiliares.
    for (let i = 0; i < albums.length; i += 32) {
      const results = await Promise.all(albums.slice(i, i + 32).map((album) => albumGone(album, { verifyAudio: true })));
      if (results.includes(false)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ¿Ha desaparecido de verdad este álbum? true = sí · false = sigue ahí · null = no se sabe.
// Solo ENOENT/ENOTDIR cuentan como «no existe»; un EACCES, un timeout de la red o un EIO NO
// prueban nada, así que se deja el álbum como está.
async function albumGone(a, { verifyAudio = false } = {}) {
  let st;
  try {
    st = await fs.promises.stat(a.path);
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? true : null;
  }
  if (!st.isDirectory()) return null;
  // La carpeta existe. Si no ha cambiado desde el último escaneo, su contenido es el que
  // la base ya conoce. Si cambió, el escáner la habrá releído SALVO que ya no quede audio
  // (una carpeta sin audio no se visita): ese es el único caso que hay que mirar aquí.
  if (!verifyAudio && a.scanned_at && st.mtimeMs <= a.scanned_at) return false;
  let entries;
  try {
    entries = await fs.promises.readdir(a.path, { withFileTypes: true });
  } catch {
    return null;
  }
  const hasAudio = entries.some(
    (e) => e.isFile() && !isJunkEntry(e.name) && AUDIO_EXT.has(path.extname(e.name).toLowerCase())
  );
  return !hasAudio;
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Quita de la base los álbumes cuyos ficheros ya no están. Devuelve el resumen.
export async function pruneMissingAlbums({ confirmation = null } = {}) {
  const out = { checked: 0, removed: 0, tracks: 0, sample: [], skippedRoots: [], unknown: 0, blocked: null };
  const roots = splitRoots(getSetting('music_dirs')).map((raw) => ({ raw, n: norm(raw) }));
  if (!roots.length) return out;

  const rows = db
    .prepare("SELECT id, path, title, album_artist, scanned_at FROM albums WHERE path IS NOT NULL AND path != ''")
    .all();
  const byRoot = new Map(roots.map((root) => [root, []]));
  for (const album of rows) {
    const albumPath = norm(album.path);
    const root = roots.find((r) => albumPath === r.n || albumPath.startsWith(`${r.n}/`));
    if (root) byRoot.get(root).push(album);
  }
  const candidates = [];
  const healthy = [];
  for (const [root, albums] of byRoot) {
    if (!albums.length) continue;
    if (await rootHealthy(root.raw, albums)) {
      healthy.push(albums);
      candidates.push(...albums);
    } else {
      out.skippedRoots.push(root.raw);
    }
  }
  out.checked = candidates.length;

  const gone = [];
  await inBatches(candidates, 32, async (a) => {
    const v = await albumGone(a);
    if (v === true) gone.push(a);
    else if (v === null) out.unknown++;
  });
  if (!gone.length) return out;
  const currentAlbum = db.prepare('SELECT path, scanned_at FROM albums WHERE id = ?');
  if (scanStatus.running || gone.some((album) => {
    const current = currentAlbum.get(album.id);
    return !current || current.path !== album.path || current.scanned_at !== album.scanned_at;
  })) {
    throw new Error('La biblioteca cambió durante la comprobación. Vuelve a sincronizar.');
  }

  // Salvaguarda 3: freno de mano ante una poda desproporcionada.
  const missing = new Set(gone.map((a) => a.id));
  const token = createHash('sha256')
    .update(JSON.stringify(gone.map(({ id, path }) => [id, path]).sort(([a], [b]) => a - b)))
    .digest('hex');
  const largeBatch = gone.length > MAX_COUNT ||
    healthy.some((albums) => albums.filter((a) => missing.has(a.id)).length / albums.length > MAX_FRACTION);
  if ((largeBatch || confirmation !== null) && confirmation !== token) {
    out.blocked = {
      confirmation: token,
      changedSinceConfirmation: confirmation !== null,
      count: gone.length,
      evaluated: candidates.length,
      sample: gone.slice(0, 10).map((a) => `${a.album_artist || '?'} — ${a.title || '?'}`),
    };
    return out;
  }

  const countTracks = db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE album_id = ?');
  const steps = [
    db.prepare('DELETE FROM lyrics WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)'),
    db.prepare('DELETE FROM tracks WHERE album_id = ?'),
    db.prepare('DELETE FROM album_tags WHERE album_id = ?'),
    db.prepare('DELETE FROM album_labels WHERE album_id = ?'),
    db.prepare('DELETE FROM album_artists WHERE album_id = ?'),
    db.prepare('DELETE FROM albums WHERE id = ?'),
  ];
  const affected = (table, column) => db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`);
  const releases = affected('release_groups', 'owned_album_id');
  const challenges = affected('challenge_items', 'owned_album_id');
  const unlinkDownloads = db.prepare('UPDATE downloads SET album_id = NULL WHERE album_id = ?');
  const linkRelease = db.prepare('UPDATE release_groups SET owned_album_id = ?, is_owned = ? WHERE rg_mbid = ? AND artist_id = ?');
  const linkChallenge = db.prepare('UPDATE challenge_items SET owned_album_id = ? WHERE challenge_id = ? AND position = ?');
  const artistAlbums = db.prepare(`SELECT id, title, rg_mbid FROM albums
    WHERE match_state != 'dismissed' AND (artist_id = @id OR id IN (SELECT album_id FROM album_artists WHERE artist_id = @id))
    ORDER BY id`);
  const adjustStats = db.prepare('UPDATE artist_stats SET studio_owned = MAX(0, studio_owned - 1), missing = missing + 1 WHERE artist_id = ?');
  const challengeCopies = new Map();
  if (gone.some((a) => challenges.get(a.id))) {
    for (const a of db.prepare(`SELECT a.id, a.album_artist, a.title, ar.name AS artist_name
      FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.match_state != 'dismissed' ORDER BY a.id`).iterate()) {
      if (missing.has(a.id)) continue;
      challengeCopies.set(matchKey(a.album_artist, a.title), a.id);
      if (a.artist_name) challengeCopies.set(matchKey(a.artist_name, a.title), a.id);
    }
  }
  const dropBatch = db.transaction((batch) => {
    for (const a of batch) {
      for (const rg of releases.all(a.id)) {
        const copies = artistAlbums.all({ id: rg.artist_id }).filter((copy) => !missing.has(copy.id));
        const replacement = copies.find((copy) => copy.rg_mbid === rg.rg_mbid) ??
          copies.find((copy) => !copy.rg_mbid && matchKey('', copy.title) === matchKey('', rg.title));
        linkRelease.run(replacement?.id ?? null, replacement ? 1 : 0, rg.rg_mbid, rg.artist_id);
        if (!replacement && rg.is_owned && !rg.is_upcoming && isStudioAlbum(rg.primary_type, JSON.parse(rg.secondary_types || '[]'))) {
          adjustStats.run(rg.artist_id);
        }
      }
      for (const item of challenges.all(a.id)) {
        linkChallenge.run(challengeCopies.get(matchKey(item.artist, item.album)) ?? null, item.challenge_id, item.position);
      }
      unlinkDownloads.run(a.id);
      out.tracks += countTracks.get(a.id).n;
      for (const st of steps) st.run(a.id);
      out.removed++;
    }
  });
  // Mantiene las referencias y los álbumes consistentes en una sola transacción.
  dropBatch(gone);
  out.sample = gone.slice(0, 10).map((a) => `${a.album_artist || '?'} — ${a.title || '?'}`);

  // una caja multidisco a la que se le ha ido un disco tiene que reagruparse
  try {
    regroupDiscs();
  } catch (e) {
    console.warn('[autosync] no se pudo reagrupar multidiscos tras la poda:', String(e.message || e));
  }
  return out;
}

export async function reviewMissingAlbums({ confirmation = null, trigger = 'manual' } = {}) {
  if (scanStatus.running || syncStatus.running) {
    return { removed: 0, blocked: null, skippedRoots: [], error: 'Ya hay una revisión o un escaneo en curso' };
  }
  Object.assign(syncStatus, {
    running: true,
    phase: 'pruning',
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    checked: 0,
    removed: 0,
    removedTracks: 0,
    removedSample: [],
    skippedRoots: [],
    blocked: null,
    error: null,
  });
  try {
    const r = await pruneMissingAlbums({ confirmation });
    Object.assign(syncStatus, {
      checked: r.checked,
      removed: r.removed,
      removedTracks: r.tracks,
      removedSample: r.sample,
      skippedRoots: r.skippedRoots,
      blocked: r.blocked,
    });
    if (r.removed)
      console.log(`[autosync] poda: ${r.removed} álbumes (${r.tracks} pistas) ya no están en disco${confirmation ? ' (confirmado)' : ''}`);
    if (r.blocked)
      console.warn(`[autosync] poda DETENIDA por seguridad: ${r.blocked.count} de ${r.blocked.evaluated} álbumes parecen desaparecidos`);
    if (r.skippedRoots.length) console.warn(`[autosync] raíz sin responder, se omite: ${r.skippedRoots.join(', ')}`);
    syncStatus.phase = 'done';
  } catch (err) {
    syncStatus.phase = 'error';
    syncStatus.error = String(err.message || err);
    console.error('[autosync] error:', syncStatus.error);
  } finally {
    syncStatus.running = false;
    syncStatus.finishedAt = Date.now();
    // resumen persistente, para que sobreviva a un reinicio (como last_scan)
    setSetting(
      'auto_sync_last',
      JSON.stringify({
        at: Date.now(),
        trigger,
        checked: syncStatus.checked,
        removed: syncStatus.removed,
        removedTracks: syncStatus.removedTracks,
        removedSample: syncStatus.removedSample,
        skippedRoots: syncStatus.skippedRoots,
        blocked: syncStatus.blocked,
        error: syncStatus.error,
      })
    );
  }
  return syncStatus;
}

// ─────────────────────────────────── rutas ───────────────────────────────────

export function registerLibrarySync(app, { busy = () => false } = {}) {
  app.get('/api/quality/lists', async () => qualityListsSummary());

  app.get('/api/quality/list', async (req, reply) => {
    const { kind, rate } = req.query || {};
    try {
      let albums;
      if (kind === 'samplerate') albums = albumsAtSampleRate(rate);
      else if (kind === 'replaygain') albums = albumsWithoutReplaygain();
      else if (kind === 'cover') albums = albumsWithoutCover();
      else return reply.code(400).send({ error: 'Lista desconocida' });
      return { kind, total: albums.length, albums };
    } catch (err) {
      return reply.code(400).send({ error: String(err.message || err) });
    }
  });

  app.get('/api/autosync', async () => ({ status: syncStatus, last: lastResult() }));

  app.post('/api/autosync/run', async (req, reply) => {
    if (busy() || scanStatus.running || syncStatus.running) {
      return reply.code(409).send({ error: 'Espera a que termine la sincronización en curso' });
    }
    const confirmation = req.body?.confirmation;
    if (typeof confirmation !== 'string' || confirmation !== lastResult()?.blocked?.confirmation) {
      return reply.code(409).send({ error: 'La confirmación ya no está vigente. Vuelve a revisar las bajas.' });
    }
    reviewMissingAlbums({ confirmation }).catch((e) =>
      console.warn('[autosync] no se pudo confirmar la revisión:', String(e.message || e))
    );
    return { started: true };
  });
}
