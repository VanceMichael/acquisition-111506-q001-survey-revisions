// 只读自动采集引擎：
// 顺着合作来源的 _changes 通知，把每个答卷的全部叶修订及其附件带回收件台。
// seq 仅作为不透明续读凭据原样传递，绝不参与比较或排序；
// 一页内只要有修订去向未说明（如附件暂时不可用），就不推进检查点。

import { createHash } from 'node:crypto';

export const TERMINAL_DISPOSITIONS = new Set(['available', 'deleted', 'compacted']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function md5Base64(bytes) {
  return createHash('md5').update(bytes).digest('base64');
}

function ancestorRevs(doc) {
  const info = doc._revisions;
  if (!info || !Array.isArray(info.ids)) return [];
  return info.ids.slice(1).map((id, index) => `${info.start - index - 1}-${id}`);
}

async function fetchWithRetries(fetchOnce, { maxAttempts, baseDelayMs }) {
  let attempt = 0;
  let last;
  while (attempt < maxAttempts) {
    attempt += 1;
    const outcome = await fetchOnce();
    if (outcome.ok || outcome.status < 500) return { ...outcome, attempts: attempt };
    last = outcome;
    if (attempt < maxAttempts) {
      const advertised = Number(outcome.retryAfter);
      const wait = Number.isFinite(advertised) && advertised >= 0
        ? Math.min(advertised * 1000, baseDelayMs * attempt)
        : baseDelayMs * attempt;
      await sleep(wait);
    }
  }
  return { ...last, attempts: attempt };
}

// 同一页分别用 all_docs（全部叶修订）与默认 style（合作方当前胜出修订）读取，
// 胜出信息只用于展示，绝不覆盖或删除收件台保留的其他分支。
async function readPagePair(source, since) {
  const allDocsPage = await source.changes(since, { style: 'all_docs' });
  const defaultPage = await source.changes(since, { style: 'main_only' });
  const winnerByRow = new Map();
  for (const row of defaultPage.results ?? []) {
    winnerByRow.set(`${row.id} ${row.seq}`, row.changes?.[0]?.rev ?? null);
  }
  return { allDocsPage, winnerByRow };
}

export async function runCollection(store, source, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxPages = options.maxPages ?? 1000;
  const startedAt = new Date().toISOString();
  const state0 = store.collectionState();
  const report = {
    status: 'complete',
    startedAt,
    finishedAt: null,
    fromSeq: state0.checkpoint.sourceSeq,
    lastSeq: state0.checkpoint.sourceSeq,
    pages: 0,
    rows: 0,
    noticesRecorded: 0,
    revisions: { available: 0, deleted: 0, compacted: 0, alreadyKnown: 0 },
    attachments: { fetched: 0, reused: 0, unavailable: 0, integrityFailures: 0 },
    blocked: [],
  };

  const processedInRun = new Set(); // 单次运行内已处理的 (id, rev)

  // 单个附件的核对与落盘；返回 true 表示本修订的附件存在未解决问题。
  async function collectAttachment(id, rev, name, stub) {
    const existing = store.collectionAttachment(id, rev, name);
    if (existing?.state === 'available') {
      report.attachments.reused += 1; // 内容寻址字节与归属记录都已存在，直接复用
      return false;
    }
    const fail = (reason, kind, code) => {
      report.attachments[kind] += 1;
      report.blocked.push({ id, rev, name, reason: code });
      return store.recordAttachment({
        id, rev, name, state: 'unavailable',
        mediaType: stub.content_type ?? null, length: stub.length ?? null,
        declaredMd5: stub.digest ?? null, sha256: null, reason,
      });
    };
    const outcome = await fetchWithRetries(() => source.attachment(id, name, rev), { maxAttempts, baseDelayMs });
    if (!outcome.ok) {
      // 暂时不可用：记录状态但不冒充删除，调用方据此阻止检查点越过。
      await fail(`来源返回 ${outcome.status}（暂时不可用，等待后续重采）`, 'unavailable', 'attachment_temporarily_unavailable');
      return true;
    }
    if (typeof stub.length === 'number' && outcome.bytes.length !== stub.length) {
      await fail(`长度核对失败：声明 ${stub.length}，实收 ${outcome.bytes.length}`, 'integrityFailures', 'length_mismatch');
      return true;
    }
    const declaredMd5 = stub.digest?.startsWith('md5-') ? stub.digest.slice(4) : null;
    if (declaredMd5 && md5Base64(outcome.bytes) !== declaredMd5) {
      await fail('MD5 摘要核对失败，拒绝保存来源声明不一致的字节', 'integrityFailures', 'md5_mismatch');
      return true;
    }
    // 收件端以 SHA256 内容寻址保存原文；同名附件在不同修订下是独立归属。
    const blob = await store.putBlob(outcome.bytes);
    await store.recordAttachment({
      id, rev, name, state: 'available',
      mediaType: stub.content_type ?? outcome.mediaType, length: outcome.bytes.length,
      declaredMd5: stub.digest ?? null, sha256: blob.sha256,
      reason: blob.reused ? '复用已存内容寻址字节' : null, httpStatus: 200,
    });
    report.attachments[blob.reused ? 'reused' : 'fetched'] += 1;
    return false;
  }

  // 单个修订的全部附件；返回未解决附件的数量。
  async function collectAttachmentsForRevision(id, rev) {
    const runKey = `${id} ${rev}`;
    if (processedInRun.has(runKey)) return 0;
    processedInRun.add(runKey);
    const current = store.collectionRevision(id, rev);
    if (!current || current.disposition !== 'available') return 0;
    let unresolved = 0;
    for (const [name, stub] of Object.entries(current.record?._attachments ?? {})) {
      if (await collectAttachment(id, rev, name, stub)) unresolved += 1;
    }
    return unresolved;
  }

  // 重采补全：对所有已采集的存活修订检查附件。已取得的照片在本地复用、不重复下载；
  // 此前暂时不可用的在此重试。归属始终对应答卷与具体修订，不依赖通知再次提及。
  for (const doc of store.collectionState().documents) {
    for (const branch of doc.branches) {
      await collectAttachmentsForRevision(doc.id, branch.rev);
    }
  }
  if (report.blocked.length) {
    report.status = 'blocked';
    report.finishedAt = new Date().toISOString();
    return report;
  }

  let since = state0.checkpoint.sourceSeq;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const { allDocsPage, winnerByRow } = await readPagePair(source, since);
    const rows = allDocsPage.results ?? [];
    let pageBlocked = false;

    for (const row of rows) {
      report.rows += 1;
      const leafRevs = (row.changes ?? []).map(change => change.rev);
      const winningRev = winnerByRow.get(`${row.id} ${row.seq}`) ?? null;
      const notice = await store.recordNotice({ id: row.id, seq: row.seq, leafRevs, winningRev });
      if (!notice.duplicate) report.noticesRecorded += 1;

      // 已在本地说明过去向的修订不再向来源重复拉取正文。
      const pendingRevs = leafRevs.filter(rev => {
        const known = store.collectionRevision(row.id, rev);
        return !(known && TERMINAL_DISPOSITIONS.has(known.disposition));
      });
      const fetched = pendingRevs.length ? await source.bulkGet(row.id, pendingRevs) : new Map();

      for (const rev of leafRevs) {
        const known = store.collectionRevision(row.id, rev);
        if (known && TERMINAL_DISPOSITIONS.has(known.disposition)) {
          if (!processedInRun.has(`${row.id} ${rev}`)) report.revisions.alreadyKnown += 1;
        } else {
          const item = fetched.get(rev);
          if (item?.missing) {
            // 去向一：压缩清理后正文不可得（bulk_get 的 missing/not_found），不能补成空答卷。
            await store.recordRevision({
              id: row.id, rev, disposition: 'compacted', deleted: false,
              reason: `来源返回 missing/not_found：修订正文已被压缩清理${item.reason ? `（${item.reason}）` : ''}`,
              record: null, docSha256: null, ancestors: [],
            });
            report.revisions.compacted += 1;
            continue;
          }
          if (item?.error) {
            await store.recordRevision({
              id: row.id, rev, disposition: 'compacted', deleted: false,
              reason: `来源返回 ${item.error.error ?? 'error'}：修订正文不可取得`,
              record: null, docSha256: null, ancestors: [],
            });
            report.revisions.compacted += 1;
            continue;
          }
          const doc = item?.ok;
          if (!doc) throw Object.assign(new Error(`修订 ${row.id}@${rev} 既无正文也无 missing 说明，去向不明，停止推进`), { status: 502 });
          if (doc._deleted === true) {
            // 去向二：真正的删除是具体修订上的墓碑；同答卷其他活叶内容继续保留。
            await store.recordRevision({
              id: row.id, rev, disposition: 'deleted', deleted: true,
              reason: '来源修订带 _deleted 墓碑', record: null, docSha256: null, ancestors: ancestorRevs(doc),
            });
            report.revisions.deleted += 1;
            continue;
          }
          // 去向三：正文可取得。原始 JSON 字节与结构化内容都留存并可回查。
          const rawBytes = Buffer.from(JSON.stringify(doc), 'utf8');
          const blob = await store.putBlob(rawBytes);
          await store.recordRevision({
            id: row.id, rev, disposition: 'available', deleted: false, reason: null,
            record: structuredClone(doc), docSha256: blob.sha256, ancestors: ancestorRevs(doc),
          });
          report.revisions.available += 1;
        }

        // 附件：只对正文存活的修订；归属始终绑定 (答卷, 修订, 附件名)。
        const unresolved = await collectAttachmentsForRevision(row.id, rev);
        if (unresolved > 0) pageBlocked = true;
      }

      if (pageBlocked) break;
    }

    if (pageBlocked) {
      report.status = 'blocked';
      report.finishedAt = new Date().toISOString();
      return report;
    }

    // 本页所有变更通知涉及的修订去向均已说明，才把不透明 last_seq 落为检查点。
    report.pages += 1;
    report.lastSeq = allDocsPage.last_seq;
    await store.advanceCheckpoint(allDocsPage.last_seq);
    since = allDocsPage.last_seq;
    if ((allDocsPage.pending ?? 0) === 0) {
      report.finishedAt = new Date().toISOString();
      return report;
    }
  }
  throw Object.assign(new Error('采集页数超过上限，疑似来源分页未收敛'), { status: 502 });
}
