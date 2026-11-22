import test from 'node:test';
import assert from 'node:assert/strict';
import {agendaEvents} from '../../web/src/agenda.js';

const enabled = {radar:true,label:true,novedad:true,recent:true};
const get = (data,section,format='all') => agendaEvents(data,enabled,new Set(),format,section);
const old = {artist:'The Beatles',title:'Revolver',rg_mbid:'r',first_release:'1966-08-05'};
test('Una mención reciente conserva la fecha de la lista en Radar', () => {
  const data = {radar:[{...old,list_date:'2026-11-20', release_date:'1966-08-05'}]};
  assert.deepEqual(get(data,'new'),[]);
  assert.equal(get(data,'radar')[0].date,'2026-11-20');
});
test('Una edición posterior con original conocido entra en reediciones', () => {
  assert.equal(get({novedad:[{...old,release_date:'2026-11-20'}]},'reissue').length,1);
  assert.equal(get({novedad:[{artist:'A',title:'B',release_date:'2026-11-20'}]},'unknown').length,1);
});
test('EP anunciado por el sello conserva el mes y reúne las fuentes', () => {
  const r = {artist:'A',title:'B',first_release:'2027-02',primary_type:'EP',secondary_types:'["Live"]',rg_mbid:'x'};
  const data = {label:[{...r,labels:'Sello'}],recent:[r]};
  for (const format of ['ep','live']) {
    const events = get(data,'new',format);
    assert.equal(events.length,1);
    assert.equal(events[0].date,'2027-02');
    assert.equal(events[0].origins.length,2);
  }
});
