import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Spinner, ErrorMsg, WantButton } from '../components.jsx';
import { curatorSourceId } from '../sources.js';

const fecha = d => d?.length === 10
  ? new Date(d+'T12:00:00Z').toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})
  : d;
const keyOf = r => JSON.stringify([r.artist_id,r.title.toLowerCase().trim()]);

export default function PersonalAgenda({off,onRadar}) {
  const [data,setData] = useState(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [revision,reload] = useState(0);
  useEffect(() => {
    let active=true;
    api.personalAgenda().then(d=>{if(active) setData(d);}).catch(e=>{if(active) setError(e.message);});
    return ()=>{active=false;};
  },[revision]);
  async function change(fn) {
    setBusy(true);
    setError('');
    try {await fn(); reload(n=>n+1);}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }
  if (!data) return error ? <ErrorMsg>{error}</ErrorMsg> : <Spinner />;
  const releases = new Map();
  for (const r of data.releases) {
    if (off.has(r.source)) continue;
    const key = r.rg_mbid || keyOf(r);
    if (!releases.has(key)) releases.set(key,r);
  }
  const mentions = new Map();
  for (const r of data.mentions) {
    if (off.has(curatorSourceId(r.source,r.username))) continue;
    const key = keyOf(r);
    if (!mentions.has(key)) mentions.set(key,{...r,curators:new Map()});
    const group = mentions.get(key);
    const id=curatorSourceId(r.source,r.username);
    if (!group.curators.has(id)) group.curators.set(id,r);
  }
  const today=new Date().toLocaleDateString('sv-SE');
  const entries=[...releases.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const renderRelease = r => <li className="py-2 border-b border-ink-800" key={r.rg_mbid || keyOf(r)}>
    <strong>{r.artist} — {r.title}</strong><div className="text-sm text-neutral-400">{fecha(r.date)} · {r.source==='official'
      ? <a href={r.url} target="_blank" rel="noreferrer" className="underline">Anuncio oficial</a> : 'Primera publicación · MusicBrainz'}</div>
    <WantButton artist={r.artist} title={r.title} rg_mbid={r.rg_mbid} releaseDate={r.date} origin="calendario" /></li>;
  return <div className="space-y-4">
    {error && <ErrorMsg>{error}</ErrorMsg>}
    <details className="card p-3"><summary className="cursor-pointer">Mis artistas · {data.artists.length}</summary>
      <p className="text-sm mt-2">Artistas seguidos en Liderarrr y monitorizados en la última sincronización de Lidarr.</p>
      <p className="text-sm text-neutral-400 my-2">{data.artists.map(a=>a.name).join(' · ')}</p>
      {!!data.suggestions.length && <><h3>De tu colección y tus escuchas</h3><div className="flex flex-wrap gap-2 mt-2">{data.suggestions.map(a=>
        <button className="btn" key={a.id || a.name} disabled={busy} onClick={()=>change(()=>a.id ? api.follow(a.id,'artist') : api.followSuggestion(a.name))}>
          + Seguir a {a.name} · {a.plays ? a.plays+' escuchas' : a.albums+' discos'}</button>)}</div></>}
    </details>
    <section className="card p-4"><h2 className="font-display text-lg">Lanzamientos de mis artistas</h2>
      {[['Próximos',entries.filter(r=>r.date>=today.slice(0,r.date.length))],
        ['Últimos 30 días',entries.filter(r=>r.date<today.slice(0,r.date.length)).reverse()]].map(([label,rows])=>
        <div key={label} className="mt-3"><h3 className="text-gold-300">{label}</h3>{rows.length ? <ul>{rows.map(renderRelease)}</ul> :
          <p className="text-sm text-neutral-400">Sin lanzamientos con las fuentes seleccionadas.</p>}</div>)}
      {!!data.artists.length && <details className="mt-4"><summary className="cursor-pointer">Añadir anuncio del artista o sello</summary>
        <form className="flex flex-wrap gap-2 mt-2" onSubmit={e=>{e.preventDefault();const form=e.currentTarget;
          const values=Object.fromEntries(new FormData(form));change(async()=>{await api.addAnnouncement(values);form.reset();});}}>
          <select className="bg-ink-850" aria-label="Artista" name="artist_id">{data.artists.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <input required name="title" aria-label="Título del disco" placeholder="Título del disco" className="bg-ink-850"/>
          <input required name="date" type="date" aria-label="Fecha de lanzamiento" className="bg-ink-850"/>
          <input required name="url" type="url" aria-label="Enlace oficial" placeholder="Enlace oficial" className="bg-ink-850"/>
          <button className="btn" disabled={busy}>Guardar anuncio</button></form></details>}
    </section>
    <section className="card p-4"><h2 className="font-display text-lg">Mis artistas en los curadores</h2>
      <p className="text-sm text-neutral-400">Recomendaciones de los últimos 30 días.</p>
      {[...mentions.values()].map(r=><article key={keyOf(r)} className="py-2 border-b border-ink-800">
        <strong>{r.artist} — {r.title}</strong>{r.original && ' · '+r.original.slice(0,4)}
        {[...r.curators.values()].map(c=><div className="text-sm" key={curatorSourceId(c.source,c.username)}>Recomendado el {fecha(c.date)} · {c.url ?
          <a className="underline" href={c.url} target="_blank" rel="noreferrer">{c.curator || c.username}</a> : c.curator || c.username}</div>)}
      </article>)}
      {!mentions.size && <p className="text-sm my-2">Sin recomendaciones recientes para tus artistas en los curadores seleccionados.</p>}
      <button className="btn mt-2" onClick={onRadar}>Explorar Radar y seguir artistas</button>
    </section>
  </div>;
}
