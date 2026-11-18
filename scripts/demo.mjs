
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
  console.log(`${product}：人工收件与原始依据回查`);
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

  console.log('\n只读自动采集：把变更通知涉及的修订分支及附件带回');
  const firstRun = await fetch(`${application.url}/api/collection/run`, { method: 'POST', body: JSON.stringify({ baseDelayMs: 1 }) });
  const firstReport = await firstRun.json();
  if (!firstRun.ok) throw new Error(JSON.stringify(firstReport));
  console.log('首次采集', JSON.stringify({
    status: firstReport.status,
    lastSeq: firstReport.lastSeq,
    revisions: firstReport.revisions,
    attachments: firstReport.attachments,
  }));

  const collected = await (await fetch(`${application.url}/api/collection`)).json();
  for (const doc of collected.documents) {
    console.log(`答卷 ${doc.id}：胜出修订=${doc.winningRev ?? '无'}，存活叶=${doc.liveLeafRevs.join('|') || '无'}，墓碑=${doc.deletedLeafRevs.join('|') || '无'}，清理不可得=${doc.unavailableLeafRevs.join('|') || '无'}`);
    for (const branch of doc.branches) {
      const photos = branch.attachments.map(item => `${item.name}[${item.state}]`).join(',') || '无附件';
      console.log(`  分支 ${branch.rev}（当前叶:${branch.isCurrentLeaf}）去向=${branch.disposition} 附件=${photos}`);
    }
  }

  const east = await fetch(`${application.url}/api/collection/attachment?id=survey-17&rev=2-east&name=photo.jpg`);
  console.log('回查 2-east 照片字节', east.status, (await east.text()));

  console.log('\n再次采集：已取得照片本地复用，不重复下载');
  const secondReport = await (await (await fetch(`${application.url}/api/collection/run`, { method: 'POST', body: '{}' })).json());
  console.log('重采结果', JSON.stringify({ status: secondReport.status, attachments: secondReport.attachments }));
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
