# 协作调查收件台

这个服务保存答卷的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。服务另提供只读自动采集：按变更通知把各修订分支及附件取回，保留合作方当前选出的版本，并向复核人员展示尚未解决的冲突。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `surveyId, revision, answers`，其中 `surveyId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；新增来源接入可以扩展领域状态，但应保留这些已用接口。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动两个本地服务，执行人工提交、重复收件、原始依据回查，以及两轮自动采集：第一轮遇到附件暂不可取、进度停在原处，第二轮重试取回并读至变更尾部。整个流程使用本地来源完成端到端验证，不用外部网络。

## 只读自动采集

`POST /api/collect` 触发一轮采集（对来源只读）：从保存的续读凭据起读取 `style=all_docs` 的变更分页，逐条取回通知涉及的修订正文与附件。`GET /api/collection` 返回全部采集结果，`GET /api/collection?key=...` 返回单份答卷；附件原文仍通过 `GET /api/evidence/摘要` 回查。来源地址用 `SOURCE_URL` 指定，默认 `http://127.0.0.1:4311`；采集状态保存在数据目录的 `collection.json`，重开后继续。

- 来源序号（`seq`、`last_seq`）只作续读凭据，不透明、不排序。整页修订及其附件都有定论后才推进凭据；修订正文取不到或附件暂不可取时进度停在原处，下轮采集重读该页，不越过尚未说明去向的修订。
- 修订去向分别记录：`collected` 已取回、`deleted` 该分支被真正删除、`missing` 已被压缩清理（不补成空答卷）。某个分支被删除不影响同一答卷其他存活分支的内容。
- 附件状态分别记录：`collected` 已取回（核对来源声明的 MD5 与长度后按 SHA256 保存原文）、`unavailable` 暂不可取、`mismatch` 摘要或长度不符、`missing` 来源已不存在。
- 再次采集复用已取得的附件：按答卷、修订、名称与来源声明匹配，不重复下载；相同字节只存一份，归属仍对应具体答卷与修订。
- 采集结果保留合作方当前选出的修订（`selected`）与当前叶分支（`reportedLeaves`），并按修订祖系计算活叶；活叶超过一条即标记未解决冲突（`conflict.unresolved`），暂不可取的附件列入 `pendingAttachments`。

## 容器

```sh
docker build -t survey-revisions-intake .
docker run --rm --network none survey-revisions-intake npm test
docker run --rm --network none survey-revisions-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
