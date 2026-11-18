
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const COLLECTION_CHECKPOINT_ID = 'survey';
const INITIAL_SEQ = '0';

async function readJournal(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

// 自动采集状态完全由 collected.jsonl 重放得到：
// checkpoint / notice（变更通知与叶修订）/ revision（分支去向）/ attachment（附件归属）。
function replayCollection(events) {
  const checkpoint = { sourceSeq: INITIAL_SEQ, updatedAt: null };
  const notices = new Map(); // key: `${id} ${seq}`
  const revisions = new Map(); // key: `${id} ${rev}`
  const attachments = new Map(); // key: `${id} ${rev} ${name}`

  for (const event of events) {
    if (event.type === 'checkpoint') {
      checkpoint.sourceSeq = event.sourceSeq;
      checkpoint.updatedAt = event.at;
    } else if (event.type === 'notice') {
      notices.set(`${event.id} ${event.seq}`, event);
    } else if (event.type === 'revision') {
      const key = `${event.id} ${event.rev}`;
      const previous = revisions.get(key);
      // 状态机只允许暂时不可用 -> 已取得/压缩清理/删除 等终态前进一步；终态保持稳定。
      revisions.set(key, previous && event.disposition === 'unavailable' && previous.disposition !== 'unavailable' ? previous : event);
    } else if (event.type === 'attachment') {
      attachments.set(`${event.id} ${event.rev} ${event.name}`, event);
    }
  }

  // 每条变更通知都按到达顺序保留；最后一条通知的 changes 是来源当前的叶集合，
  // 但曾出现在通知里的所有修订（后来变成祖先的历史分支）都必须留存可查。
  const docs = new Map();
  for (const notice of notices.values()) {
    let doc = docs.get(notice.id);
    if (!doc) {
      doc = { id: notice.id, notices: [], leaves: [], observedRevs: [], winningRev: null, firstSeenAt: notice.at, lastNoticeAt: notice.at };
      docs.set(notice.id, doc);
    }
    doc.notices.push({ seq: notice.seq, leafRevs: [...notice.leafRevs], winningRev: notice.winningRev ?? null, at: notice.at });
    doc.leaves = [...notice.leafRevs];
    for (const rev of notice.leafRevs) if (!doc.observedRevs.includes(rev)) doc.observedRevs.push(rev);
    if (notice.winningRev !== undefined && notice.winningRev !== null) doc.winningRev = notice.winningRev;
    doc.lastNoticeAt = notice.at;
  }

  for (const doc of docs.values()) {
    const liveLeaves = [];
    const deletedLeaves = [];
    const unavailableLeaves = [];
    for (const rev of doc.leaves) {
      const state = revisions.get(`${doc.id} ${rev}`);
      if (state?.disposition === 'deleted') deletedLeaves.push(rev);
      else if (state?.disposition === 'compacted' || !state) unavailableLeaves.push(rev);
      else liveLeaves.push(rev);
    }
    doc.liveLeafRevs = liveLeaves;
    doc.deletedLeafRevs = deletedLeaves;
    doc.unavailableLeafRevs = unavailableLeaves;
    // 当前存活叶超过一个即来源尚未解决的冲突；墓碑不抹掉同一答卷的存活内容。
    doc.hasUnresolvedConflict = liveLeaves.length > 1;
    // 通知到达时曾并列多个叶修订的时刻，便于复核人员回顾冲突过程。
    doc.conflictNotices = doc.notices
      .filter(entry => entry.leafRevs.length > 1)
      .map(entry => ({ seq: entry.seq, leafRevs: entry.leafRevs, at: entry.at }));
    const leafSet = new Set(doc.leaves);
    doc.branches = doc.observedRevs.map(rev => {
      const state = revisions.get(`${doc.id} ${rev}`);
      return {
        rev,
        isCurrentLeaf: leafSet.has(rev),
        disposition: state?.disposition ?? 'unobserved',
        deleted: state?.deleted ?? false,
        reason: state?.reason ?? null,
        record: state?.record ?? null,
        docSha256: state?.docSha256 ?? null,
        ancestors: state?.ancestors ?? [],
        observedAt: state?.at ?? null,
        attachments: [...attachments.values()]
          .filter(item => item.id === doc.id && item.rev === rev)
          .map(({ name, mediaType, length, declaredMd5, sha256, state: attachmentState, reason, at }) => ({
            name, mediaType, length, declaredMd5, sha256, state: attachmentState, reason, observedAt: at,
          })),
      };
    });
  }

  return { checkpoint, docs, notices, revisions, attachments };
}

export async function openStore(directory) {
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const journal = join(directory, 'receipts.jsonl');
  const collectionJournal = join(directory, 'collected.jsonl');
  let receipts = await readJournal(journal);
  let collectionEvents = await readJournal(collectionJournal);
  let pending = Promise.resolve();
  const serialize = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  const appendCollection = event => appendFile(collectionJournal, JSON.stringify(event) + '\n').then(() => collectionEvents.push(event));

  return {
    list() {
      const latest = new Map();
      for (const receipt of receipts) latest.set(receipt.key, receipt);
      return structuredClone([...latest.values()]);
    },
    history(key) {
      return structuredClone(receipts.filter(receipt => receipt.key === key));
    },
    async evidence(sha) {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Object.assign(new Error('依据标识无效'), { status: 400 });
      return readFile(join(directory, 'blobs', sha));
    },
    // 内容寻址写入：相同字节天然复用；返回是否为已存在字节。
    putBlob(bytes) {
      const sha256 = digest(bytes);
      return serialize(async () => {
        try {
          await writeFile(join(directory, 'blobs', sha256), bytes, { flag: 'wx' });
          return { sha256, reused: false };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          return { sha256, reused: true };
        }
      });
    },
    accept(key, record, evidence) {
      return serialize(async () => {
        if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 30) {
          throw Object.assign(new Error('收件需要原始依据，单次不超过30份'), { status: 422 });
        }
        const prepared = evidence.map(item => {
          if (!item || typeof item.source !== 'string' || !item.source.trim() || typeof item.bytesBase64 !== 'string') {
            throw Object.assign(new Error('依据必须包含来源和原始字节'), { status: 422 });
          }
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) {
            throw Object.assign(new Error('依据不是标准Base64'), { status: 422 });
          }
          const bytes = Buffer.from(item.bytesBase64, 'base64');
          const sha256 = digest(bytes);
          if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
          return { bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: bytes.length } };
        });
        const refs = prepared.map(item => item.ref);
        const identity = digest(JSON.stringify({ key, record, refs }));
        const existing = receipts.find(receipt => receipt.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const item of prepared) {
          try {
            await writeFile(join(directory, 'blobs', item.ref.sha256), item.bytes, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        const receipt = { sequence: receipts.length + 1, identity, key, record: structuredClone(record), evidence: refs, receivedAt: new Date().toISOString() };
        await appendFile(journal, JSON.stringify(receipt) + '\n');
        receipts.push(receipt);
        return { ...structuredClone(receipt), duplicate: false };
      });
    },

    // ---- 自动采集（只读来源，本地只追加证据，不改写合作方胜出版本）----
    collectionState() {
      const { checkpoint, docs, revisions, attachments } = replayCollection(collectionEvents);
      return structuredClone({
        checkpoint,
        documents: [...docs.values()],
        revisionCount: revisions.size,
        attachmentCount: attachments.size,
      });
    },
    collectionRevision(id, rev) {
      const state = replayCollection(collectionEvents).revisions.get(`${id} ${rev}`);
      return state ? structuredClone(state) : null;
    },
    collectionAttachment(id, rev, name) {
      const state = replayCollection(collectionEvents).attachments.get(`${id} ${rev} ${name}`);
      return state ? structuredClone(state) : null;
    },
    recordNotice(event) {
      const key = `${event.id} ${event.seq}`;
      const known = replayCollection(collectionEvents).notices.has(key);
      if (known) return Promise.resolve({ duplicate: true });
      return serialize(() => appendCollection({ type: 'notice', at: new Date().toISOString(), ...event }).then(() => ({ duplicate: false })));
    },
    recordRevision(event) {
      return serialize(() => appendCollection({ type: 'revision', at: new Date().toISOString(), ...event }));
    },
    recordAttachment(event) {
      return serialize(() => appendCollection({ type: 'attachment', at: new Date().toISOString(), ...event }));
    },
    advanceCheckpoint(sourceSeq) {
      return serialize(() => appendCollection({ type: 'checkpoint', sourceSeq: String(sourceSeq), at: new Date().toISOString(), checkpointId: COLLECTION_CHECKPOINT_ID }));
    },
    flush() { return pending; },
  };
}
