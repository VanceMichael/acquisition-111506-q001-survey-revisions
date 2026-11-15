
import { readFile } from 'node:fs/promises';
import { serve, json, bytes, readBody } from './http.mjs';
const revisions = JSON.parse(await readFile(new URL('../fixtures/revisions.json', import.meta.url)));
const photos = JSON.parse(await readFile(new URL('../fixtures/photos.json', import.meta.url)));

export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/survey/_changes') {
      const since = url.searchParams.get('since') ?? '0';
      const all = url.searchParams.get('style') === 'all_docs';
      const pages = {
        '0': { results: [{ seq: '7-g1:west', id: 'survey-17', changes: all ? [{ rev: '2-west' }, { rev: '2-east' }] : [{ rev: '2-west' }] }], last_seq: '7-g1:west', pending: 2 },
        '7-g1:west': { results: [{ seq: '2-g2:east', id: 'survey-17', changes: all ? [{ rev: '3-deleted' }, { rev: '2-east' }] : [{ rev: '2-east' }] }, { seq: 'opaque:compact', id: 'survey-18', changes: [{ rev: '3-lost' }] }], last_seq: 'opaque:compact', pending: 0 },
        'opaque:compact': { results: [], last_seq: 'opaque:compact', pending: 0 },
      };
      return json(response, pages[since] ?? { error: 'bad_since' }, pages[since] ? 200 : 400);
    }
    if (url.pathname === '/survey/_bulk_get' && request.method === 'POST') {
      const body = JSON.parse((await readBody(request)).toString());
      return json(response, { results: body.docs.map(ref => ({ id: ref.id, docs: [revisions[ref.rev] ? { ok: revisions[ref.rev] } : { error: { id: ref.id, rev: ref.rev, error: 'not_found', reason: 'missing' } }] })) });
    }
    if (url.pathname === '/survey/survey-17/photo.jpg') {
      const revision = url.searchParams.get('rev');
      if (!revision || !photos[revision]) return json(response, { error: 'not_found' }, 404);
      const count = (state[revision] ?? 0) + 1;
      state[revision] = count;
      if (revision === '2-east' && count === 1) return json(response, { error: 'temporary' }, 503, { 'retry-after': '0' });
      return bytes(response, Buffer.from(photos[revision], 'base64'), 'image/jpeg', 200, { etag: `"${revision}"` });
    }
    if (url.pathname === '/survey/survey-17') {
      const revision = url.searchParams.get('rev') ?? '2-east';
      if (url.searchParams.has('open_revs')) {
        const requested = url.searchParams.get('open_revs') === 'all' ? ['3-deleted', '2-east'] : JSON.parse(url.searchParams.get('open_revs'));
        return json(response, requested.map(rev => revisions[rev] ? { ok: revisions[rev] } : { missing: rev }));
      }
      return json(response, revisions[revision] ?? { error: 'not_found' }, revisions[revision] ? 200 : 404);
    }
    return false;
  }, options);
}
