# dsh-qq-console — 设计说明（DSH 插件：在设置页里控制 qq-bridge）

> 目标（用户原话）：把「控制桥接的开关 / 白名单的增添 / 响应速度的调节 / 等待锁的调节」做成一个 DSH 插件。
> 这份文件是**功能与接口设计**，实现细节见同目录其它文件。

## 0. 结论：插件做「薄代理」，不重写桥接逻辑

qq-bridge 自带的控制台（`http://127.0.0.1:3100`，请求头 `x-console-token`）**已经**提供了本插件需要的全部能力，
而且每个写操作都自己做了校验 + 原子落盘（`config.json`）+ 热更新（改完立即生效，不用重启桥接）。
所以插件不直接改 `config.json`（那样会与桥接的内存态打架），而是**转发到桥接 API**；
只有「进程级开关」这一项是桥接 API 管不到的（进程都停了就没 API 了），走 Windows 任务计划。

| 用户要的能力 | 插件怎么做 | 底层端点 |
| --- | --- | --- |
| ① 桥接开关 | 「暂停/恢复 AI 活动」（软）+「停止/启动桥接进程」（硬） | `POST /api/socialV2/activity {paused}`；硬开关走 `schtasks` |
| ② 白名单增删 | 群号/私聊号列表增删 → 提交整份数组 | `GET/POST /api/whitelist` |
| ③ 响应速度调节 | 一组数值 + 慢/正常/快 预设 | `POST /api/socialV2/config` |
| ④ 等待锁调节 | 等待预算、静默窗口、收尾观察窗口、租约诊断阈值 | `POST /api/socialV2/config`（含新增的 `wait.leaseMs`） |

## 1. 关键前提（都是实测过的）

- 桥接控制台 token 在 `C:\Users\faith\qq-bridge\state\console-token`（48 个 hex 字符）。
  插件 host 半**直接读这个文件**（它与桥接同机同用户），不需要用户填 token。
- **硬开关必须同时动任务**：`DSH-qq-bridge` 计划任务带「每 1 分钟保活」触发器
  （`Once` + `Repetition PT1M`）。只 `Stop-Process` 杀进程，**≤1 分钟就被拉回来**。
  正确做法：`schtasks /Change /TN "DSH-qq-bridge" /DISABLE` → `schtasks /End /TN ...`；
  恢复：`/ENABLE` → `/Run`。（这三个命令的行为已在 2026-10-23 实测，见 README 的验证记录。）
- 桥接的 `GET /api/status` 是对「无令牌智能体调用」也开放的最小对象，但**控制台令牌**下信息最全。
- 桥接的写接口会做**字段白名单归一化**：不在白名单里的键会被静默忽略（不是报错）。
  所以插件只发它确实支持的键，并在 UI 上标注每个键的单位与含义。
- `socialV2.wait.leaseMs` 是本插件这次为「等待锁」新加的旋钮（原先 `ACTIVE_WAIT_LEASE_MS` 是硬编码常量；
  现在它只作为日志里「疑似被放弃的调用」的判据阈值，**不拒绝新等待**）。`0` = 用内置默认 15 分钟。

## 2. 插件四组控件（设置页）

### ① 桥接开关
- **状态行**：桥接进程（在跑/已停/任务已禁用）、DSH 连通、SnowLuma 连通、当前模式、两个群的会话数。
- **暂停 AI 活动**（软开关，进程留着）：`paused=true` 时桥接不再唤醒/不自动回复；
  人还在群里说话不会触发 agent。适合「临时静音」。
- **停止/启动桥接**（硬开关）：停止会禁用任务的保活并结束进程；启动会重新启用并运行。
  停止期间 QQ 消息不会被处理（SnowLuma 仍在线，消息只是没人回）。
- **重启桥接**：`POST /api/restart`（保留任务保活，只是让进程重来，用于配置异常时自救）。

### ② 白名单
- 两个可增删的号码列表：**群号**（`allow.groups`）与**私聊 QQ**（`allow.private`），另有**黑名单**
  （`deny.*`，优先于白名单）与**管理员 QQ**（`ownerQQ`）输入。
- 保存即 `POST /api/whitelist`（整份替换，桥接侧会去重、只留数字、并立即重算会话策略）。
- 群号支持填「群号：备注」这种形式？——**不支持**，桥接只存数字；备注放插件自己的本地笔记（可选）。

### ③ 响应速度
一键预设 + 逐项微调（全部毫秒）：

| 键 | 含义 | 慢 | 正常（默认） | 快 |
| --- | --- | --- | --- | --- |
| `wake.batchWindowMs` | 多条消息合并成一个唤醒的窗口（越小越"抢答"） | 20000 | 8000 | 3000 |
| `autoReplyCheckMs` | 回复后多久回来检查是否有人接话 | 60000 | 30000 | 15000 |
| `send.gapBaseMs` / `send.gapPerCharMs` | 分条发送的条间基础间隔 / 每字增量 | 1500 / 30 | 800 / 20 | 400 / 10 |
| `send.burstIntervalMinMs` / `MaxMs` | 连发多条的间隔区间 | 2000 / 5000 | 1000 / 3000 | 600 / 1500 |
| `send.maxSendPerMinute` / `maxSendPerHour` | 发送限速 | 4 / 30 | 8 / 60 | 12 / 120 |
| `wake.maxWakePerMinute` / `maxWakePerHour` | 唤醒限速 | 1 / 6 | 1 / 12 | 2 / 24 |
| `wake.recommendedProbability` | 普通消息唤醒概率 | 0.02 | 0.05 | 0.15 |

> 注意：把「快」调到极端会让 agent 更像客服、更容易抢话——UI 上要有这句提醒。

### ④ 等待锁
| 键 | 含义 | 备注 |
| --- | --- | --- |
| `wait.minMs` / `defaultMs` / `maxMs` | 单次等待预算的下限/默认/上限 | 桥接会 clamp；`maxMs` 不要超过 DSH 的 `toolCallTimeoutMs`（725s） |
| `wait.defaultQuietMs` / `minQuietAfterNewMs` | 静默窗口默认值 / 收到新消息后的最小静默 | 越小越容易抢话 |
| `wake.preSleepWaitMs` | **收尾前的沉睡前观察窗口**（当前 10 秒） | 与 preset 提示词里的 `timeoutMs=10000` 必须一致；改了要重启 DSH 才同步到人设 |
| `wait.leaseMs` | 「一次等待正常能占多久」的诊断阈值 | `0` = 默认 15 分钟；**只影响日志判据，不拒绝新等待** |

另设一个只读信息块：**当前被接管的等待记录**（最近 N 条，从 `state/bridge.log` 里筛 `[wait]`）——
这是排「等待锁卡住」的第一手证据。

### ⑦ 语音发送限制（调试）

桥接的 `socialV2.voice` 有一整套限制，但散在 `config.json` 里、且**没有任何 UI 会说
「这一条现在会不会被拒」**。这一组补的就是可写 + 可诊断。

| 键 | 含义 | 默认 | 可写 |
| --- | --- | --- | --- |
| `enabled` | AI 能不能发语音的总闸 | `false` | ✅（操作者通道不受影响） |
| `maxSeconds` / `maxBytes` | 单条时长 / 体积上限 | 300 秒 / 20 MB | ✅ |
| `maxPerMinute` / `maxPerHour` | 频率上限，**0 = 不限** | 2 / 10 | ✅ |
| `defaultVolume` / `loudness` | 默认音量倍数 / 智能音量档位 | 1 / normal | ✅ |
| `autoReadback` | 发送后回读 record 段做落地校验 | `true` | ✅ |
| `allowAbsolutePath` | 绝对路径（对 AI 通道已不再放宽） | `false` | ✅（只读展示语义） |
| `dir` / `ffmpegPath` | 语音库目录 / ffmpeg 位置 | `audio` / 空 | ❌ 只读 |

**写入必须整份回写**：桥接的 `POST /api/socialV2/config` 对 `voice` 是浅合并，落地时
`cfg.socialV2 = {...cfg.socialV2, ...merged}` 会把提交的 `voice` **整体替换**运行时那一份，
只发补丁会抹掉 `dir` / `ffmpegPath` / `loudness`。所以：读全量 → 合并补丁 → 整份 POST。

**用量只能反推**：桥接的限流计数在内存（`voiceSendTimes`，重启清零）且无查询接口。
面板从 `state/bridge.log` 的 `[voice] ... 已发送语音` 行反推最近 1 分钟/1 小时条数；
日志行只有 `HH:MM:SS`（跨零点按「比现在还晚 ⇒ 昨天」纠正），日志本身有 2000 行上限并轮转。
⇒ **展示时必须标注这是近似值**，不能让操作者以为是权威计数。

**预检的两段式**（`POST /voice-check`）：

| 判据 | 谁算 | 为什么 |
| --- | --- | --- |
| 每分钟 / 每小时额度 | 本插件（离线） | 桥接的 `dryRun` 分支**刻意不查** `voiceBudgetCheck`（额度在真发成功后才记账），dryRun 帮不上忙 |
| 文本字数 / 预计时长 | 本插件（离线） | 合成前唯一的判断手段；按 5 字/秒保守估长 |
| 路径解析 / 时长 / 体积 / 白名单 | 桥接 `dryRun: true` | 权威结论，别自己复刻一套规则 |

## 3. 安装与形态

- 插件包目录：`C:\Users\faith\dsh-qq-console\`（独立于桥接仓库，便于单独升级）。
- 安装：`dsh plugin --profile desktop add C:\Users\faith\dsh-qq-console` → 在 profile 的
  `dsh.profile.bundles` 里出现 → 重启 DSH 生效。
- 两半：
  - **host**：在 DSH 宿主进程里跑，读 console-token、代理桥接 API、调 `schtasks`、暴露受限路由。
  - **client**：设置页 UI（DSH 设置里新开一节「QQ 桥接」）。
- 安全：host 路由只监听回环、必须通过 DSH 自身的浏览器鉴权/同源围栏；不把 console-token 发给浏览器
  （浏览器只跟插件 host 说话）。

## 4. 不做的事（避免越界）

- 不直接写 `config.json`（除了「硬开关」需要读写任务状态）。
- 不改 SnowLuma 的配置：它的 `runtime.json` 会被**运行中的内存值写回**（实测：我改过的
  `hookAutoLoad: true` 被它自己覆盖回 false），要改必须先停 SnowLuma。插件最多做「SnowLuma 进程状态」的展示。
- 不实现「群号备注 / 自动发现群名」等花活；先保证这几组控件可靠。
- 不去复刻桥接的语音校验规则（时长/体积/路径）：那是桥接的权威判断，面板只做转发 + 额度估算。