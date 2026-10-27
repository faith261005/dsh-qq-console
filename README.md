# dsh-qq-console

**在 [DeepSeek Harness](https://deepseek.com)（DSH）的设置页里，用图形界面控制本机的 [qq-bridge](https://github.com/Derpyu520/qq-bridge)。**

一个 DSH 插件：装上之后设置里多出一节「QQ 桥接」，把桥接的**开关、白名单、响应速度、等待锁**，
**发语音**，以及**QQ 侧允许调用哪些插件的工具**和**语音发送限制（含预检）**做成可点的控件——
不用再去翻 `config.json`、记控制台令牌、或者手敲 `curl`。

```
┌────────────────────────────────┐
│  DSH 设置页 →「QQ 桥接」        │   ← client/client.js（浏览器半，手写 ESM，无构建）
│  ① 开关与状态 ② 白名单          │
│  ③ 响应速度   ④ 等待锁          │
│  ⑤ 插件工具白名单               │
│  ⑥ 发语音     ⑦ 语音发送限制    │
└──────────────┬─────────────────┘
               │ fetch /dsh-qq-console/*（同源 + 回环围栏）
┌──────────────▼─────────────────┐
│  DSH 宿主进程                   │   ← lib/index.js（读令牌、转发、调任务计划、读写工具白名单）
└──────────────┬─────────────────┘
               │ x-console-token                      ┌──────────────────────┐
┌──────────────▼─────────────────┐                   │ Windows 任务计划      │
│  qq-bridge 控制台 :3100         │                   │ DSH-qq-bridge        │
│  /api/whitelist                │                   │ SnowLuma-QQ          │
│  /api/socialV2/{config,        │                   └──────────▲───────────┘
│       activity}  /api/restart  │                              │ schtasks（仅「硬开关」）
└────────────────────────────────┘
               │ ⑤ 直接把扩展项写进
┌──────────────▼─────────────────┐
│  state/tool-allowlist.json     │  ← QQ preset 的执行期守卫按 mtime/size 读它 ⇒ 改完即生效
└────────────────────────────────┘
```

## 设计取向：薄代理，不重写桥接逻辑

qq-bridge 自带的控制台 API 已经提供了这些能力，而且每个写操作都自己做**字段归一化 + 原子落盘 + 热更新**。
所以本插件**不直接改 `config.json`**（那样会和桥接的内存态打架），而是把写操作转发给桥接；
唯一自己动手的是「硬开关」——进程都停了就没有 API 了，只能走 Windows 任务计划。

| 能力 | 实现 | 底层端点 |
| --- | --- | --- |
| ① 桥接开关 | 软开关（暂停 AI 活动）+ 硬开关（停止/启动进程）+ 重启 | `POST /api/socialV2/activity`、`/api/restart`、`schtasks` |
| ② 白名单 | 群号 / 私聊号 / 黑名单 / 管理员 `ownerQQ` 增删 | `GET|POST /api/whitelist` |
| ③ 响应速度 | 逐项微调 + 慢/正常/快三档预设 | `POST /api/socialV2/config` |
| ④ 等待锁 | 等待预算、静默窗口、沉睡前观察窗口、租约诊断阈值 | `POST /api/socialV2/config` |
| ⑤ 插件工具白名单 | QQ 侧允许调用哪些**已装插件**的工具：增删精确名/前缀、已知工具一键添加（⚠️ 标出会碰本机画面/文件的） | 直接读写 `state/tool-allowlist.json`（守卫按 mtime/size 热读） |
| ⑥ 发语音 | 文本 → TTS 合成 → 落进桥接语音库 → 发成 QQ 语音条（含「预览（不发送）」） | `POST /dsh-tts-api/speak` + `GET /dsh-tts-audio/<id>` + `POST /api/voice/send`（桥接操作者通道） |
| ⑦ 语音发送限制（调试） | 改「能不能发/多长/多大/多快」+ 看实际用量 + **预检这一条现在会不会被拒** | `GET|POST /api/socialV2/config`（整份回写 voice）+ 读 `state/bridge.log` 反推额度 |

## 前置条件

- **DSH 桌面版**，profile = `desktop`（宿主半依赖 `webServer` 服务；客户端半依赖 `settings.section` 槽）。
  本项目在 DSH `0.2.1-rc.2` 上开发与验证。
- **qq-bridge** 已在本机跑起来（控制台 `http://127.0.0.1:3100`）。
- **Windows**：只有「硬开关」需要任务计划（`schtasks`）；其余功能在其它平台上也成立，
  但当前实现按 Windows 部署写的，非 Windows 下会显示「任务未找到」而软开关照常可用。
- 插件与桥接**同机同用户**：宿主半直接读桥接的 `state/console-token`，所以你不用填令牌。

## 安装

```powershell
# 本地目录安装（不发布到 npm）
dsh plugin --profile desktop add C:\path\to\dsh-qq-console
```

安装后：插件被写进 profile 的 `dsh.profile.bundles`（**热加载**），刷新页面即可在设置里看到「QQ 桥接」。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-qq-console
```

### 改动后的生效范围（实测，很容易踩）

| 改了什么 | 怎么生效 |
| --- | --- |
| `client/client.js`（浏览器半） | **刷新页面即可**（boot 载荷按请求重拼） |
| `lib/index.js`（宿主半） | **必须重启 DSH**（重新 install 也不会重新 import 已加载的模块） |
| `package.json` / `cordis.patch.yml` | 加/删插件时由 CLI 写进 `dsh.profile.bundles`，热加载 |
| `state/tool-allowlist.json`（⑤ 卡片写的那个文件） | **立即生效**：QQ preset 的执行期守卫按 `${file}:${mtime}:${size}` + 2 秒 TTL 缓存读取 |
| `plugins/qq-agent-presets/qq-tool-restrict.mjs`（⑤ 的**守卫代码**） | **必须重启 DSH**：它是 preset 里的一行 plugin，模块在 DSH 启动时装载 |
| `tools/*` | 无所谓，只有你手动跑时才用 |

## ⑤ 插件工具白名单是怎么生效的

QQ preset 的守卫（`qq-tool-restrict.mjs`）是一道**执行期**白名单：硬编码放行
`mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*`、`ask_user_question`、`todo_write`，
其余一律拒绝（`工具 "X" 不在 QQ 桥接白名单内，已拒绝`）。

它在硬编码之外还能读一个扩展文件：

```json
// <qq-bridge>/state/tool-allowlist.json
{ "allowedExact": ["send_meme", "vision_describe"],
  "allowedPrefixes": ["vision_"] }
```

- **只增不减**：文件缺失 / JSON 损坏 ⇒ 退回硬编码名单，绝不会因此放宽。
- 守卫按 `路径 + mtime + 文件大小` 缓存（外加 2 秒 TTL），所以**改文件即生效**，
  不用重建 preset、也不用重启 DSH。缓存键带 size/TTL 是因为 Windows 的 mtime 粒度较粗，
  面板连点两下可能落在同一毫秒里。
- 本机默认放行：dsh-meme 的 `send_meme`/`learn_meme`，dsh-vision-router 的看图/分析类；
  `vision_screenshot`（截本机桌面）、`vision_html_screenshot`、`vision_materialize`（写文件）、
  `vision_long_screenshot_ocr` 默认**不放**——它们会把本机画面/文件暴露给群里的人，面板里标 ⚠️ 可一键加。

## ⑥ 发语音是怎么接的（2026-10-25）

链路（每一环都实测过；`tools/say-voice.mjs` 是同一套调用的命令行版）：

```
文本 → POST <DSH>/dsh-tts-api/speak              （dsh-plugin-tts 的宿主路由，Edge TTS 免 key）
     → GET  <DSH>/dsh-tts-audio/<id>             MP3 字节（短句约 20~40 KB）
     → 写进 <qq-bridge>/audio/tts-*.mp3          桥接的「语音库」
     → POST <bridge>/api/voice/send {target,file}     桥接**操作者通道**
     → SnowLuma 网关把 MP3 转成 NT SILK → QQ 语音条
```

关键点：

- **不需要打开 `socialV2.voice.enabled` / `tools.sendVoice`**：那两个开关只管「AI 能不能自己发语音」，
  操作者通道由控制台令牌鉴权、且**明确不检查 enabled**（`bridge.js:5534-5537` 注释原文）。
  即：面板/命令行能代你发语音，而 AI 依旧没有这个能力。
- **不需要本机 ffmpeg**：SILK 编码在 SnowLuma 网关里做；桥接只在有 ffprobe 时才校验时长，
  没有就降级放行（返回 `warnings: ["无法探测时长（ffprobe 不可用…）"]`，**不影响发送**）。
- **落盘位置**取自桥接 `config.json` 的 `socialV2.voice.dir`（默认 `audio/`，相对桥接根目录）；
  文件名 `tts-<时间戳>-<随机>.mp3`，面板只保留最新 50 个。
- **音色**默认 `zh-CN-XiaoxuanNeural`；下拉只放**有直接证据的两个**，其余自己填。
- **上限 200 字**：QQ 语音条不宜太长，也让它留在 speak 的「单条」分支
  （插件的分块分支是给 >12 秒语音的流式播放）。
- 成功时带 `verified: true` —— 那是桥接**回读 `get_msg` 确认 record 段真的落地**，
  这是「语音确实发出去了」唯一可信的证据。
- 命令行直接发（不需要重启 DSH、不依赖面板）：

  ```powershell
  node tools\say-voice.mjs private:1104286533 "晚上好" zh-CN-XiaoxuanNeural
  node tools\say-voice.mjs group:706109857 "在的" --dry      # 预检：只合成，不发送
  ```

### 超时与「默认声音」（实测教训，2026-10-25）

- **超时**：本地克隆引擎（CosyVoice）冷启动可达数十秒。原来这里写死 **30 秒**，结果 AI 第一次调
  `qq_say_voice` 恰好在 30 秒被 abort（插件侧反而没报错——它的内部超时是 60s/900s，**我这条链才是最紧的**）。
  现在：合成 **240s**、取音频 **120s**，可用环境变量覆盖（宿主半改动**需重启 DSH**）：

  ```powershell
  $env:DSH_QQ_TTS_TIMEOUT_MS = '240000'        # 合成超时
  $env:DSH_QQ_TTS_AUDIO_TIMEOUT_MS = '120000'  # 取音频超时
  ```

- **预热**：CosyVoice 服务端 `--warm` = 加载模型 **+ 跑一次最小合成**（另有 `--keep-warm-minutes`，默认 10）。
  预热用「提示音频 + 同名 `.txt` 文字稿」预注册说话人；所以**给你的录音留一份同名文字稿**（`mine.wav` +
  `mine.txt`）就能自动预热，也保证首次真实请求命中说话人缓存。实测同一段长文本：冷启动 >30s（被掐断）→
  跳过预热 25.2s → **预热后 7.6s**；AI 自己调用则是 **5 秒一次成功**。

- **默认声音**（`<bridge>/state/qq-voice.json`）决定 AI/命令行用哪个引擎与音色；切换用
  `node tools\set-voice.mjs`（`edge-tts` / `rvc` / `index-tts2` / `cosyvoice`）。

### 「以语音为主」开关（2026-10-25）

卡片上那个 **发言方式 / 以语音为主** 按钮写的是桥接的 `socialV2.voice.preferVoice`，路由
`GET|POST /dsh-qq-console/voice-policy`。

- 这条要求由**桥接在每一回合的提示词里下发**（`bridge.js` 的 `voicePolicyBlock()` 挂在 `withSlangContext` 上），
  所以：① 覆盖**所有**会话与所有唤醒路径；② 切换后**只需桥接侧生效（几秒），不用重启 DSH**。
- **缺省即开启**：`preferVoice` 只在显式 `false` 时关闭 —— 面板整份回写 voice 时不会误关它。
- 含义是"能用 `qq_say_voice` 说就用语音"；长内容 / 需精确转达（数字、路径、链接、清单）/ 语音合成失败 /
  对方要求打字时仍用文字。
- 写回必须是**整份 voice 对象**（`/api/socialV2/config` 对 `voice` 是整体替换，只发一个键会抹掉 `dir`、
  限流、`enabled` 等）。宿主半已按此实现，冒烟里也有"不丢字段"的断言。

## ⑥ 的分会话语音开关（2026-10-25 细化）

「以语音为主」现在可以**按群 / 按私聊**分别覆盖全局（⑥ 卡片里的那张表）：

| 路由 | 作用 |
|---|---|
| `GET /dsh-qq-console/voice-sessions` | 会话清单 + 每个会话的当前模式 + 全局态 |
| `POST /dsh-qq-console/voice-sessions` | `{ key: "group:群号"\|"private:QQ号", mode: "voice"\|"text"\|"inherit" }` |

- 数据落在桥接 `socialV2.voice.perSession[key].preferVoice`（`true`=语音优先 / `false`=只用文字 / 缺省=跟随全局）；
  `mode=inherit` 是把该 key **删掉**，不是写 `true`。
- **三层一致才有效**：① 桥接每回合按 key 下发要求（`voicePolicyBlock(key)`，改完**桥接侧即生效**，无需重启 DSH）；
  ② `qq_say_voice` 在该会话为「只用文字」时**直接拒绝**（提示词能被绕过，工具才是真门禁）；
  ③ 面板 ⑥ 卡片那张表（这一条要重启一次 DSH 才有）。
- 候选项 = 白名单里的会话 **+ 桥接日志尾部出现过的最近会话**（"按聊天记录"）。
- 行为验证：把某私聊设为「只用文字」后投一条控制端指令 → 它只调 `qq_send_message`、`qq_say_voice` 0 次 ✓。

## ⑦ 语音发送限制（调试）是怎么接的

桥接的 `socialV2.voice` 里有一整套限制，但它们散在 `config.json` 里，而且**没有任何一处 UI
会告诉你「这一条现在会不会被拒」**。这张卡片补的就是这件事。

### 可写的限制

| 键 | 含义 | 默认 | 面板范围 |
| --- | --- | --- | --- |
| `enabled` | **AI 能不能发语音**的总闸（操作者通道不受影响） | `false` | 开/关 |
| `maxSeconds` | 单条时长上限 | 300 | 1 ~ 3600 |
| `maxBytes` | 单条体积上限 | 20 MB | 64 KB ~ 100 MB |
| `maxPerMinute` | 每分钟上限，**0 = 不限** | 2 | 0 ~ 120 |
| `maxPerHour` | 每小时上限，**0 = 不限** | 10 | 0 ~ 2000 |
| `defaultVolume` | 默认音量倍数（1 = 原样） | 1 | 0.1 ~ 4 |
| `loudness` | 智能音量档位 | `normal` | quiet / normal / loud |
| `autoReadback` | 发送后自动回读校验 record 段 | `true` | 开/关 |
| `allowAbsolutePath` | 允许绝对路径（**对 AI 通道已不再放宽**） | `false` | 开/关 |
| `dir` / `ffmpegPath` | 语音库目录 / ffmpeg 位置 | `audio` / 空 | **只读展示** |

> ⚠️ `maxPerMinute: 0` 是「不限」（桥接用 `>= 0` 判断），但 `maxSeconds: 0` 不是「不限」——
> 它会退回默认 300 秒，所以面板的最小值给 1，免得你以为关掉了。

### 为什么改限制要「整份回写」

桥接的 `POST /api/socialV2/config` 对 `voice` 是**浅合并**（`merged = {...current, ...body}`），
而运行时落地是 `cfg.socialV2 = {...cfg.socialV2, ...merged}` —— 我们提交的 `voice` 对象会**整体替换**
运行时那一份。只发 `{maxPerMinute: 5}` 会把 `dir` / `ffmpegPath` / `loudness` 一起抹掉。

所以宿主半先 `GET` 全量、合并补丁、再整份 `POST` 回去；`tools/smoke.mjs` 里有一条专门的回归断言
（「只发补丁不该把 dir / ffmpegPath 抹掉」）。

### 实际用量是**近似值**（重要）

桥接的限流计数器在内存里（`voiceSendTimes`，按 scope 分桶），**重启即清零**，也没有查询接口。
面板显示的是从 `state/bridge.log` 的 `[voice] ... 已发送语音` 行**反推**的：

- 日志行只有 `HH:MM:SS` 没有日期 ⇒ 跨零点靠「时间戳比现在还晚 ⇒ 当昨天」纠正；
- 桥接日志有 2000 行上限并轮转（`.1`），非常密集时更早的行可能已经丢了。

排查「为什么现在发不出去了」够用，但**别拿它当权威计数**。

### 预检（`POST /voice-check`）

不发送，逐条判定「这一条现在会不会被拒」，两段各补对方的短板：

| 判据 | 谁算的 | 说明 |
| --- | --- | --- |
| 每分钟 / 每小时额度 | 本插件（离线） | 桥接的 dryRun 分支**刻意不查** `voiceBudgetCheck`（额度只在真发出去后才记账），所以限流只能靠日志反推 |
| 文本字数 / 预计时长 | 本插件（离线） | 中文 TTS 约 5 字/秒，保守估长；真实时长要用「预览」合成后看 |
| 路径解析 / 时长 / 体积 / 白名单 | 桥接（`dryRun: true`） | 权威结论：文件太大、太长、不在库里、目标不在白名单都由它说了算 |

### 命令行等价物（**不用重启 DSH**）

```powershell
node tools\voice-limits.mjs                       # 看限制 + 用量 + 语音库
node tools\voice-limits.mjs --check               # 预检：现在还能不能发
node tools\voice-limits.mjs --check --text="晚上好" --file=tts-xxx.mp3
node tools\voice-limits.mjs --set maxPerMinute=5 --set maxSeconds=120
node tools\voice-limits.mjs --reset               # 恢复默认（保留 dir / ffmpegPath）
```

> 面板第 ⑦ 张卡片要**重启一次 DSH** 才出现（宿主半改动不热加载）；这个脚本直接跟桥接控制台 API
> 说话，改完即生效。

## 配置

宿主半的四个常量都能用环境变量覆盖（**在 DSH 宿主进程的环境里**设置，即启动 DSH 之前）：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_QQ_BRIDGE_DIR` | `C:\Users\faith\qq-bridge` | 桥接目录（读 `state/console-token`、`state/bridge.log`） |
| `DSH_QQ_BRIDGE_API` | `http://127.0.0.1:3100` | 桥接控制台地址 |
| `DSH_QQ_BRIDGE_TASK` | `DSH-qq-bridge` | 桥接的保活计划任务名（硬开关用） |
| `DSH_QQ_SNOWLUMA_TASK` | `SnowLuma-QQ` | SnowLuma 的计划任务名（只用来显示状态） |

> 桥接控制台令牌是**每次请求现读** `state/console-token` 的，所以控制台换令牌后不用重启插件。

## HTTP 路由

宿主半暴露一组前缀路由，全部要求**回环来源 + 回环 Host**（非回环或伪造 Host 一律 `403`）。
浏览器半只用它们；令牌从不下发到浏览器。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-qq-console/state` | 聚合状态：桥接探活、任务状态、暂停态、白名单、配置投影、最近 `[wait]` 日志 |
| GET | `/dsh-qq-console/settings` | 只回面板关心的配置字段（不泄露整份 `socialV2`） |
| GET | `/dsh-qq-console/waitlog` | 最近 60 条带 `[wait]` 的桥接日志（排「等待锁卡住」用） |
| GET | `/dsh-qq-console/voice-limits` | 语音限制 + 从日志反推的实际用量 + 语音库清单 + 最近的 `[voice]` 日志 |
| POST | `/dsh-qq-console/voice-limits` | 改限制（整份回写 voice）；`{ reset: true }` 恢复默认（保留 dir / ffmpegPath） |
| POST | `/dsh-qq-console/voice-check` | 预检 `{ text?, file?, key? }` —— 不发送，逐条判「会不会被拒」 |
| POST | `/dsh-qq-console/whitelist` | `{ allow:{groups,private}, deny:{groups}, ownerQQ }` |
| POST | `/dsh-qq-console/settings` | `{ autoReplyCheckMs?, wake?, send?, wait? }`（只放行白名单键） |
| POST | `/dsh-qq-console/activity` | `{ paused: true|false }` —— 软开关 |
| POST | `/dsh-qq-console/process` | `{ action: "start"|"stop"|"restart" }` —— 硬开关 |
| POST | `/dsh-qq-console/test-send` | `{ key, text }` —— 复用桥接的 `/api/test-send` |
| GET | `/dsh-qq-console/stack-status` | **整套栈状态**：4 个计划任务、2 个登录自启、DSH 的 MCP 注册开关、相关进程数、端口、内存 |
| POST | `/dsh-qq-console/stack-stop` | **整套停止**（断自启 → 关 MCP 注册 → 杀进程 → 复查）；`{ dryRun: true }` 只预演 |
| POST | `/dsh-qq-console/stack-start` | **整套启动**：`{ withVoice?, voice?: "both"\|"rvc"\|"cosy", dryRun? }` |
| GET | `/dsh-qq-console/whitelist-candidates` | **② 按钮开关的数据源**：所有群/联系人 + 名字 + 当前 `allowed`/`denied`（`?refresh=1` 重拉名字） |

### ① 卡片里的「整套启停」（2026-10-25）

只"停桥接进程"是不够的：SnowLuma、RVC/CosyVoice 各有**三套保活**（计划任务每分钟、HKCU 登录自启、
DSH 的 MCP 注册会被按需重启），直接杀会被立刻拉回来。所以 ① 卡片新增一组按钮：

`查看状态` / `整套停止` / `整套启动` / `整套启动（含语音）`

- 完整顺序：**断自启 → 关 DSH 的 MCP 注册 → 杀进程 → 复查**；
- 实现只有一份：桥接目录的 `stop-qq-stack.ps1` / `start-qq-stack.ps1`（`.cmd` 双击壳同源，
  日志追加在 `state\stop-qq-stack.log`），上面三条路由只是薄封装；
- `整套启动` 默认**不**拉语音服务（它们各占数 GB 内存/显存）；要语音点带括号那个；
- **MCP 子进程与 QQ 工具（`mcp__snowluma__*`）都要重启一次 DSH 才会真正消失/回来**。

> 关 MCP 注册时只注释 `cordis.patch.yml` 里三段 `- insert:`（加 `# [qq-stack-off] ` 前缀），
> **不能按 BEGIN/END 标记整体注释**——那两张无关条目（`ui-settings-general` 设置界面、`pet` 桌宠）
> 就夹在标记之间，会被一起关掉。改这个文件也**只能用文本级替换**，绝不能用 `-split`/`-join` 重排行。

在线自检（需要 DSH 在跑，端口见 DSH 运行时上下文）：

```powershell
curl.exe -s http://127.0.0.1:<DSH_PORT>/dsh-qq-console/state
```

## 面板细节

### ③ 响应速度（三档预设）

| 键 | 含义 | 慢 | 正常 | 快 |
| --- | --- | --- | --- | --- |
| `wake.batchWindowMs` | 多条消息合并成一个唤醒的窗口 | 20000 | 8000 | 3000 |
| `autoReplyCheckMs` | 回复后多久回来检查是否有人接话 | 60000 | 30000 | 15000 |
| `send.gapBaseMs` / `gapPerCharMs` | 分条发送的基础间隔 / 每字增量 | 1500 / 30 | 800 / 20 | 400 / 10 |
| `send.burstIntervalMinMs` / `MaxMs` | 连发多条的间隔区间 | 2000 / 5000 | 1000 / 3000 | 600 / 1500 |
| `send.maxSendPerMinute` / `maxSendPerHour` | 发送限速 | 4 / 30 | 8 / 60 | 12 / 120 |
| `wake.maxWakePerMinute` / `maxWakePerHour` | 唤醒限速 | 1 / 6 | 1 / 12 | 2 / 24 |
| `wake.recommendedProbability` | 普通消息唤醒概率 | 0.02 | 0.05 | 0.15 |

> 调到极端「快」会让 AI 更像客服、更容易抢话——面板上有这句提醒，慎用。

### ④ 等待锁

| 键 | 含义 | 备注 |
| --- | --- | --- |
| `wait.minMs` / `defaultMs` / `maxMs` | 单次等待预算的下限/默认/上限 | `maxMs` 别超过 DSH 的 `toolCallTimeoutMs` |
| `wait.defaultQuietMs` / `minQuietAfterNewMs` | 静默窗口默认值 / 收到新消息后的最小静默 | 越小越容易抢话 |
| `wake.preSleepWaitMs` | 收尾前的沉睡前观察窗口 | 与 preset 提示词里的 `timeoutMs` 必须一致，改了要重启 DSH 才同步到人设 |
| `wait.leaseMs` | 「一次等待正常能占多久」的诊断阈值 | `0` = 用默认 15 分钟；**只影响日志判据，不拒绝新等待** |

另有一段只读信息：**最近被接管的等待记录**（从 `state/bridge.log` 筛 `[wait]`）——
桥接的等待租约是「新的等待接管旧的」，这份记录是排查「等待锁卡住」的第一手证据。

## 安全模型

- **回环围栏**：只允许 `127.0.0.1` / `::1` 来源，且 `Host` 必须是回环字面量。
  这与 DSH 官方插件族（如 `pair-access`）同档：**本机能访问即放行**。
  ⇒ 因此**不要把 DSH 的 webserver 绑到非回环地址**。
- **令牌不出宿主**：`state/console-token` 只被 DSH 宿主进程读取，浏览器拿不到它；
  浏览器只跟插件的宿主半说话。
- **写入白名单**：`/settings` 只放行面板确实支持的键，避免误把整份 `socialV2` 覆盖进去。
- 本插件**不碰 SnowLuma 的配置**（它的 `runtime.json` 会被运行中的内存值写回，要改必须先停进程），
  最多展示它的任务状态。

## 自测

四个脚本都是「退出码 0 = 通过」。用 DSH 自带的 node 跑（或任何 Node ≥ 20，需支持顶层 await）：

```powershell
# ① 离线冒烟 17 项：路由形状、回环围栏 403、真打桥接的聚合状态、字段投影、404、
#    ⑤ 工具白名单路由（读 / 非法名 400 / 增删往返并还原）、
#    ⑥ 语音路由（/tts-status 形状 + /say 三类参数校验都在联网前返回）、
#    ⑦ 语音限制路由（形状 / 越界 400 / 增改往返并还原且不抹掉 dir、ffmpegPath / 预检判定）、
#    客户端 __ModuleLoader__ 契约、settings.section 注册参数、组件可渲染
node tools\smoke.mjs

# ② 确认客户端半真的进了 GUI 的 boot 载荷，且所在合并请求 HTTP 200 含本插件源码
node tools\verify-client-bundle.mjs [http://127.0.0.1:<DSH_PORT>]

# ③ 真浏览器端到端：无头 Edge 打开 GUI → 设置 → 断言「QQ 桥接」面板渲染
node tools\browser-check.mjs [http://127.0.0.1:<DSH_PORT>]

# ④ QQ 工具白名单守卫（完全离线，6 项）：
#    内置项仍放行/fail-closed 不变、名单里的工具放行、风险项默认仍被拒、
#    QQ_TOOL_ALLOWLIST=off 退回硬编码、改文件即生效（不重新 apply）、preset 壳一致
node tools\guard-check.mjs
```

依赖与可调项：

- ① 需要**桥接在跑**（宿主半的联网断言）；客户端半部分完全离线。
  计划任务相关的断言写成「解析必须给出确定布尔值」，所以**任务查询被限制的环境下不会误报失败**。
- ②③ 需要 **DSH 在跑**，并用桥接的 `src/dsh-client.js` **离线铸造浏览器会话 Cookie**
  （密钥来自 `~/.dsh/.credentials.yaml`）。相关路径可用 `DSH_QQ_BRIDGE_DIR` / `DSH_PROFILE_DIR` /
  `DSH_BASE_URL` / `EDGE_PATH` 覆盖。
- ③ 还需要 desktop profile 里有 `puppeteer-core`，以及系统装了 Edge。
- ④ 完全离线：它直接 import 桥接仓库里的守卫模块，用假 `ctx.tools` 捕获 guard 回调后逐条断言。

## 目录结构

```
dsh-qq-console/
  package.json          # dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
  cordis.patch.yml      # 让 bundle 把本插件挂进 profile 的 layer 栈
  lib/index.js          # 宿主半：/dsh-qq-console/* 路由 + 回环围栏 + 任务计划开关（纯 ESM，无构建）
  client/client.js      # 浏览器半：__ModuleLoader__.load → settings.section 面板（纯 ESM，无构建）
  tools/smoke.mjs       # 冒烟：宿主半（假 req/res 真打桥接）+ 客户端半（最小 React 打桩）
  tools/voice-limits.mjs          # 命令行版「语音限制调试」：看限制/用量、--check 预检、--set 改、--reset
  tools/say-voice.mjs             # 命令行发一条语音（不依赖 DSH 重启）
  tools/verify-client-bundle.mjs  # 校验 GUI boot 载荷与合并请求里确有本插件
  tools/browser-check.mjs         # 无头 Edge 端到端断言面板渲染
  tools/asar.mjs        # 只读的 app.asar 解包器（当初用它摸 DSH 插件 API）
  DESIGN.md             # 功能与接口设计、每个旋钮的含义与默认值
```

> **没有 `refs/` 目录**：开发时曾把 DSH 自带 `app.asar` 里的框架包解出来当 API 参考，
> 那是第三方（DeepSeek）的代码，**不随本仓库分发**；`.gitignore` 里也忽略了它。

## 踩坑记录（都是实测）

1. **中文 Windows 上 `schtasks /FO LIST` 的输出不可解析**：字段名是本地化的（「状态：」），
   用 utf8 读进来是乱码 → 「已禁用」被解析成空串，按钮方向判断反了。
   改用 `/XML`：`<Settings>` 里的 `<Enabled>true|false</Enabled>` 是语言无关的。
2. **任务启用时 XML 会省略 `<Enabled>`**（schema 默认 true），只有禁用时才出现 `<Enabled>false</Enabled>`。
   所以判据是「有没有 `false`」，不是「有没有 `true`」。
3. **硬开关必须先禁用保活触发器**：桥接任务带「每 1 分钟重复」的触发器，
   只 `Stop-Process`／`/End` 的话 ≤1 分钟就被拉回来。正确顺序是 `/Change /DISABLE` → `/End`。
4. **`wake.preSleepWaitMs` 与 preset 提示词会不一致**：preset 只在 DSH 启动时装配，
   所以面板改了观察窗口后，人设提示词里的 `timeoutMs` 还是旧值——要两边一致就重启一次 DSH。
5. **桥接控制台的「沉睡前强制等待」字段单位是分钟**，10 秒的窗口会显示成 `0`
   （`0` = 用后台默认值，不是「关闭」）。
6. **`socialV2.voice` 在桥接里是「整体替换」不是深合并**：`POST /api/socialV2/config` 的
   `merged` 是浅合并，落地时 `cfg.socialV2 = {...cfg.socialV2, ...merged}` —— 只提交
   `{voice: {maxPerMinute: 5}}` 会把 `dir` / `ffmpegPath` / `loudness` 一起抹成默认值。
   改单个限制项必须**先读全量、合并、再整份回写**。
7. **桥接的 `dryRun` 分支不查限流**：`/api/voice/send` 的 dryRun 走的是「解析 + inspectAudio +
   白名单」，`voiceBudgetCheck` 只在真发之前调（额度发成功后才记账）。所以「这一条会不会被限流拒」
   只能靠日志反推，dryRun 帮不上忙。

## 相关项目 / License

- [qq-bridge](https://github.com/Derpyu520/qq-bridge) —— QQ ↔ DSH 的桥接本体，本插件是它的控制面板。
- SnowLuma —— OneBot v11 网关（QQ 侧）。

MIT License，见 [LICENSE](LICENSE)。