import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { product } from './domain.mjs';
import { createSourceClient } from './source-client.mjs';

const now = () => new Date().toISOString();
const md5Of = bytes => 'md5-' + createHash('md5').update(bytes).digest('base64');

// _revisions 给出已知祖先：ids 从当前修订向根部排列，世代号逐项递减
function ancestorsOf(revisions) {
  if (!revisions || !Array.isArray(revisions.ids)) return [];
  return revisions.ids.slice(1).map((idPart, index) => `${revisions.start - 1 - index}-${idPart}`);
}

async function loadState(directory) {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8'));
    return {
      version: 1,
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '0',
      lastRunAt: parsed.lastRunAt ?? null,
      surveys: parsed.surveys && typeof parsed.surveys === 'object' && !Array.isArray(parsed.surveys) ? parsed.surveys : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, cursor: '0', lastRunAt: null, surveys: {} };
  }
}

function countEvents(events) {
  const counts = { revisions: {}, attachments: {} };
  for (const event of events) {
    if (event.type === 'revision') counts.revisions[event.status] = (counts.revisions[event.status] ?? 0) + 1;
    if (event.type === 'attachment') counts.attachments[event.status] = (counts.attachments[event.status] ?? 0) + 1;
  }
  return counts;
}

export async function createCollector({ directory, store, sourceUrl, fetchImpl }) {
  const client = createSourceClient(sourceUrl, fetchImpl);
  const state = await loadState(directory);
  let chain = Promise.resolve();
  const serialize = operation => {
    const next = chain.then(operation);
    chain = next.catch(() => {});
    return next;
  };
  const persist = async () => {
    const temporary = join(directory, 'collection.json.tmp');
    await writeFile(temporary, JSON.stringify(state, null, 1) + '\n');
    await rename(temporary, join(directory, 'collection.json'));
  };

  // 修订去向分别记录：collected 已取回、deleted 该分支被真正删除、missing 已被压缩清理
  function recordRevision(id, rev, status, document, summary) {
    const survey = (state.surveys[id] ??= { selected: null, leaves: null, revisions: {} });
    const existing = survey.revisions[rev];
    const unchanged = existing && existing.status === status
      && JSON.stringify(existing.document ?? null) === JSON.stringify(document ?? null);
    if (unchanged) return;
    survey.revisions[rev] = {
      status,
      ...(document ? { document } : {}),
      attachments: existing?.attachments ?? {},
      recordedAt: existing?.recordedAt ?? now(),
      updatedAt: now(),
    };
    summary.events.push({ type: 'revision', id, rev, status });
  }

  // 取回单个附件并核对来源声明的摘要与长度；已取回且声明一致时复用，不重复下载。
  // 返回 null 表示该附件已有定论，返回对象表示暂不可取、调用方不得推进进度。
  async function ensureAttachment(id, rev, name, stub, summary) {
    const revision = state.surveys[id].revisions[rev];
    const attachments = (revision.attachments ??= {});
    const existing = attachments[name];
    const declaredMd5 = stub?.digest ?? existing?.declaredMd5 ?? null;
    const declaredLength = stub?.length ?? existing?.declaredLength ?? null;
    const mediaType = stub?.content_type ?? existing?.mediaType ?? 'application/octet-stream';
    if (existing?.status === 'collected' && existing.declaredMd5 === declaredMd5 && existing.declaredLength === declaredLength) {
      summary.events.push({ type: 'attachment', id, rev, name, status: 'reused', sha256: existing.sha256 });
      return null;
    }
    const fetched = await client.attachment(id, name, rev);
    if (!fetched.ok) {
      const status = fetched.status === 404 ? 'missing' : 'unavailable';
      attachments[name] = { status, mediaType, declaredMd5, declaredLength, detail: fetched.transport ? fetched.error : `http-${fetched.status}`, updatedAt: now() };
      summary.events.push({ type: 'attachment', id, rev, name, status });
      return status === 'unavailable' ? { id, rev, attachment: name, reason: 'attachment-unavailable' } : null;
    }
    const actualMd5 = md5Of(fetched.bytes);
    if ((declaredLength !== null && fetched.bytes.length !== declaredLength) || (declaredMd5 !== null && actualMd5 !== declaredMd5)) {
      attachments[name] = { status: 'mismatch', mediaType, declaredMd5, declaredLength, actualMd5, actualLength: fetched.bytes.length, updatedAt: now() };
      summary.events.push({ type: 'attachment', id, rev, name, status: 'mismatch' });
      return null;
    }
    const sha256 = await store.putBlob(fetched.bytes);
    attachments[name] = { status: 'collected', sha256, size: fetched.bytes.length, mediaType, declaredMd5, declaredLength, updatedAt: now() };
    summary.events.push({ type: 'attachment', id, rev, name, status: 'collected', sha256 });
    return null;
  }

  // 处理一条变更通知涉及的全部修订分支；返回 null 或阻塞原因
  async function processItem(item, summary) {
    const refs = item.changes.map(change => ({ id: item.id, rev: change.rev }));
    const response = await client.bulkGet(refs);
    if (!response.ok || !Array.isArray(response.body?.results)) {
      return { id: item.id, reason: 'revisions-unexplained', detail: response.transport ? response.error : `http-${response.status}` };
    }
    for (const [index, entry] of response.body.results.entries()) {
      const outcome = entry.docs?.[0];
      const rev = outcome?.ok?._rev ?? outcome?.error?.rev ?? refs[index].rev;
      if (outcome?.ok) {
        const document = outcome.ok;
        const deleted = document._deleted === true;
        recordRevision(item.id, rev, deleted ? 'deleted' : 'collected', document, summary);
        if (!deleted) {
          for (const [name, stub] of Object.entries(document._attachments ?? {})) {
            const blocked = await ensureAttachment(item.id, rev, name, stub, summary);
            if (blocked) return blocked;
          }
        }
      } else if (outcome?.error) {
        // 正文已被来源清理：记录缺失，不补成空答卷
        recordRevision(item.id, rev, 'missing', null, summary);
      } else {
        return { id: item.id, rev, reason: 'revisions-unexplained', detail: '来源应答缺少该修订结果' };
      }
    }
    return null;
  }

  // 保留合作方当前选出的版本与当前叶分支快照
  async function refreshSelection(id, summary) {
    const survey = state.surveys[id];
    const winner = await client.document(id);
    if (winner.ok && typeof winner.body?._rev === 'string') {
      survey.selected = winner.body._rev;
      summary.events.push({ type: 'selected', id, rev: survey.selected });
      if (!survey.revisions[survey.selected]) {
        const blocked = await processItem({ id, changes: [{ rev: survey.selected }] }, summary);
        if (blocked) summary.events.push({ type: 'selected-incomplete', id, rev: survey.selected });
      }
    } else if (winner.status === 404) {
      survey.selected = null;
      summary.events.push({ type: 'selected', id, rev: null });
    } else {
      summary.events.push({ type: 'selected-unavailable', id });
    }
    const leaves = await client.openRevs(id);
    if (leaves.ok && Array.isArray(leaves.body)) {
      survey.leaves = leaves.body.map(entry => entry.ok?._rev ?? entry.missing).filter(Boolean);
    } else if (leaves.status === 404) {
      survey.leaves = null;
    }
  }

  async function run() {
    return serialize(async () => {
      const summary = { startedAt: now(), ok: true, completed: false, cursorBefore: state.cursor, events: [] };
      // 重采先补此前暂不可取的附件；已取得的内容由 ensureAttachment 复用
      for (const [id, survey] of Object.entries(state.surveys)) {
        for (const [rev, revision] of Object.entries(survey.revisions)) {
          if (revision.status !== 'collected') continue;
          for (const [name, attachment] of Object.entries(revision.attachments ?? {})) {
            if (attachment.status === 'unavailable' || attachment.status === 'error') {
              await ensureAttachment(id, rev, name, revision.document?._attachments?.[name] ?? null, summary);
            }
          }
        }
      }
      let blocked = null;
      for (let guard = 0; ; guard++) {
        if (guard >= 1000) {
          summary.ok = false;
          summary.error = '变更分页超过保护上限，已停止';
          break;
        }
        const page = await client.changes(state.cursor);
        if (!page.ok) {
          summary.ok = false;
          summary.error = page.transport ? `来源不可达：${page.error}` : `来源变更入口返回 http-${page.status}`;
          break;
        }
        const results = Array.isArray(page.body?.results) ? page.body.results : [];
        const lastSeq = page.body?.last_seq;
        summary.pending = typeof page.body?.pending === 'number' ? page.body.pending : null;
        if (results.length === 0) {
          if (typeof lastSeq === 'string' && lastSeq !== state.cursor) state.cursor = lastSeq;
          summary.completed = summary.pending === 0;
          break;
        }
        if (typeof lastSeq !== 'string' || lastSeq === state.cursor) {
          summary.ok = false;
          summary.error = '来源分页未推进，已停止以防漏采';
          break;
        }
        for (const item of results) {
          blocked = await processItem(item, summary);
          if (blocked) break;
        }
        // 进度不越过尚未说明去向的修订：整页修订与附件都有定论才推进续读凭据
        if (blocked) break;
        state.cursor = lastSeq;
        summary.events.push({ type: 'page', lastSeq, pending: summary.pending });
        if (summary.pending === 0) {
          summary.completed = true;
          break;
        }
      }
      for (const id of Object.keys(state.surveys)) await refreshSelection(id, summary);
      state.lastRunAt = now();
      await persist();
      summary.finishedAt = state.lastRunAt;
      summary.cursorAfter = state.cursor;
      summary.blocked = blocked;
      summary.counts = countEvents(summary.events);
      return summary;
    });
  }

  function surveyModel(id) {
    const survey = state.surveys[id];
    if (!survey) return null;
    const revisions = Object.entries(survey.revisions).map(([rev, revision]) => ({
      rev,
      status: revision.status,
      document: revision.document ?? null,
      ancestors: revision.document?._revisions ? ancestorsOf(revision.document._revisions) : [],
      attachments: Object.fromEntries(Object.entries(revision.attachments ?? {}).map(([name, attachment]) => [name, {
        status: attachment.status,
        sha256: attachment.sha256 ?? null,
        size: attachment.size ?? null,
        mediaType: attachment.mediaType ?? null,
        declaredMd5: attachment.declaredMd5 ?? null,
        declaredLength: attachment.declaredLength ?? null,
        evidence: attachment.sha256 ? `/api/evidence/${attachment.sha256}` : null,
        detail: attachment.detail ?? null,
        updatedAt: attachment.updatedAt,
      }])),
      recordedAt: revision.recordedAt,
    }));
    // 活叶由修订祖系计算：不被任何已知修订列为祖先的修订即叶分支
    const ancestorSet = new Set(revisions.flatMap(revision => revision.ancestors));
    const leaves = revisions.filter(revision => !ancestorSet.has(revision.rev));
    const leavesWith = status => leaves.filter(revision => revision.status === status).map(revision => revision.rev);
    const liveLeaves = leavesWith('collected');
    const pendingAttachments = revisions.flatMap(revision => Object.entries(revision.attachments)
      .filter(([, attachment]) => attachment.status === 'unavailable' || attachment.status === 'error')
      .map(([name, attachment]) => ({ rev: revision.rev, name, status: attachment.status })));
    return structuredClone({
      surveyId: id,
      selected: survey.selected,
      reportedLeaves: survey.leaves,
      uncollectedLeaves: (survey.leaves ?? []).filter(rev => !survey.revisions[rev]),
      conflict: {
        unresolved: liveLeaves.length > 1,
        liveLeaves,
        deletedLeaves: leavesWith('deleted'),
        missingLeaves: leavesWith('missing'),
      },
      pendingAttachments,
      revisions,
    });
  }

  return {
    run,
    survey: surveyModel,
    model() {
      return {
        product,
        source: sourceUrl,
        cursor: state.cursor,
        lastRunAt: state.lastRunAt,
        surveys: Object.keys(state.surveys).sort().map(surveyModel),
      };
    },
  };
}
