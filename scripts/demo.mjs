
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory, sourceUrl: source.url });
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件、自动采集与原始依据回查`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());
  const body = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  for (const label of ['首次提交', '同件再次提交']) {
    const response = await fetch(`${application.url}/api/manual`, { method: 'POST', body: JSON.stringify(body) });
    const receipt = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(receipt));
    console.log(label, JSON.stringify({ status: response.status, key: receipt.key, duplicate: receipt.duplicate, identity: receipt.identity }));
    const evidence = await (await fetch(`${application.url}/api/evidence/${receipt.evidence[0].sha256}`)).arrayBuffer();
    if (!Buffer.from(evidence).equals(fixture)) throw new Error('原始依据不一致');
  }
  console.log('当前收件', await (await fetch(`${application.url}/api/records`)).text());

  for (const label of ['第一轮采集（east 照片暂不可取）', '第二轮采集（重试后读至尾部）']) {
    const summary = await (await fetch(`${application.url}/api/collect`, { method: 'POST' })).json();
    console.log(label, JSON.stringify({ completed: summary.completed, cursor: summary.cursorAfter, blocked: summary.blocked, counts: summary.counts }));
  }
  const collection = await (await fetch(`${application.url}/api/collection`)).json();
  for (const survey of collection.surveys) {
    console.log(`答卷 ${survey.surveyId}`, JSON.stringify({
      当前选定: survey.selected,
      叶分支: survey.reportedLeaves,
      冲突未解决: survey.conflict.unresolved,
      活叶: survey.conflict.liveLeaves,
      分支: survey.revisions.map(revision => `${revision.rev}:${revision.status}`),
    }));
    for (const revision of survey.revisions) {
      for (const [name, attachment] of Object.entries(revision.attachments)) {
        if (!attachment.sha256) continue;
        const bytes = Buffer.from(await (await fetch(`${application.url}${attachment.evidence}`)).arrayBuffer());
        console.log(`依据回查 ${survey.surveyId}/${revision.rev}/${name}`, JSON.stringify({ sha256: attachment.sha256, 内容: bytes.toString() }));
      }
    }
  }
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
