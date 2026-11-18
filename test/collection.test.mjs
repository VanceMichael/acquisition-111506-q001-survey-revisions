import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, digest } from '../src/store.mjs';
import { createSourceClient, SourceError } from '../src/source-client.mjs';
import { runCollection } from '../src/collector.mjs';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

// 包装真实合作来源：可让指定附件持续 503，或返回被篡改的字节；同时记录请求方法。
async function startProxy(upstreamUrl, { alwaysFailAttachment = null, corruptAttachment = null } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname });
    const isAttachment = url.pathname.startsWith('/survey/') && url.pathname.includes('/photo.jpg');
    if (isAttachment && alwaysFailAttachment && url.searchParams.get('rev') === alwaysFailAttachment) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      return response.end(JSON.stringify({ error: 'temporary' }));
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(`${upstreamUrl}${request.url}`, { method: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    if (isAttachment && corruptAttachment && url.searchParams.get('rev') === corruptAttachment) {
      response.writeHead(200, { 'content-type': 'image/jpeg' });
      return response.end(Buffer.from('tampered1234')); // 12 字节，长度通过但 MD5 必不匹配
    }
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test('完整采集：带回全部叶修订、胜出标记、冲突与三类去向', async () => {
  const directory = await tempDir('collect-full-');
  const provider = await startProvider();
  try {
    const store = await openStore(directory);
    const source = createSourceClient(provider.url);
    const report = await runCollection(store, source, { baseDelayMs: 1 });

    assert.equal(report.status, 'complete');
    assert.equal(report.lastSeq, 'opaque:compact'); // 不透明字符串原样作为检查点
    assert.equal(report.revisions.available, 2);
    assert.equal(report.revisions.deleted, 1);
    assert.equal(report.revisions.compacted, 1);
    assert.equal(report.blocked.length, 0);

    const state = store.collectionState();
    assert.equal(state.checkpoint.sourceSeq, 'opaque:compact');
    const s17 = state.documents.find(doc => doc.id === 'survey-17');
    const s18 = state.documents.find(doc => doc.id === 'survey-18');

    // 合作方当前选出的版本（默认 style 胜出修订）被保留且明确标记
    assert.equal(s17.winningRev, '2-east');
    assert.deepEqual(s17.liveLeafRevs, ['2-east']); // 最后状态只有一个存活叶
    assert.deepEqual(s17.deletedLeafRevs, ['3-deleted']); // 墓碑不抹掉存活内容
    assert.equal(s17.hasUnresolvedConflict, false); // 墓碑产生后冲突在来源侧已收口
    // 但复核人员仍能看到曾经并列的冲突分支
    assert.equal(s17.conflictNotices.length, 2);
    assert.deepEqual([...s17.conflictNotices[0].leafRevs].sort(), ['2-east', '2-west']);

    const byRev = Object.fromEntries(s17.branches.map(branch => [branch.rev, branch]));
    // 通知里出现过的全部修订都留存，包括已变成祖先的历史分支 2-west
    assert.deepEqual(s17.branches.map(branch => branch.rev).sort(), ['2-east', '2-west', '3-deleted']);
    assert.equal(byRev['2-west'].isCurrentLeaf, false);
    assert.equal(byRev['3-deleted'].disposition, 'deleted');
    assert.equal(byRev['3-deleted'].record, null);
    assert.deepEqual(byRev['3-deleted'].ancestors, ['2-west', '1-root']);
    assert.equal(byRev['2-west'].disposition, 'available');
    assert.equal(byRev['2-east'].isCurrentLeaf, true);
    assert.equal(byRev['2-east'].disposition, 'available');
    assert.deepEqual(byRev['2-east'].record.answers, { households: 7 });

    // 同名附件分属不同修订，内容不同、归属独立
    const westPhoto = byRev['2-west'].attachments.find(item => item.name === 'photo.jpg');
    const eastPhoto = byRev['2-east'].attachments.find(item => item.name === 'photo.jpg');
    assert.equal(westPhoto.state, 'available');
    assert.equal(eastPhoto.state, 'available');
    assert.notEqual(westPhoto.sha256, eastPhoto.sha256);
    assert.equal(westPhoto.length, 12);
    const westBytes = await store.evidence(westPhoto.sha256);
    assert.equal(westBytes.toString(), 'west-photo17');
    const eastBytes = await store.evidence(eastPhoto.sha256);
    assert.equal(eastBytes.toString(), 'east-photo17');

    // 压缩清理的修订只留通知证据，不补空答卷
    assert.equal(s18.branches[0].disposition, 'compacted');
    assert.equal(s18.branches[0].record, null);
    assert.match(s18.branches[0].reason, /missing/);

    // 文档原文也按内容寻址留存，可回查
    const revisionState = store.collectionRevision('survey-17', '2-west');
    assert.equal(revisionState.docSha256, digest(Buffer.from(JSON.stringify(revisionState.record), 'utf8')));
    assert.deepEqual((await store.evidence(revisionState.docSha256)).toString(), JSON.stringify(revisionState.record));

    // 对来源只发起读请求：GET 与 _bulk_get（只读批量读取），没有任何写文档类调用
    const methods = new Set(provider.events.map(event => event.method));
    assert.deepEqual([...methods].sort(), ['GET', 'POST']);
    for (const event of provider.events) {
      if (event.method === 'POST') assert.equal(event.path, '/survey/_bulk_get');
    }
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重采复用已取得照片且保持归属，不重复下载', async () => {
  const directory = await tempDir('collect-resume-');
  const provider = await startProvider();
  try {
    const store = await openStore(directory);
    const first = await runCollection(store, createSourceClient(provider.url), { baseDelayMs: 1 });
    assert.equal(first.status, 'complete');
    const stateAfterFirst = store.collectionState();
    const shas = stateAfterFirst.documents.flatMap(doc => doc.branches.flatMap(branch => branch.attachments.map(item => item.sha256)));
    assert.equal(new Set(shas).size, 2);

    const second = await runCollection(store, createSourceClient(provider.url), { baseDelayMs: 1 });
    assert.equal(second.status, 'complete');
    assert.equal(second.attachments.fetched, 0);
    assert.equal(second.attachments.reused, 2);
    // 重开存储后 journal 重放，归属仍然对应答卷与具体修订
    const reopened = await openStore(directory);
    const view = reopened.collectionState();
    const s17 = view.documents.find(doc => doc.id === 'survey-17');
    const pairs = s17.branches.flatMap(branch => branch.attachments.map(item => `${branch.rev}/${item.name}/${item.sha256}`));
    const expected = new Set(shas.map(sha => sha).filter(Boolean));
    assert.equal(pairs.length, 2);
    for (const pair of pairs) {
      const [rev, , sha] = pair.split('/');
      assert.ok(['2-west', '2-east'].includes(rev));
      assert.ok(expected.has(sha));
    }
    assert.notEqual(pairs[0].split('/')[2], undefined);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('附件持续暂时不可用：记录状态且检查点不得越过该修订', async () => {
  const directory = await tempDir('collect-blocked-');
  const provider = await startProvider();
  const proxy = await startProxy(provider.url, { alwaysFailAttachment: '2-east' });
  try {
    const store = await openStore(directory);
    const report = await runCollection(store, createSourceClient(proxy.url), { baseDelayMs: 1, maxAttempts: 2 });
    assert.equal(report.status, 'blocked');
    assert.equal(report.blocked[0].reason, 'attachment_temporarily_unavailable');
    // 第一页尚有未说明去向的修订，检查点停在初始 seq，没有把 last_seq 落盘
    assert.equal(store.collectionState().checkpoint.sourceSeq, '0');

    const s17 = store.collectionState().documents.find(doc => doc.id === 'survey-17');
    const east = s17.branches.find(branch => branch.rev === '2-east');
    const photo = east.attachments.find(item => item.name === 'photo.jpg');
    assert.equal(photo.state, 'unavailable');
    assert.equal(photo.sha256, null); // 绝不伪造字节
    // 同答卷已取得的其他分支内容仍然存活
    const west = s17.branches.find(branch => branch.rev === '2-west');
    assert.equal(west.attachments[0].state, 'available');

    // 恢复来源后重采：同一次采集内完成重试并越过尾部
    const recovered = await runCollection(store, createSourceClient(provider.url), { baseDelayMs: 1 });
    assert.equal(recovered.status, 'complete');
    assert.equal(store.collectionState().checkpoint.sourceSeq, 'opaque:compact');
  } finally {
    await proxy.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源首次503后恢复：有界重试后成功，不阻塞检查点', async () => {
  const directory = await tempDir('collect-retry-');
  const provider = await startProvider();
  try {
    const store = await openStore(directory);
    const report = await runCollection(store, createSourceClient(provider.url), { baseDelayMs: 1, maxAttempts: 3 });
    assert.equal(report.status, 'complete');
    assert.equal(report.attachments.unavailable, 0);
    const east = store.collectionState().documents
      .find(doc => doc.id === 'survey-17').branches.find(branch => branch.rev === '2-east')
      .attachments.find(item => item.name === 'photo.jpg');
    assert.equal(east.state, 'available');
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('附件摘要核对失败：拒绝保存字节并阻塞推进', async () => {
  const directory = await tempDir('collect-integrity-');
  const provider = await startProvider();
  const proxy = await startProxy(provider.url, { corruptAttachment: '2-west' });
  try {
    const store = await openStore(directory);
    const report = await runCollection(store, createSourceClient(proxy.url), { baseDelayMs: 1 });
    assert.equal(report.status, 'blocked');
    assert.equal(report.attachments.integrityFailures, 1);
    assert.equal(store.collectionState().checkpoint.sourceSeq, '0');
    const photo = store.collectionAttachment('survey-17', '2-west', 'photo.jpg');
    assert.equal(photo.state, 'unavailable');
    assert.match(photo.reason, /MD5/);
  } finally {
    await proxy.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源客户端只读：仅暴露声明的读取入口，没有写入文档的方法', async () => {
  const source = createSourceClient('http://127.0.0.1:1');
  for (const name of ['put', 'post', 'remove', 'delete', 'update', 'bulkDocs', 'save', 'insert']) {
    assert.equal(source[name], undefined);
  }
  assert.equal(typeof source.changes, 'function');
  assert.equal(typeof source.bulkGet, 'function');
  assert.equal(typeof source.attachment, 'function');
  // 网络不可达应包装成暂时性来源错误，而不是裸异常
  await assert.rejects(source.changes('0'), error => error instanceof SourceError && error.transient === true);
});

test('HTTP 采集入口、复核视图与附件回查端到端', async () => {
  const directory = await tempDir('collect-api-');
  const provider = await startProvider();
  const application = await startApplication({ directory, sourceUrl: provider.url });
  try {
    const run = await fetch(`${application.url}/api/collection/run`, { method: 'POST', body: JSON.stringify({ baseDelayMs: 1 }) });
    assert.equal(run.status, 200);
    const report = await run.json();
    assert.equal(report.status, 'complete');

    const state = await (await fetch(`${application.url}/api/collection`)).json();
    const s17 = state.documents.find(doc => doc.id === 'survey-17');
    assert.equal(s17.winningRev, '2-east');
    // 冲突过程对复核人员可见，所有通知过的分支都在复核视图里
    assert.equal(s17.conflictNotices.length, 2);
    assert.equal(s17.branches.length, 3);
    const east = s17.branches.find(branch => branch.rev === '2-east');
    const photo = east.attachments[0];

    const bytes = await fetch(`${application.url}/api/collection/attachment?id=survey-17&rev=2-east&name=photo.jpg`);
    assert.equal(bytes.status, 200);
    assert.equal((await bytes.text()), 'east-photo17');

    const missing = await fetch(`${application.url}/api/collection/attachment?id=survey-18&rev=3-lost&name=photo.jpg`);
    assert.equal(missing.status, 404);

    // 既有手工入口与采集结果互不干扰
    assert.ok(Array.isArray(await (await fetch(`${application.url}/api/records`)).json()));
  } finally {
    await application.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('采集状态只追加持久化：重开进程后检查点、去向与附件归属完整保持', async () => {
  const directory = await tempDir('collect-persist-');
  const provider = await startProvider();
  try {
    const store = await openStore(directory);
    const report = await runCollection(store, createSourceClient(provider.url), { baseDelayMs: 1 });
    assert.equal(report.status, 'complete');
    await store.flush();

    const reopened = await openStore(directory);
    const view = reopened.collectionState();
    assert.equal(view.checkpoint.sourceSeq, 'opaque:compact');
    const s17 = view.documents.find(doc => doc.id === 'survey-17');
    const s18 = view.documents.find(doc => doc.id === 'survey-18');
    assert.deepEqual(s17.deletedLeafRevs, ['3-deleted']);
    assert.deepEqual(s18.unavailableLeafRevs, ['3-lost']);
    // 附件 blob 可按记录里的 sha256 取回，且归属修订正确
    const east = s17.branches.find(branch => branch.rev === '2-east').attachments[0];
    assert.equal((await reopened.evidence(east.sha256)).toString(), 'east-photo17');
    // 人工收件 journal 与采集 journal 相互独立
    assert.equal(reopened.list().length, 0);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('采集 CLI：来源不可达退出 1，阻塞场景退出 2 且检查点不推进', async () => {
  const { spawn } = await import('node:child_process');
  const directory = await tempDir('collect-cli-');
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/collect.mjs', ...args], { cwd: '/workspace', env: { ...process.env, DATA_DIR: directory } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });

  const provider = await startProvider();
  const proxy = await startProxy(provider.url, { alwaysFailAttachment: '2-east' });
  try {
    const blocked = await run([proxy.url]);
    assert.equal(blocked.code, 2);
    const blockedReport = JSON.parse(blocked.stdout);
    assert.equal(blockedReport.status, 'blocked');
    const store = await openStore(directory);
    assert.equal(store.collectionState().checkpoint.sourceSeq, '0');

    const down = await run(['http://127.0.0.1:9']);
    assert.equal(down.code, 1);
    assert.match(down.stderr, /来源请求失败/);
    assert.equal(store.collectionState().checkpoint.sourceSeq, '0'); // 失败不留半推进检查点
  } finally {
    await proxy.close();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
