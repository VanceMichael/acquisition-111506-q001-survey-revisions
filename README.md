# 协作调查收件台

这个服务保存答卷的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。自动采集为只读接入：顺着来源的变更通知把修订分支与附件带回，不向来源写入任何内容。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口，收件服务通过 `SOURCE_URL` 指认来源（默认 `http://127.0.0.1:4311`）。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `surveyId, revision, answers`，其中 `surveyId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口与自动采集互不干扰，已用接口保持不变。

`fixtures/manual.json` 是可用的人工收件样例。

## 只读自动采集

`POST /api/collection/run` 触发一次采集（请求体可空，可传 `sourceUrl` 覆盖默认来源）；也可用 `npm run collect -- [来源URL]` 运行一次性命令，退出码 0 表示读到来源尾部，2 表示有修订去向暂未说明（检查点未越过），1 表示来源不可达等错误。`GET /api/collection` 返回复核视图，`GET /api/collection/revision?id=...&rev=...` 回查单个修订的留存状态与结构化内容，`GET /api/collection/attachment?id=...&rev=...&name=...` 回查附件原文。

采集语义：

- **只读**：只调用来源声明的 `GET _changes`、`POST _bulk_get`、按 `rev` 读文档和附件，没有任何写来源的操作；`_bulk_get` 是 CouchDB 的只读批量读取入口。
- **不透明续读**：`seq`/`last_seq` 原样作为检查点传递，绝不解析、比较或排序。检查点只有在一页内所有通知涉及的修订去向都已说明后才推进；附件暂时不可用等未决情况会让本次采集停在原检查点之前，不会越过尚未说明去向的修订。
- **三种去向分别记录**：正文可取得记为 `available`（原文按 SHA256 内容寻址留存）；`bulk_get` 返回 missing/not_found 记为 `compacted`（压缩清理后正文不可得，绝不补成空答卷）；带 `_deleted` 的修订记为 `deleted` 墓碑。删除只作用于具体修订，同一答卷仍存活的叶分支内容一律保留。
- **胜出与冲突**：同时以默认 style 读取合作方当前选出的胜出修订并标记展示，但不覆盖、不删除收件台保留的其他分支；通知里出现过的全部修订（含后来变成祖先的历史分支）都在复核视图中，当前存活叶多于一个时标记 `hasUnresolvedConflict`，并保留每次并列叶的 `conflictNotices`。
- **附件归属与完整性**：附件按 `(答卷, 修订, 附件名)` 归属保存，同名不等于同内容；落盘前核对来源声明的长度与 MD5，收件端统一用 SHA256 内容寻址保存。来源 5xx 等暂时不可用记为 `unavailable`（可与真正的删除区分），经有界重试仍失败即阻塞本次推进，等待后续重采。
- **重采复用**：再次采集时已取得的照片直接复用本地内容寻址字节、不重复下载，附件归属仍对应具体答卷与修订；此前暂时不可用的附件会在重采时重试。所有采集状态由 `collected.jsonl` 只追加日志重放得到，进程重开后状态保持。

`npm run demo` 实际启动两个本地服务，依次演示人工提交、重复收件、原始依据回查，以及自动采集、三分支去向、冲突视图和重采复用，不使用外部网络。

## 容器

```sh
docker build -t survey-revisions-intake .
docker run --rm --network none survey-revisions-intake npm test
docker run --rm --network none survey-revisions-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。
