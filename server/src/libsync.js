import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import { splitRoots, isJunkEntry } from './libkey.js';
import { runScan, scanStatus } from './scanner.js';
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
//  2. SINCRONIZACIÓN AUTOMÁTICA — el comportamiento de Lidarr: cada cierto tiempo escanea la
//     biblioteca (incremental) y, después, quita de la BASE DE DATOS los álbumes cuyos
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
  phase: 'idle', // idle | scanning | pruning | done | error
  trigger: null, // auto | manual
  startedAt: null,
  finishedAt: null,
  checked: 0,
  removed: 0,
  removedTracks: 0,
  removedSample: [],
  skippedRoots: [],
  blocked: null, // { count, evaluated, sample } cuando la salvaguarda frena la poda
  scanError: null,
  error: null,
};

export function autoSyncConfig() {
  return {
    // activo por defecto: es justo lo que se pidió («como Lidarr, sin que yo haga nada»).
    // Se apaga con auto_sync_enabled = 0.
    enabled: getSetting('auto_sync_enabled') !== '0',
    intervalMin: Math.max(5, Number(getSetting('auto_sync_interval_min')) || 60),
    lastRun: Number(getSetting('auto_sync_last_run') || 0) || null,
  };
}

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
  if (largeBatch && confirmation !== token) {
    out.blocked = {
      confirmation: token,
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

// El ciclo completo: escanear (incremental) y después podar. `scan:false` solo poda
// (lo usa «Eliminar igualmente», que ya viene de un escaneo reciente).
let activeSync = null;

export function runAutoSync(options = {}) {
  if (activeSync) return activeSync;
  activeSync = performAutoSync(options).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function performAutoSync({ confirmation = null, scan = true, trigger = 'manual', changedDirs } = {}) {
  Object.assign(syncStatus, {
    running: true,
    phase: scan ? 'scanning' : 'pruning',
    trigger,
    startedAt: Date.now(),
    finishedAt: null,
    checked: 0,
    removed: 0,
    removedTracks: 0,
    removedSample: [],
    skippedRoots: [],
    blocked: null,
    scanError: null,
    error: null,
  });
  try {
    if (scan && !scanStatus.running) {
      await runScan({ changedDirs });
      syncStatus.scanError = scanStatus.error || null;
    }
    syncStatus.phase = 'pruning';
    // si hay un escaneo en marcha (el de otro proceso: botón, refresco nocturno) no se poda
    // a la vez; el siguiente ciclo lo hará.
    if (!scanStatus.running && !syncStatus.scanError) {
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
    }
    syncStatus.phase = 'done';
  } catch (err) {
    syncStatus.phase = 'error';
    syncStatus.error = String(err.message || err);
    console.error('[autosync] error:', syncStatus.error);
  } finally {
    syncStatus.running = false;
    syncStatus.finishedAt = Date.now();
    setSetting('auto_sync_last_run', String(Date.now()));
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
        scanError: syncStatus.scanError,
        error: syncStatus.error,
      })
    );
  }
  return syncStatus;
}

// Agrupa ráfagas de cambios y conserva el escaneo periódico para montajes que
// no propagan al contenedor los cambios hechos desde otra máquina.
export function startLibraryWatcher({ busy = () => false, settleMs = 5000 } = {}) {
  const watchers = new Map();
  let pending = new Set();
  let pendingSince = 0;
  let dueAt = 0;
  let timer;
  const startedAt = Date.now();

  function tick() {
    clearTimeout(timer);
    const config = autoSyncConfig();
    const roots = new Set(config.enabled ? splitRoots(getSetting('music_dirs')) : []);
    for (const [root, watcher] of watchers) {
      if (roots.has(root)) continue;
      watcher.close();
      watchers.delete(root);
    }
    if (!roots.size) {
      pending.clear();
      pendingSince = 0;
      return;
    }
    for (const root of roots) {
      if (watchers.has(root)) continue;
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (event, filename) => {
          if (event === 'change' && filename && !AUDIO_EXT.has(path.extname(filename).toLowerCase())) return;
          pending.add(filename ? path.dirname(path.resolve(root, filename)) : path.resolve(root));
          pendingSince ||= Date.now();
          dueAt = Math.min(Date.now() + settleMs, pendingSince + 60_000);
          clearTimeout(timer);
          timer = setTimeout(tick, Math.max(0, dueAt - Date.now())).unref();
        });
        watchers.set(root, watcher);
        watcher.on('close', () => {
          if (watchers.get(root) === watcher) watchers.delete(root);
        });
        watcher.on('error', () => watcher.close());
      } catch {
        // Ruta todavía sin montar o un sistema sin vigilancia. Se reintenta en el siguiente tick.
      }
    }

    const periodicDue = config.lastRun
      ? Date.now() >= config.lastRun + config.intervalMin * 60_000
      : Date.now() >= startedAt + 10 * 60_000;
    if (pending.size && Date.now() < dueAt) {
      timer = setTimeout(tick, dueAt - Date.now()).unref();
      return;
    }
    if (!pending.size && !periodicDue) return;
    if (syncStatus.running || scanStatus.running || busy()) {
      timer = setTimeout(tick, settleMs).unref();
      return;
    }

    const changedDirs = pending;
    pending = new Set();
    pendingSince = 0;
    runAutoSync({ trigger: changedDirs.size ? 'watch' : 'auto', changedDirs })
      .catch((e) => console.warn('[autosync] ciclo falló:', String(e.message || e)));
  }

  const polling = setInterval(tick, 60_000).unref();
  tick();
  return () => {
    clearInterval(polling);
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}

// ─────────────────────────────────── rutas ───────────────────────────────────

export function registerLibrarySync(app) {
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

  app.get('/api/autosync', async () => ({ ...autoSyncConfig(), status: syncStatus, last: lastResult() }));

  app.post('/api/autosync/config', async (req) => {
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') setSetting('auto_sync_enabled', b.enabled ? '1' : '0');
    if (b.intervalMin != null) {
      const m = Math.round(Number(b.intervalMin));
      if (Number.isFinite(m)) setSetting('auto_sync_interval_min', String(Math.min(1440, Math.max(5, m))));
    }
    return { ...autoSyncConfig(), status: syncStatus, last: lastResult() };
  });

  // En segundo plano: un escaneo + poda en una biblioteca grande por red tarda minutos. La
  // UI sigue el progreso sondeando /api/autosync.
  app.post('/api/autosync/run', async (req) => {
    const b = req.body || {};
    runAutoSync({ confirmation: b.confirmation, scan: b.scan !== false, trigger: 'manual' }).catch((e) =>
      console.warn('[autosync] ciclo manual falló:', String(e.message || e))
    );
    return { started: true, status: syncStatus };
  });

}
