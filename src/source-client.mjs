// 合作来源（CouchDB 风格）的只读客户端。
// 只使用声明的交互入口：GET _changes、POST _bulk_get、按 rev 读文档与附件。
// 本模块不提供任何写操作，所有方法都不会向来源发送 PUT/POST 写文档类请求
// （_bulk_get 是 CouchDB 规定的只读批量读取入口）。

const READ_METHODS = new Set(['GET', 'HEAD']);

export class SourceError extends Error {
  constructor(message, { status, transient = false, url, cause } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.transient = transient;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

export function createSourceClient(baseUrl, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  async function request(method, path, { body, headers } = {}) {
    if (!READ_METHODS.has(method) && !(method === 'POST' && path.endsWith('/_bulk_get'))) {
      throw new Error(`来源客户端拒绝非只读请求：${method} ${path}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      throw new SourceError(`来源请求失败：${method} ${path}：${error.message}`, { transient: true, url: `${base}${path}`, cause: error });
    } finally {
      clearTimeout(timer);
    }
    return response;
  }

  return {
    baseUrl: base,
    // seq 是不透明字符串，调用方只能把上一页的 last_seq 原样带回 since。
    async changes(since, { style = 'all_docs' } = {}) {
      const params = new URLSearchParams({ since: String(since) });
      if (style) params.set('style', style);
      const response = await request('GET', `/survey/_changes?${params}`);
      if (!response.ok) {
        throw new SourceError(`变更入口返回 ${response.status}`, {
          status: response.status,
          transient: response.status >= 500,
          url: response.url,
        });
      }
      return response.json();
    },

    // 返回 Map(rev -> { ok? | missing? | error? })，missing 代表压缩清理后正文不可得。
    async bulkGet(id, revs) {
      const response = await request('POST', '/survey/_bulk_get', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docs: revs.map(rev => ({ id, rev })) }),
      });
      if (!response.ok) {
        throw new SourceError(`批量读取入口返回 ${response.status}`, {
          status: response.status,
          transient: response.status >= 500,
          url: response.url,
        });
      }
      const payload = await response.json();
      const result = new Map();
      for (const entry of payload.results ?? []) {
        for (const item of entry.docs ?? []) {
          if (item.ok) result.set(item.ok._rev, { ok: item.ok });
          else if (item.missing) result.set(item.missing, { missing: item.missing });
          // CouchDB 语义：bulk_get 的 not_found 表示该修订正文已不可得（常见于压缩清理）。
          else if (item.error?.error === 'not_found') result.set(item.error.rev, { missing: item.error.rev, reason: item.error.reason });
          else result.set(item.error?.rev ?? 'unknown', { error: item.error });
        }
      }
      return result;
    },

    // 附件按 (id, name, rev) 取；5xx/网络失败是暂时不可用，不是删除。
    async attachment(id, name, rev) {
      const params = new URLSearchParams({ rev });
      const response = await request('GET', `/survey/${encodeURIComponent(id)}/${encodeURIComponent(name)}?${params}`);
      const retryAfter = response.headers.get('retry-after');
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          transient: response.status >= 500,
          retryAfter,
        };
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return { ok: true, status: response.status, bytes, mediaType: response.headers.get('content-type') ?? 'application/octet-stream' };
    },
  };
}
