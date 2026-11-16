// 只读来源客户端：仅使用 docs/source-contract.md 声明的交互入口，不向来源写入任何内容
export function createSourceClient(baseUrl, fetchImpl = globalThis.fetch) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const call = async (path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, options);
    } catch (error) {
      return { ok: false, transport: true, error: error.message };
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  };
  return {
    // 变更通知：since 是不透明续读凭据；all_docs 列出叶修订
    changes: since => call(`/survey/_changes?since=${encodeURIComponent(since)}&style=all_docs`),
    bulkGet: refs => call('/survey/_bulk_get', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docs: refs }),
    }),
    document: (id, rev) => call(`/survey/${encodeURIComponent(id)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`),
    openRevs: id => call(`/survey/${encodeURIComponent(id)}?open_revs=all`),
    async attachment(id, name, rev) {
      let response;
      try {
        response = await fetchImpl(`${base}/survey/${encodeURIComponent(id)}/${encodeURIComponent(name)}?rev=${encodeURIComponent(rev)}`);
      } catch (error) {
        return { ok: false, transport: true, error: error.message };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { ok: response.ok, status: response.status, bytes };
    },
  };
}
