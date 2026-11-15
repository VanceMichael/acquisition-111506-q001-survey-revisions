import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const first = await (await fetch(`${source.url}/survey/_changes?style=all_docs`)).json();
    assert.equal(first.results[0].changes.length, 2);
    const next = await (await fetch(`${source.url}/survey/_changes?since=${encodeURIComponent(first.last_seq)}&style=all_docs`)).json();
    assert.equal(next.last_seq, 'opaque:compact');
    const deleted = await (await fetch(`${source.url}/survey/survey-17?rev=3-deleted`)).json();
    assert.equal(deleted._deleted, true);
    assert.equal((await fetch(`${source.url}/survey/survey-17/photo.jpg?rev=2-east`)).status, 503);
    assert.equal((await fetch(`${source.url}/survey/survey-17/photo.jpg?rev=2-east`)).status, 200);
  } finally { await source.close(); }
});
