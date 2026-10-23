# dsh-qq-console

**在 [DeepSeek Harness](https://deepseek.com)（DSH）的设置页里，用图形界面控制本机的 [qq-bridge](https://github.com/Derpyu520/qq-bridge)。**

一个 DSH 插件：装上之后设置里多出一节「QQ 桥接」，把桥接的**开关、白名单、响应速度、等待锁**四组参数做成可点的控件——
不用再去翻 `config.json`、记控制台令牌、或者手敲 `curl`。

```
┌──────────────────────────────┐
│  DSH 设置页 →「QQ 桥接」      │   ← client/client.js（浏览器半，手写 ESM，无构建）
│  ① 开关与状态 ② 白名单        │
│  ③ 响应速度   ④ 等待锁        │
└──────────────┬───────────────┘
               │ fetch /dsh-qq-console/*（同源 + 回环围栏）
┌──────────────▼───────────────┐
│  DSH 宿主进程                 │   ← lib/index.js（宿主半，读令牌、转发、调任务计划）
└──────────────┬───────────────┘
               │ x-console-token
┌──────────────▼───────────────┐        ┌──────────────────────┐
│  qq-bridge 控制台 :3100       │        │ Windows 任务计划      │
│  /api/whitelist              │        │ DSH-qq-bridge        │
│  /api/socialV2/{config,      │        │ SnowLuma-QQ          │
│       activity}  /api/restart│        └──────────▲───────────┘
└──────────────────────────────┘                   │ schtasks（仅「硬开关」）
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
| `tools/*` | 无所谓，只有你手动跑时才用 |

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
| POST | `/dsh-qq-console/whitelist` | `{ allow:{groups,private}, deny:{groups}, ownerQQ }` |
| POST | `/dsh-qq-console/settings` | `{ autoReplyCheckMs?, wake?, send?, wait? }`（只放行白名单键） |
| POST | `/dsh-qq-console/activity` | `{ paused: true|false }` —— 软开关 |
| POST | `/dsh-qq-console/process` | `{ action: "start"|"stop"|"restart" }` —— 硬开关 |
| POST | `/dsh-qq-console/test-send` | `{ key, text }` —— 复用桥接的 `/api/test-send` |

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

三个脚本都是「退出码 0 = 通过」。用 DSH 自带的 node 跑（或任何 Node ≥ 20，需支持顶层 await）：

```powershell
# ① 离线冒烟 8 项：路由形状、回环围栏 403、真打桥接的聚合状态、字段投影、404、
#    客户端 __ModuleLoader__ 契约、settings.section 注册参数、组件可渲染
node tools\smoke.mjs

# ② 确认客户端半真的进了 GUI 的 boot 载荷，且所在合并请求 HTTP 200 含本插件源码
node tools\verify-client-bundle.mjs [http://127.0.0.1:<DSH_PORT>]

# ③ 真浏览器端到端：无头 Edge 打开 GUI → 设置 → 断言「QQ 桥接」面板渲染
node tools\browser-check.mjs [http://127.0.0.1:<DSH_PORT>]
```

依赖与可调项：

- ① 需要**桥接在跑**（宿主半的联网断言）；客户端半部分完全离线。
  计划任务相关的断言写成「解析必须给出确定布尔值」，所以**任务查询被限制的环境下不会误报失败**。
- ②③ 需要 **DSH 在跑**，并用桥接的 `src/dsh-client.js` **离线铸造浏览器会话 Cookie**
  （密钥来自 `~/.dsh/.credentials.yaml`）。相关路径可用 `DSH_QQ_BRIDGE_DIR` / `DSH_PROFILE_DIR` /
  `DSH_BASE_URL` / `EDGE_PATH` 覆盖。
- ③ 还需要 desktop profile 里有 `puppeteer-core`，以及系统装了 Edge。

## 目录结构

```
dsh-qq-console/
  package.json          # dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
  cordis.patch.yml      # 让 bundle 把本插件挂进 profile 的 layer 栈
  lib/index.js          # 宿主半：/dsh-qq-console/* 路由 + 回环围栏 + 任务计划开关（纯 ESM，无构建）
  client/client.js      # 浏览器半：__ModuleLoader__.load → settings.section 面板（纯 ESM，无构建）
  tools/smoke.mjs       # 冒烟：宿主半（假 req/res 真打桥接）+ 客户端半（最小 React 打桩）
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

## 相关项目 / License

- [qq-bridge](https://github.com/Derpyu520/qq-bridge) —— QQ ↔ DSH 的桥接本体，本插件是它的控制面板。
- SnowLuma —— OneBot v11 网关（QQ 侧）。

MIT License，见 [LICENSE](LICENSE)。