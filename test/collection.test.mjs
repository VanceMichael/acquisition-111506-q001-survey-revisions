import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';

const westPhoto = Buffer.from('west-photo17');
const eastPhoto = Buffer.from('east-photo17');

const collect = application => fetch(`${application.url}/api/collect`, { method: 'POST' }).then(response => response.json());
const collection = application => fetch(`${application.url}/api/collection`).then(response => response.json());
const photoGets = (source, rev) => source.events.filter(event => event.path === '/survey/survey-17/photo.jpg' && event.query.includes(`rev=${rev}`));

test('自动采集：分支、附件、删除与压缩清理分别记录，进度不越过未决修订，重采复用照片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const source = await startProvider();
  let application = await startApplication({ directory, sourceUrl: source.url });
  try {
    // 第一轮：east 照片暂不可取，进度停在起点，不越过未决修订
    const first = await collect(application);
    assert.equal(first.ok, true);
    assert.equal(first.completed, false);
    assert.equal(first.cursorBefore, '0');
    assert.equal(first.cursorAfter, '0');
    assert.deepEqual(first.blocked, { id: 'survey-17', rev: '2-east', attachment: 'photo.jpg', reason: 'attachment-unavailable' });

    let model = await collection(application);
    assert.equal(model.cursor, '0');
    let survey17 = model.surveys.find(survey => survey.surveyId === 'survey-17');
    assert.equal(survey17.selected, '2-east');
    assert.equal(survey17.conflict.unresolved, true);
    assert.deepEqual(survey17.conflict.liveLeaves.sort(), ['2-east', '2-west']);
    let byRev = Object.fromEntries(survey17.revisions.map(revision => [revision.rev, revision]));
    assert.equal(byRev['2-west'].status, 'collected');
    assert.equal(byRev['2-west'].attachments['photo.jpg'].status, 'collected');
    assert.equal(byRev['2-east'].status, 'collected');
    assert.equal(byRev['2-east'].attachments['photo.jpg'].status, 'unavailable');
    assert.equal(survey17.pendingAttachments.length, 1);
    // 已取回的照片按摘要回查原文
    const westSha = byRev['2-west'].attachments['photo.jpg'].sha256;
    const westBytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${westSha}`)).arrayBuffer());
    assert.deepEqual(westBytes, westPhoto);
    // 自动采集不产生人工收件
    assert.deepEqual(await (await fetch(`${application.url}/api/records`)).json(), []);

    // 第二轮：重试暂不可取的附件，复用已取得的照片，走到变更尾部
    const second = await collect(application);
    assert.equal(second.completed, true);
    assert.equal(second.cursorAfter, 'opaque:compact');
    assert.equal(second.counts.attachments.reused >= 1, true);

    model = await collection(application);
    survey17 = model.surveys.find(survey => survey.surveyId === 'survey-17');
    byRev = Object.fromEntries(survey17.revisions.map(revision => [revision.rev, revision]));
    // 三类去向分别记录：取回、真正删除、压缩清理
    assert.equal(byRev['2-west'].status, 'collected');
    assert.equal(byRev['2-east'].status, 'collected');
    assert.equal(byRev['3-deleted'].status, 'deleted');
    // 分支被删除不抹掉同一答卷仍存活的内容
    assert.equal(byRev['2-west'].document.answers.households, 6);
    assert.equal(byRev['2-east'].document.answers.households, 7);
    assert.equal(byRev['3-deleted'].document._deleted, true);
    // 合作方当前选出的版本与叶分支快照
    assert.equal(survey17.selected, '2-east');
    assert.deepEqual([...survey17.reportedLeaves].sort(), ['2-east', '3-deleted']);
    assert.deepEqual(survey17.uncollectedLeaves, []);
    // 冲突随删除叶的出现而解除，活叶只剩合作方选定分支
    assert.equal(survey17.conflict.unresolved, false);
    assert.deepEqual(survey17.conflict.liveLeaves, ['2-east']);
    assert.deepEqual(survey17.conflict.deletedLeaves, ['3-deleted']);
    assert.deepEqual(survey17.pendingAttachments, []);
    // 同名照片按修订归属，内容不同摘要不同，均可回查
    const eastSha = byRev['2-east'].attachments['photo.jpg'].sha256;
    assert.notEqual(westSha, eastSha);
    assert.equal(byRev['2-east'].attachments['photo.jpg'].evidence, `/api/evidence/${eastSha}`);
    const eastBytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${eastSha}`)).arrayBuffer());
    assert.deepEqual(eastBytes, eastPhoto);
    // 压缩清理掉的分支：记录缺失，不补成空答卷
    const survey18 = model.surveys.find(survey => survey.surveyId === 'survey-18');
    assert.equal(survey18.revisions.length, 1);
    assert.equal(survey18.revisions[0].rev, '3-lost');
    assert.equal(survey18.revisions[0].status, 'missing');
    assert.equal(survey18.revisions[0].document, null);
    assert.equal(survey18.selected, null);
    assert.deepEqual(survey18.conflict.missingLeaves, ['3-lost']);
    // 已取得的照片被复用：west 只下载过一次，east 一次 503 一次成功
    assert.equal(photoGets(source, '2-west').length, 1);
    assert.equal(photoGets(source, '2-east').length, 2);

    // 第三轮：幂等，无新下载，状态不变
    const third = await collect(application);
    assert.equal(third.completed, true);
    assert.equal(third.cursorAfter, 'opaque:compact');
    assert.equal(photoGets(source, '2-west').length, 1);
    assert.equal(photoGets(source, '2-east').length, 2);
    const again = await collection(application);
    assert.equal(again.cursor, model.cursor);
    assert.deepEqual(again.surveys, model.surveys);

    // 持久化：关闭重开后游标、分支状态与附件归属保持
    await application.close();
    application = await startApplication({ directory, sourceUrl: source.url });
    const reopened = await collection(application);
    assert.equal(reopened.cursor, 'opaque:compact');
    const reopened17 = reopened.surveys.find(survey => survey.surveyId === 'survey-17');
    assert.equal(reopened17.selected, '2-east');
    assert.equal(reopened17.revisions.length, 3);
    assert.equal(reopened17.revisions.find(revision => revision.rev === '2-east').attachments['photo.jpg'].sha256, eastSha);
    // 单答卷查询与未知标识
    const single = await (await fetch(`${application.url}/api/collection?key=survey-18`)).json();
    assert.equal(single.revisions[0].status, 'missing');
    assert.equal((await fetch(`${application.url}/api/collection?key=survey-99`)).status, 404);
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('来源不可达：采集报错且不推进游标，已有采集状态保持可查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-down-'));
  const source = await startProvider();
  let application = await startApplication({ directory, sourceUrl: source.url });
  try {
    assert.equal((await collect(application)).completed, false); // east 照片暂不可取
    await source.close();
    const response = await fetch(`${application.url}/api/collect`, { method: 'POST' });
    assert.equal(response.status, 502);
    const summary = await response.json();
    assert.equal(summary.ok, false);
    assert.equal(summary.cursorAfter, '0');
    const model = await collection(application);
    const survey17 = model.surveys.find(survey => survey.surveyId === 'survey-17');
    assert.equal(survey17.revisions.length, 2);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
