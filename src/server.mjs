
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { validateRecord, product } from './domain.mjs';
import { createSourceClient } from './source-client.mjs';
import { runCollection } from './collector.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1', sourceUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4311' } = {}) {
  const store = await openStore(directory);
  let collectionRun = null;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      // 自动采集状态：复核视图，含每个答卷的存活叶、墓碑、压缩清理与附件去向。
      if (request.method === 'GET' && url.pathname === '/api/collection') return sendJson(response, 200, store.collectionState());
      // 触发一次只读自动采集；并发触发共用同一次运行。
      if (request.method === 'POST' && url.pathname === '/api/collection/run') {
        const body = await readJson(request).catch(() => ({}));
        const targetUrl = typeof body?.sourceUrl === 'string' && body.sourceUrl.trim() ? body.sourceUrl : sourceUrl;
        if (!collectionRun) {
          const source = createSourceClient(targetUrl, { timeoutMs: Number(body?.timeoutMs) || 15000 });
          collectionRun = runCollection(store, source, {
            maxAttempts: Number(body?.maxAttempts) || 3,
            baseDelayMs: Number(body?.baseDelayMs) || 50,
          }).then(report => ({ report }), error => ({ error })).finally(() => { collectionRun = null; });
        }
        const outcome = await collectionRun;
        if (outcome.error) throw outcome.error;
        return sendJson(response, outcome.report.status === 'blocked' ? 202 : 200, outcome.report);
      }
      // 回查采集到的修订状态与结构化内容。
      if (request.method === 'GET' && url.pathname === '/api/collection/revision') {
        const id = url.searchParams.get('id');
        const rev = url.searchParams.get('rev');
        const state = store.collectionRevision(id, rev);
        if (!state) return sendJson(response, 404, { error: '未采集到该修订' });
        return sendJson(response, 200, state);
      }
      // 回查采集到的附件字节；暂时不可用或无字节的分支返回明确状态而非 404 冒充删除。
      if (request.method === 'GET' && url.pathname === '/api/collection/attachment') {
        const id = url.searchParams.get('id');
        const rev = url.searchParams.get('rev');
        const name = url.searchParams.get('name');
        const state = store.collectionAttachment(id, rev, name);
        if (!state) return sendJson(response, 404, { error: '该修订没有这个附件的采集记录' });
        if (state.state !== 'available') return sendJson(response, 409, { error: '附件尚未取得', state });
        const bytes = await store.evidence(state.sha256);
        response.writeHead(200, { 'content-type': state.mediaType ?? 'application/octet-stream' });
        return response.end(bytes);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      sendJson(response, status, { error: status === 500 ? '收件服务内部错误' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
