// 一次性只读自动采集入口：
// node scripts/collect.mjs [来源URL]
// 退出码 0 = 已读到来源尾部；2 = 有修订去向暂未说明（如附件暂时不可用），检查点未越过。
import { openStore } from '../src/store.mjs';
import { createSourceClient } from '../src/source-client.mjs';
import { runCollection } from '../src/collector.mjs';

const sourceUrl = process.argv[2] ?? process.env.SOURCE_URL ?? 'http://127.0.0.1:4311';
const directory = process.env.DATA_DIR ?? './var';
const store = await openStore(directory);
try {
  const source = createSourceClient(sourceUrl);
  const report = await runCollection(store, source);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'blocked' ? 2 : 0;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, status: error.status ?? 500 }));
  process.exitCode = 1;
} finally {
  await store.flush();
}
