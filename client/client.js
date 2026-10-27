/**
 * dsh-qq-console — 浏览器半（设置页「QQ 桥接」面板）。
 *
 * 形态说明（照抄 DSH 自带客户端插件的加载方式，实测自 @deepseek-ai/dsh-client-ui-settings-plugins
 * 的 lib/client.js）：一个普通脚本调用 window.__ModuleLoader__.load({ id, factory })，
 * factory 里 require 宿主提供的模块，最后导出 apply(ctx) 与 inject。
 * **不需要任何构建步骤** —— 与那些几 MB 的打包产物不同，这个文件是手写的纯 ESM。
 *
 * UI 只做四组：开关 / 白名单 / 响应速度 / 等待锁，全部通过宿主半的
 * /dsh-qq-console/* 路由读写（宿主半再去转发桥接 API）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-qq-console';

    /** 响应速度可调项：[扁平键, 中文名, 单位] */
    const SPEED_FIELDS = [
      ['wake.batchWindowMs', '合并唤醒窗口', 'ms'],
      ['autoReplyCheckMs', '回复后回来检查间隔', 'ms'],
      ['send.gapBaseMs', '分条基础间隔', 'ms'],
      ['send.gapPerCharMs', '分条每字增量', 'ms/字'],
      ['send.burstIntervalMinMs', '连发最小间隔', 'ms'],
      ['send.burstIntervalMaxMs', '连发最大间隔', 'ms'],
      ['send.maxSendPerMinute', '每分钟发送上限', '条'],
      ['send.maxSendPerHour', '每小时发送上限', '条'],
      ['wake.maxWakePerMinute', '每分钟唤醒上限', '次'],
      ['wake.maxWakePerHour', '每小时唤醒上限', '次'],
      ['wake.recommendedProbability', '普通消息唤醒概率', '0~1'],
    ];
    /** 等待锁可调项 */
    const WAIT_FIELDS = [
      ['wait.minMs', '单次等待下限', 'ms'],
      ['wait.defaultMs', '单次等待默认预算', 'ms'],
      ['wait.maxMs', '单次等待上限', 'ms'],
      ['wait.defaultQuietMs', '默认静默窗口', 'ms'],
      ['wait.minQuietAfterNewMs', '收到新消息后的最小静默', 'ms'],
      ['wake.preSleepWaitMs', '收尾前的沉睡前观察窗口', 'ms'],
      ['wait.leaseMs', '等待租约诊断阈值（0 = 用默认 15 分钟）', 'ms'],
    ];
    /**
     * ⑦ 语音发送限制可调项：[键, 中文名, 单位/说明, 输入类型]
     * 与宿主半的 VOICE_LIMIT_RULES 一一对应（宿主半才是校验权威，这里只负责渲染）。
     */
    const VOICE_LIMIT_FIELDS = [
      ['maxSeconds', '单条时长上限', '秒', 'int'],
      ['maxPerMinute', '每分钟上限', '条（0 = 不限）', 'int'],
      ['maxPerHour', '每小时上限', '条（0 = 不限）', 'int'],
      ['maxBytesMB', '单条体积上限', 'MB', 'number'],
      ['defaultVolume', '默认音量倍数', '0.1 ~ 4（1 = 原样）', 'number'],
    ];
    /** 三档预设：只覆盖上面出现过的键 */
    const PRESETS = {
      slow: {
        'wake.batchWindowMs': 20000, autoReplyCheckMs: 60000,
        'send.gapBaseMs': 1500, 'send.gapPerCharMs': 30,
        'send.burstIntervalMinMs': 2000, 'send.burstIntervalMaxMs': 5000,
        'send.maxSendPerMinute': 4, 'send.maxSendPerHour': 30,
        'wake.maxWakePerMinute': 1, 'wake.maxWakePerHour': 6, 'wake.recommendedProbability': 0.02,
      },
      normal: {
        'wake.batchWindowMs': 8000, autoReplyCheckMs: 30000,
        'send.gapBaseMs': 800, 'send.gapPerCharMs': 20,
        'send.burstIntervalMinMs': 1000, 'send.burstIntervalMaxMs': 3000,
        'send.maxSendPerMinute': 8, 'send.maxSendPerHour': 60,
        'wake.maxWakePerMinute': 1, 'wake.maxWakePerHour': 12, 'wake.recommendedProbability': 0.05,
      },
      fast: {
        'wake.batchWindowMs': 3000, autoReplyCheckMs: 15000,
        'send.gapBaseMs': 400, 'send.gapPerCharMs': 10,
        'send.burstIntervalMinMs': 600, 'send.burstIntervalMaxMs': 1500,
        'send.maxSendPerMinute': 12, 'send.maxSendPerHour': 120,
        'wake.maxWakePerMinute': 2, 'wake.maxWakePerHour': 24, 'wake.recommendedProbability': 0.15,
      },
    };

    const CSS = {
      wrap: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary)' },
      h2: { margin: 0, fontSize: 18, fontWeight: 600 },
      intro: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
      card: { border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
      cardTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      label: { flex: '0 0 220px', fontSize: 13 },
      input: { width: 96, padding: '4px 6px', fontSize: 13, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'inherit' },
      area: { width: '100%', minHeight: 62, padding: 6, fontSize: 13, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'inherit', fontFamily: 'inherit' },
      btn: { padding: '5px 12px', fontSize: 13, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btnPrimary: { padding: '5px 12px', fontSize: 13, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'var(--dsw-alias-state-business-primary, #4d6bfe)', color: '#fff', cursor: 'pointer' },
      // 会碰到本机画面/文件的工具用虚线警示边框区分，避免和普通项混在一起
      btnRisk: { padding: '5px 12px', fontSize: 13, border: '0.5px dashed var(--dsw-alias-state-warning-primary, #d68a00)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      err: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d33)' },
      ok: { fontSize: 13, color: 'var(--dsw-alias-state-success-primary, #2a2)' },
      log: { maxHeight: 140, overflow: 'auto', fontSize: 12, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', margin: 0, color: 'var(--dsw-alias-label-tertiary)' },
    };

    async function api(pathname, options) {
      const res = await fetch(`${API}${pathname}`, {
        method: options?.method ?? 'GET',
        headers: options?.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 400) }; }
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    }

    function toNumber(value, fallback) {
      const n = Number(String(value ?? '').trim());
      return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : fallback;
    }
    const parseList = (text) => String(text ?? '').split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);

    function InputRow(key, title, unit, value, onChange) {
      return h('div', { style: CSS.row, key },
        h('label', { style: CSS.label }, title),
        h('input', {
          type: 'text', inputMode: 'decimal', style: CSS.input, value: value ?? '',
          onChange: (e) => onChange(key, e.target.value),
        }),
        h('span', { style: CSS.meta }, unit)
      );
    }

    function QqBridgeSection() {
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState({});
      const [groups, setGroups] = React.useState('');
      const [privates, setPrivates] = React.useState('');
      const [denyGroups, setDenyGroups] = React.useState('');
      const [ownerQQ, setOwnerQQ] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState(null);
      const [note, setNote] = React.useState(null);
      // ⑤ 插件工具白名单：扩展项 + 内置项 + 已知工具目录
      const [tools, setTools] = React.useState(null);
      const [newTool, setNewTool] = React.useState('');
      // ⑥ 发语音（TTS → QQ）：就绪状态 + 表单 + 结果
      const [tts, setTts] = React.useState(null);
      const [say, setSay] = React.useState({ key: '', text: '', voice: '', provider: '' });
      const [sayResult, setSayResult] = React.useState(null);
      // 「以语音为主」开关（写桥接 socialV2.voice.preferVoice；桥接每回合下发要求）
      const [policy, setPolicy] = React.useState(null);
      // 整套 QQ 栈的启停（桥接 + SnowLuma + 语音服务 + 自启 + DSH 的 MCP 注册）
      const [stack, setStack] = React.useState(null);
      const [stackOut, setStackOut] = React.useState(null);
      // 分会话语音开关（覆盖全局 preferVoice）
      const [sessions, setSessions] = React.useState(null);
      // ⑦ 语音发送限制（调试）：限制 + 用量 + 语音库 + 预检结果
      const [vlim, setVlim] = React.useState(null);
      const [vform, setVform] = React.useState({});
      const [vcheck, setVcheck] = React.useState(null);
      const [vfile, setVfile] = React.useState('');

      const load = React.useCallback(async () => {
        setErr(null);
        try {
          const data = await api('/state');
          setState(data);
          const cfg = data.config ?? {};
          const flat = {
            autoReplyCheckMs: cfg.autoReplyCheckMs,
            ...Object.fromEntries(Object.entries(cfg.wake ?? {}).map(([k, v]) => [`wake.${k}`, v])),
            ...Object.fromEntries(Object.entries(cfg.send ?? {}).map(([k, v]) => [`send.${k}`, v])),
            ...Object.fromEntries(Object.entries(cfg.wait ?? {}).map(([k, v]) => [`wait.${k}`, v])),
          };
          setForm(flat);
          const wl = data.whitelist ?? {};
          setGroups((wl.allow?.groups ?? []).join('\n'));
          setPrivates((wl.allow?.private ?? []).join('\n'));
          setDenyGroups((wl.deny?.groups ?? []).join('\n'));
          setOwnerQQ(wl.ownerQQ == null ? '' : String(wl.ownerQQ));
          try { setTools(await api('/tools')); } catch { /* 白名单读不出来不该拖垮整页 */ }
          try { setTts(await api('/tts-status')); } catch { /* TTS 插件没装/没起来时不该拖垮整页 */ }
          try { setPolicy(await api('/voice-policy')); } catch (error) {
            // 宿主半还没重启时这条路由是 404。**不能静默吞掉**：否则按钮会渲染成"未知状态"且被禁用，
            // 用户点它既没反应也没提示（2026-10-25 踩到）。这里显式记下"未就绪"，由卡片说明原因。
            const msg = String(error?.message ?? error);
            setPolicy({ unavailable: /404/.test(msg), preferVoice: null, error: msg });
          }
          try { setStack(await api('/stack-status')); } catch { /* 宿主半没重启时这条路由也会 404，不拖垮整页 */ }
          try { setSessions(await api('/voice-sessions')); } catch { /* 同上 */ }
          try { setCand(await api('/whitelist-candidates')); } catch { /* ② 的候选列表：读不到就让用户点「刷新群/联系人」 */ }
          try {
            const vl = await api('/voice-limits');
            setVlim(vl);
            setVform({
              maxSeconds: vl.limits?.maxSeconds,
              maxPerMinute: vl.limits?.maxPerMinute,
              maxPerHour: vl.limits?.maxPerHour,
              maxBytesMB: vl.limits?.maxBytes ? Math.round((vl.limits.maxBytes / 1024 / 1024) * 10) / 10 : 20,
              defaultVolume: vl.limits?.defaultVolume,
              enabled: vl.limits?.enabled === true,
              loudness: vl.limits?.loudness ?? 'normal',
              autoReadback: vl.limits?.autoReadback !== false,
              allowAbsolutePath: vl.limits?.allowAbsolutePath === true,
            });
            setVfile((prev) => (prev ? prev : (vl.library?.files?.[0]?.name ?? '')));
          } catch { /* 宿主半还没加载新路由时不该拖垮整页（第 ⑦ 张卡片会提示） */ }
          // 目标默认填第一个允许的群，省得每次手打
          setSay((prev) => (prev.key ? prev : { ...prev, key: (wl.allow?.groups ?? [])[0] ? `group:${wl.allow.groups[0]}` : '' }));
        } catch (error) {
          setErr(String(error?.message ?? error));
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const run = async (fn, okNote) => {
        setBusy(true); setErr(null); setNote(null);
        try { await fn(); if (okNote) setNote(okNote); await load(); }
        catch (error) { setErr(String(error?.message ?? error)); }
        finally { setBusy(false); }
      };

      const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

      const saveSpeed = () => run(() => api('/settings', {
        method: 'POST',
        body: {
          autoReplyCheckMs: toNumber(form.autoReplyCheckMs, 30000),
          wake: {
            batchWindowMs: toNumber(form['wake.batchWindowMs'], 8000),
            maxWakePerMinute: toNumber(form['wake.maxWakePerMinute'], 1),
            maxWakePerHour: toNumber(form['wake.maxWakePerHour'], 12),
            recommendedProbability: toNumber(form['wake.recommendedProbability'], 0.05),
          },
          send: {
            gapBaseMs: toNumber(form['send.gapBaseMs'], 800),
            gapPerCharMs: toNumber(form['send.gapPerCharMs'], 20),
            burstIntervalMinMs: toNumber(form['send.burstIntervalMinMs'], 1000),
            burstIntervalMaxMs: toNumber(form['send.burstIntervalMaxMs'], 3000),
            maxSendPerMinute: toNumber(form['send.maxSendPerMinute'], 8),
            maxSendPerHour: toNumber(form['send.maxSendPerHour'], 60),
          },
        },
      }), '响应速度已写入');

      const saveWait = () => run(() => api('/settings', {
        method: 'POST',
        body: {
          wait: {
            minMs: toNumber(form['wait.minMs'], 5000),
            defaultMs: toNumber(form['wait.defaultMs'], 30000),
            maxMs: toNumber(form['wait.maxMs'], 600000),
            defaultQuietMs: toNumber(form['wait.defaultQuietMs'], 8000),
            minQuietAfterNewMs: toNumber(form['wait.minQuietAfterNewMs'], 10000),
            leaseMs: toNumber(form['wait.leaseMs'], 0),
          },
          wake: { preSleepWaitMs: toNumber(form['wake.preSleepWaitMs'], 10000) },
        },
      }), '等待锁参数已写入');

      const applyPreset = (name) => {
        setForm((prev) => ({ ...prev, ...PRESETS[name] }));
        setNote(`已套用「${name === 'slow' ? '慢' : name === 'normal' ? '正常' : '快'}」档，记得点保存`);
      };

      const saveWhitelist = () => run(async () => {
        await api('/whitelist', {
          method: 'POST',
          body: {
            allow: { groups: parseList(groups), private: parseList(privates) },
            deny: { groups: parseList(denyGroups), private: [] },
            ownerQQ: ownerQQ.trim() === '' ? null : toNumber(ownerQQ, null),
          },
        });
        // 存完顺手把开关状态按服务端现状对齐（顺便刷新群名/昵称缓存）
        try { await loadCandOnce(); } catch { /* 桥接没起来时忽略 */ }
      }, '白名单已写入');

      const control = (action) => run(() => api('/process', { method: 'POST', body: { action } }), `已执行：${action}`);
      const setPaused = (paused) => run(() => api('/activity', { method: 'POST', body: { paused } }), paused ? '已暂停 AI 活动' : '已恢复 AI 活动');

      // 整套启停：底层是桥接目录的 stop/start-qq-stack.ps1（与双击 .cmd 同一份实现）。
      const loadStack = () => run(async () => {
        setStack(await api('/stack-status'));
      }, '已刷新整套状态');
      // 分会话语音开关：改桥接 socialV2.voice.perSession（桥接每回合按会话下发，改完桥接侧即生效）
      const loadSessions = () => run(async () => {
        setSessions(await api('/voice-sessions?refresh=1'));   // 带 refresh=1：顺带重新拉群名/昵称
      }, '已刷新会话列表（含群名/昵称）');
      const setSessionMode = (key, mode) => run(async () => {
        await api('/voice-sessions', { method: 'POST', body: { key, mode } });
        setSessions(await api('/voice-sessions'));
      }, `已设置 ${key} → ${mode === 'inherit' ? '跟随全局' : mode === 'voice' ? '语音优先' : '只用文字'}`);

      // ── ② 白名单：按钮开关（带名字） ──────────────────────────────────────
      // 开关的真实状态以**本地这三个字符串**为准（它们就是提交给桥接的那份），
      // 服务端返回的 allowed/denied 只在「刷新群/联系人」时用来重置开关 ——
      // 否则会出现"点了按钮却看不出来"，因为服务端那份还没变。
      const [cand, setCand] = React.useState(null);
      const hasId = (val, id) => parseList(val).includes(String(id));
      const addId = (val, id) => [...new Set([...parseList(val), String(id)])].join('\n');
      const delId = (val, id) => parseList(val).filter((x) => x !== String(id)).join('\n');
      const allowGroup = (id) => {
        if (hasId(groups, id)) { setGroups(delId(groups, id)); return; }
        setGroups(addId(groups, id));
        setDenyGroups(delId(denyGroups, id));   // 允许与拒绝互斥
      };
      const denyGroup = (id) => {
        if (hasId(denyGroups, id)) { setDenyGroups(delId(denyGroups, id)); return; }
        setDenyGroups(addId(denyGroups, id));
        setGroups(delId(groups, id));
      };
      const togglePrivate = (id) => setPrivates(hasId(privates, id) ? delId(privates, id) : addId(privates, id));
      const loadCandOnce = async () => {
        const c = await api('/whitelist-candidates?refresh=1');
        setCand(c);
        setGroups((c.groups ?? []).filter((g) => g.allowed).map((g) => g.id).join('\n'));
        setDenyGroups((c.groups ?? []).filter((g) => g.denied).map((g) => g.id).join('\n'));
        setPrivates((c.friends ?? []).filter((f) => f.allowed).map((f) => f.id).join('\n'));
        if (c.ownerQQ != null) setOwnerQQ(String(c.ownerQQ));
        return c;
      };
      const loadCand = () => run(loadCandOnce, '已刷新群/联系人（并按服务端现状重置开关）');
      const stackAction = (kind, extra) => run(async () => {
        if (kind === 'stop' && !window.confirm(
          '确定「整套停止」吗？\n\n会依次：断自启（4 个计划任务 + 2 个登录自启）→ 关闭 DSH 的 QQ MCP 注册 → '
          + '终止相关进程（桥接 / SnowLuma / RVC / CosyVoice）→ 复查。\n\n'
          + 'MCP 子进程要等重启一次 DSH 才会彻底消失。随时可用「整套启动」恢复。',
        )) return;
        const r = await api(`/stack-${kind}`, { method: 'POST', body: { ...(extra ?? {}) } });
        setStackOut(JSON.stringify({ kind: r.kind, ok: r.ok, status: r.status, output: r.output, error: r.error, hint: r.hint }, null, 1));
        setStack(await api('/stack-status'));
      }, kind === 'stop' ? '整套已停止（MCP 子进程需重启 DSH 才彻底消失）' : '整套已启动（QQ 工具需重启 DSH 才回来）');

      // ── ⑤ 工具白名单的增删（整份替换语义，与面板其它列表一致） ────────────
      const saveTools = (allowedExact, allowedPrefixes) => run(
        () => api('/tools', { method: 'POST', body: { allowedExact, allowedPrefixes } }),
        '工具白名单已写入（守卫按文件 mtime 立即生效，无需重启 DSH）',
      );
      const addTool = (name, asPrefix) => {
        const n = String(name ?? '').trim();
        if (!n) { setErr('先填一个工具名'); return; }
        const cur = tools?.allowlist ?? {};
        if (asPrefix) saveTools(cur.allowedExact ?? [], [...new Set([...(cur.allowedPrefixes ?? []), n])]);
        else saveTools([...new Set([...(cur.allowedExact ?? []), n])], cur.allowedPrefixes ?? []);
        setNewTool('');
      };
      const removeTool = (name, asPrefix) => {
        const cur = tools?.allowlist ?? {};
        if (asPrefix) saveTools(cur.allowedExact ?? [], (cur.allowedPrefixes ?? []).filter((x) => x !== name));
        else saveTools((cur.allowedExact ?? []).filter((x) => x !== name), cur.allowedPrefixes ?? []);
      };

      // ── ⑥ 发语音：文本→音频（TTS 插件）→ 落进桥接语音库 → 桥接操作者通道发出 ──
      const setSayField = (key, value) => setSay((prev) => ({ ...prev, [key]: value }));
      const sendVoice = (dryRun) => run(async () => {
        const res = await api('/say', {
          method: 'POST',
          body: {
            key: say.key.trim(),
            text: say.text,
            ...(say.voice.trim() ? { voice: say.voice.trim() } : {}),
            // 留空 = 用「默认声音」（面板 ⑥ 保存的那份，例如自定义 RVC 音色），别用写死的值覆盖它
            ...(say.provider.trim() ? { provider: say.provider.trim() } : {}),
            ...(dryRun ? { dryRun: true } : {}),
          },
        });
        setSayResult(res);
      }, dryRun ? '已合成语音并做了预检（没有真的发出去）' : '语音已发往 QQ');

      // ── ⑦ 语音发送限制（调试） ────────────────────────────────────────────
      const setVField = (key, value) => setVform((prev) => ({ ...prev, [key]: value }));

      const saveVoiceLimits = () => run(() => api('/voice-limits', {
        method: 'POST',
        body: {
          enabled: vform.enabled === true,
          maxSeconds: toNumber(vform.maxSeconds, 300),
          maxPerMinute: toNumber(vform.maxPerMinute, 2),
          maxPerHour: toNumber(vform.maxPerHour, 10),
          // 面板按 MB 显示，桥接要字节；1 MB = 1024*1024，取整到字节
          maxBytes: Math.round(toNumber(vform.maxBytesMB, 20) * 1024 * 1024),
          defaultVolume: toNumber(vform.defaultVolume, 1),
          loudness: vform.loudness,
          autoReadback: vform.autoReadback === true,
          allowAbsolutePath: vform.allowAbsolutePath === true,
        },
      }), '语音发送限制已写入（桥接热更新，立即生效）');

      const resetVoiceLimits = () => run(
        () => api('/voice-limits', { method: 'POST', body: { reset: true } }),
        '已恢复语音发送的默认限制',
      );

      /** 预检：把「要说的话」和「语音库里的文件」一起交给宿主半逐条判定。 */
      const checkVoice = () => run(async () => {
        const res = await api('/voice-check', {
          method: 'POST',
          body: {
            text: say.text,
            file: vfile,
            ...(say.key.trim() ? { key: say.key.trim() } : {}),
          },
        });
        setVcheck(res);
      }, '预检完成（没有发送任何东西）');

      if (state === null && err === null) {
        return h('div', { style: CSS.wrap }, h('h2', { style: CSS.h2 }, 'QQ 桥接'), h('p', { style: CSS.meta }, '加载中…'));
      }

      const b = state?.bridge ?? {};
      const st = b.status ?? {};
      const sl = st.snowluma ?? {};
      const proc = state?.process ?? {};
      const snow = state?.snowluma ?? {};

      const statusText = b.up
        ? `在线（模式 ${st.mode ?? '?'}，DSH ${st.dshReady ? '已就绪' : '未就绪'}，SnowLuma ${sl.connected ? '已连接' : '未连接'}）`
        : `离线${b.error ? `（${b.error}）` : ''}`;

      // 任务状态文案与按钮方向。
      // 兜底：宿主半若还没加载新版本（宿主改动不热加载），`proc.enabled` 会是 null ——
      // 那时用「桥接探活」来判断该显示启动还是停止，避免停止后按钮还写着「停止」。
      const taskEnabled = proc.exists === false
        ? null
        : (proc.enabled === true ? true : proc.enabled === false ? false : (b.up ? true : false));
      const taskText = proc.exists === false
        ? '未找到'
        : (proc.status ?? (taskEnabled ? '已启用' : '已禁用')) + (b.up ? '（运行中）' : '（已停止）');
      const wantStart = taskEnabled === false;

      return h('div', { style: CSS.wrap },
        h('h2', { style: CSS.h2 }, 'QQ 桥接'),
        h('p', { style: CSS.intro }, '控制本机的 qq-bridge（QQ ↔ DSH）。所有改动都会写入桥接的 config.json 并立即生效，不需要重启。'),
        err ? h('p', { style: CSS.err }, `错误：${err}`) : null,
        note ? h('p', { style: CSS.ok }, note) : null,

        // ── ① 开关 ──────────────────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '① 开关与状态'),
          h('div', { style: CSS.row },
            h('span', { style: CSS.meta }, `桥接：${statusText}`),
          ),
          h('div', { style: CSS.row },
            h('span', { style: CSS.meta }, `进程任务 ${proc.task ?? '?'}：${taskText}；SnowLuma 任务 ${snow.task ?? '?'}：${snow.exists === false ? '未找到' : (snow.status ?? (snow.enabled === false ? '已禁用' : '已启用'))}`),
          ),
          h('div', { style: CSS.row },
            h('span', { style: CSS.meta }, `白名单：群 ${(state?.whitelist?.allow?.groups ?? []).join('、') || '无'}；私聊 ${(state?.whitelist?.allow?.private ?? []).join('、') || '无'}`),
          ),
          h('div', { style: CSS.row },
            h('button', { style: CSS.btn, disabled: busy, onClick: () => setPaused(!(state?.paused === true)) }, state?.paused === true ? '恢复 AI 活动' : '暂停 AI 活动'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => control('restart') }, '重启桥接进程'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => control(wantStart ? 'start' : 'stop') }, wantStart ? '启动桥接' : '停止桥接'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => load() }, '刷新'),
          ),
          h('p', { style: CSS.meta }, '「暂停」只是让 AI 不再唤醒/不自动回复，进程仍在；「停止」会先禁用保活触发器再结束进程，否则它 ≤1 分钟又会被拉起来。桥接与 SnowLuma 网关会**一起**启停（网关是桥接连 OneBot 的前置，只起桥接会不通）。'),

          // MCP 注册是关的而桥接已在跑 ⇒ AI 没有 QQ 工具。这条必须显式提示，否则状态看着"正常"却回不了话。
          stack?.mcpRegistration?.disabled === true
            ? h('p', { style: CSS.err }, '⚠️ DSH 的 QQ MCP 注册当前是关闭的：AI 还没有 QQ 工具（mcp__snowluma__*）。点下面「整套启动」可恢复，但需重启一次 DSH 才会出现。')
            : null,

          // ── 整套启停：不只停桥接，连 SnowLuma / 语音服务 / 自启 / DSH 的 MCP 注册一起收 ──
          h('div', { style: { ...CSS.row, marginTop: 8, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 8 } },
            h('span', { style: CSS.label }, '整套启停'),
            h('button', { style: CSS.btn, disabled: busy, onClick: loadStack }, '查看状态'),
            h('button', { style: CSS.btn, disabled: busy || !stack, onClick: () => stackAction('stop') }, '整套停止'),
            h('button', { style: CSS.btn, disabled: busy || !stack, onClick: () => stackAction('start') }, '整套启动'),
            h('button', { style: CSS.btn, disabled: busy || !stack, onClick: () => stackAction('start', { withVoice: true }) }, '整套启动（含语音）'),
          ),
          stack ? h('p', { style: CSS.meta },
            `任务：${(stack.tasks ?? []).map((t) => `${t.name}=${t.exists ? t.state : '无'}`).join('，') || '读不到'}`
            + `｜登录自启：${(stack.runEntries ?? []).map((r) => `${r.name}${r.present ? '有' : '无'}`).join('，') || '读不到'}`
            + `｜MCP 注册：${stack.mcpRegistration?.disabled === true ? '已关闭' : (stack.mcpRegistration?.disabled === false ? '开启' : '读不到')}`
            + `｜相关进程 ${(stack.processes ?? []).length} 个｜端口 ${(stack.ports ?? []).join('/') || '无'}`
            + (stack.memory ? `｜内存可用 ${(stack.memory.freeMB / 1024).toFixed(1)} GB / ${(stack.memory.totalMB / 1024).toFixed(1)} GB` : ''),
          ) : null,
          stackOut ? h('pre', { style: CSS.log }, stackOut) : null,
          h('p', { style: CSS.meta }, '「整套停止」= 断自启（4 个计划任务 + 2 个登录自启）→ 关闭 DSH 的 QQ MCP 注册 → 终止相关进程（桥接 / SnowLuma / RVC / CosyVoice）→ 复查；下面两个启动按钮默认不拉语音服务。底层就是桥接目录里的 stop/start-qq-stack.ps1（与双击 .cmd 同一份实现），日志追加在 state\\stop-qq-stack.log。'),
        ),

        // ── ② 白名单（带名字的按钮开关） ──────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '② 白名单'),
          h('div', { style: CSS.row },
            h('span', { style: CSS.meta }, cand
              ? `共 ${cand.groups.length} 个群 / ${cand.friends.length} 个联系人；名字来源：${cand.names?.source ?? '?'}`
              : '（还没读到候选列表：宿主半需重启一次 DSH，或 SnowLuma 没起来；可先用下面的「手填补充」）'),
            h('button', { style: CSS.btn, disabled: busy, onClick: loadCand }, '刷新群/联系人'),
            h('button', { style: CSS.btnPrimary, disabled: busy, onClick: saveWhitelist }, '保存白名单'),
          ),
          h('p', { style: CSS.meta }, '点按钮切换：群聊在「允许 / 拒绝」之间互斥切换，联系人只有「允许」。改完**要点「保存白名单」**；「手填补充」用于列表里没有的 ID（还没加好友、已退群等）。'),

          h('h4', { style: { ...CSS.cardTitle, marginTop: 8, fontSize: 13 } }, '群聊'),
          ...(((cand?.groups ?? []).length > 0)
            ? cand.groups.map((g) => h('div', { key: g.key, style: { ...CSS.row, gap: 6, marginTop: 2 } },
              h('span', { style: { ...CSS.meta, minWidth: 230 }, title: g.key }, `${g.display}${g.orphan ? '（不在群列表里）' : ''}`),
              h('button', { style: hasId(groups, g.id) ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => allowGroup(g.id) }, hasId(groups, g.id) ? '允许中 ✓' : '允许'),
              h('button', { style: hasId(denyGroups, g.id) ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => denyGroup(g.id) }, hasId(denyGroups, g.id) ? '拒绝中 ✓' : '拒绝'),
            ))
            : [h('p', { key: 'noGroup', style: CSS.meta }, '（没有候选群）')]),

          h('h4', { style: { ...CSS.cardTitle, marginTop: 8, fontSize: 13 } }, '联系人'),
          ...(((cand?.friends ?? []).length > 0)
            ? cand.friends.map((f) => h('div', { key: f.key, style: { ...CSS.row, gap: 6, marginTop: 2 } },
              h('span', { style: { ...CSS.meta, minWidth: 230 }, title: f.key },
                `${f.display}${String(cand.ownerQQ ?? ownerQQ) === f.id ? '（管理员）' : ''}${f.orphan ? '（不在好友列表里）' : ''}`),
              h('button', { style: hasId(privates, f.id) ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => togglePrivate(f.id) }, hasId(privates, f.id) ? '允许中 ✓' : '允许'),
              h('button', {
                style: String(cand.ownerQQ ?? ownerQQ) === f.id ? CSS.btnPrimary : CSS.btn,
                disabled: busy,
                onClick: () => setOwnerQQ(String(cand.ownerQQ ?? ownerQQ) === f.id ? '' : f.id),
              }, String(cand.ownerQQ ?? ownerQQ) === f.id ? '管理员 ✓' : '设为管理员'),
            ))
            : [h('p', { key: 'noFriend', style: CSS.meta }, '（没有候选联系人）')]),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '手填补充'),
            h('input', { style: { ...CSS.input, width: 200 }, placeholder: '群号（逗号/空格分隔）', value: groups, onChange: (e) => setGroups(e.target.value) }),
            h('input', { style: { ...CSS.input, width: 180 }, placeholder: 'QQ 号', value: privates, onChange: (e) => setPrivates(e.target.value) }),
            h('input', { style: { ...CSS.input, width: 160 }, placeholder: '拒绝的群号', value: denyGroups, onChange: (e) => setDenyGroups(e.target.value) }),
          ),
          h('div', { style: CSS.row },
            h('label', { style: CSS.label }, '管理员 QQ（ownerQQ）'),
            h('input', { style: { ...CSS.input, width: 150 }, value: ownerQQ, onChange: (e) => setOwnerQQ(e.target.value) }),
            h('span', { style: CSS.meta }, '也可以用上面联系人那行的「设为管理员」直接点'),
          ),
          h('div', { style: CSS.row }, h('button', { style: CSS.btnPrimary, disabled: busy, onClick: saveWhitelist }, '保存白名单')),
        ),

        // ── ③ 响应速度 ──────────────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '③ 响应速度'),
          h('div', { style: CSS.row },
            h('button', { style: CSS.btn, disabled: busy, onClick: () => applyPreset('slow') }, '慢'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => applyPreset('normal') }, '正常'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => applyPreset('fast') }, '快'),
            h('span', { style: CSS.meta }, '调得越「快」越容易抢话、越像客服，慎用。'),
          ),
          ...SPEED_FIELDS.map(([key, title, unit]) => InputRow(key, title, unit, form[key], setField)),
          h('div', { style: CSS.row }, h('button', { style: CSS.btnPrimary, disabled: busy, onClick: saveSpeed }, '保存响应速度')),
        ),

        // ── ④ 等待锁 ────────────────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '④ 等待锁'),
          h('p', { style: CSS.meta }, '沉睡前观察窗口改了之后，人设提示词里的 timeoutMs 仍写着旧值（preset 只在 DSH 启动时装配）——改完建议重启一次 DSH 让两边一致。'),
          ...WAIT_FIELDS.map(([key, title, unit]) => InputRow(key, title, unit, form[key], setField)),
          h('div', { style: CSS.row }, h('button', { style: CSS.btnPrimary, disabled: busy, onClick: saveWait }, '保存等待锁参数')),
          h('p', { style: CSS.meta }, '最近被接管的等待（诊断「等待锁卡住」用）：'),
          h('pre', { style: CSS.log }, (state?.waitLog ?? []).join('\n') || '（没有记录）'),
        ),

        // ── ⑤ 插件工具白名单 ────────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '⑤ 插件工具白名单'),
          h('p', { style: CSS.meta }, 'QQ preset 的执行期守卫（qq-tool-restrict）默认只放行桥接自己的 MCP 工具 + ask_user_question / todo_write；其它插件注册的工具要在这里显式放行，否则调用会被拒（桥接工具日志里会出现「不在 QQ 桥接白名单内」）。改完立即生效，不用重启 DSH。'),
          h('p', { style: CSS.meta }, `文件：${tools?.allowlist?.path ?? '(未知)'}${tools?.allowlist?.ok === false ? ` —— ⚠️ 读不出来：${tools?.allowlist?.error ?? ''}` : ''}`),
          !tools
            ? h('p', { style: CSS.err }, '宿主半还没加载这组路由（/tools 404）——这个卡片要等**重启一次 DSH** 才可用；重启后刷新页面即可正常增删。')
            : null,

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '内置放行（只读）'),
            h('span', { style: CSS.meta }, [...(tools?.builtin?.prefixes ?? []).map((p) => `${p}*`), ...(tools?.builtin?.exact ?? [])].join('、') || '(未读到)'),
          ),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '扩展精确名'),
            ...((tools?.allowlist?.allowedExact ?? []).length
              ? tools.allowlist.allowedExact.map((n) => h('button', {
                key: `e-${n}`, style: CSS.btn, disabled: busy, title: '点击移除', onClick: () => removeTool(n, false),
              }, `${n} ✕`))
              : [h('span', { key: 'none-e', style: CSS.meta }, '（空）')]),
          ),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '扩展前缀'),
            ...((tools?.allowlist?.allowedPrefixes ?? []).length
              ? tools.allowlist.allowedPrefixes.map((n) => h('button', {
                key: `p-${n}`, style: CSS.btn, disabled: busy, title: '点击移除', onClick: () => removeTool(n, true),
              }, `${n}* ✕`))
              : [h('span', { key: 'none-p', style: CSS.meta }, '（空）')]),
          ),

          h('div', { style: CSS.row },
            h('input', {
              style: { ...CSS.input, width: 220 }, placeholder: '工具名，例如 vision_ocr',
              value: newTool, onChange: (e) => setNewTool(e.target.value),
            }),
            h('button', { style: CSS.btnPrimary, disabled: busy, onClick: () => addTool(newTool, false) }, '加为精确名'),
            h('button', { style: CSS.btn, disabled: busy, onClick: () => addTool(newTool, true) }, '加为前缀'),
          ),

          h('p', { style: CSS.meta }, '已知插件工具（点一下即加入扩展精确名；⚠️ 表示会碰到本机画面/文件）：'),
          ...(tools?.catalog ?? []).map((g) => h('div', { key: g.group, style: CSS.row },
            h('span', { style: CSS.label }, g.group),
            h('span', { style: CSS.meta }, g.note),
          )),
          ...(tools?.catalog ?? []).map((g) => h('div', { key: `${g.group}-tools`, style: CSS.row },
            ...g.tools.map((t) => h('button', {
              key: t.name,
              style: t.risk ? CSS.btnRisk : CSS.btn,
              disabled: busy,
              title: t.desc,
              onClick: () => addTool(t.name, false),
            }, `${t.risk ? '⚠️ ' : '+ '}${t.name}`)),
          )),
        ),

        // ── ⑥ 发语音（TTS → QQ） ────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '⑥ 发语音（TTS → QQ）'),
          h('p', { style: CSS.meta }, '文本 → TTS 合成（dsh-plugin-tts 的宿主路由，Edge 免 key）→ 自动落进桥接语音库 → 桥接「操作者通道」发成 QQ 语音条。**不需要打开「AI 能发语音」开关**——那条只管 AI 自己发。'),
          h('p', { style: CSS.meta }, tts
            ? (tts.edge?.ok
              ? `TTS 就绪：Edge TTS 可用（${tts.edge.detail ?? ''}）`
              : 'TTS 不可用：Edge TTS 没通过自检（检查网络 / 或该插件未加载）')
            : 'TTS 状态未读到（/tts-status 不可用，可能插件没装）'),
          h('p', { style: CSS.meta }, `语音库：${tts?.libraryDir ?? '(未知)'}　文本上限 ${tts?.maxChars ?? 200} 字`),
          h('p', { style: CSS.meta }, tts?.voice
            ? `默认声音：${tts.voice.provider}${tts.voice.provider === 'edge-tts'
              ? `（音色 ${tts.voice.voice || '默认'}）`
              : `（custom：${Object.entries(tts.voice.custom ?? {}).map(([k, v]) => `${k}=${String(v).split(/[\\/]/).pop()}`).join('，') || '⚠️ 缺 custom，合成会失败'}）`}`
            : '默认声音：未读到（/voice 不可用）'),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '引擎'),
            h('input', {
              style: { ...CSS.input, width: 140 }, placeholder: '留空 = 默认声音',
              value: say.provider, onChange: (e) => setSayField('provider', e.target.value),
            }),
            h('span', { style: CSS.meta }, 'edge-tts / rvc / index-tts2 / cosyvoice；留空即用上面的默认声音（例如自定义 RVC 音色）'),
          ),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '目标'),
            h('input', {
              style: { ...CSS.input, width: 200 }, placeholder: 'group:群号 或 private:QQ号',
              value: say.key, onChange: (e) => setSayField('key', e.target.value),
            }),
            h('span', { style: CSS.meta }, '必须是桥接白名单里的会话'),
          ),

          h('textarea', {
            style: { ...CSS.input, width: '100%', minHeight: 64, boxSizing: 'border-box' },
            placeholder: '要说的话（短句更像真人，建议 ≤60 字）',
            value: say.text, onChange: (e) => setSayField('text', e.target.value),
          }),
          h('p', { style: CSS.meta }, `${say.text.length} / ${tts?.maxChars ?? 200} 字`),

          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '音色'),
            h('input', {
              style: { ...CSS.input, width: 220 }, placeholder: 'zh-CN-XiaoxuanNeural',
              value: say.voice, onChange: (e) => setSayField('voice', e.target.value),
            }),
            ...(tts?.voices ?? []).map((v) => h('button', {
              key: v.id, style: CSS.btn, disabled: busy, title: v.id, onClick: () => setSayField('voice', v.id),
            }, v.label)),
          ),

          // 「以语音为主」：写桥接的 socialV2.voice.preferVoice。
          // 桥接会在**每一回合的提示词**里下发这条要求（bridge.js voicePolicyBlock，挂在 withSlangContext 上），
          // 所以改完只需桥接侧生效（几秒），不需要重启 DSH。
          // 但**写它需要宿主半的 /voice-policy 路由**（活着的 /voice-limits 只认 11 个限制键，/voice 只写默认声音）。
          // 宿主半没重启时该路由是 404 —— 那种情况下按钮要**说明原因**，而不是静默禁用。
          h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '发言方式'),
            h('button', {
              style: policy?.preferVoice === false ? CSS.btn : CSS.btnPrimary,
              disabled: busy || policy?.unavailable === true,
              onClick: async () => {
                const want = !(policy?.preferVoice ?? true);
                setBusy(true);
                setErr(null);
                try {
                  const r = await api('/voice-policy', { method: 'POST', body: { preferVoice: want } });
                  setPolicy({ ok: true, preferVoice: r.preferVoice !== false });
                  setNote(r.preferVoice !== false ? '已开启：AI 会优先用语音发消息' : '已关闭：恢复为文字为主');
                } catch (error) {
                  const msg = String(error?.message ?? error);
                  setErr(`切换失败：${msg}${/404/.test(msg) ? '（宿主半还没加载 /voice-policy，重启一次 DSH 即可）' : ''}`);
                } finally { setBusy(false); }
              },
            }, policy?.unavailable === true
              ? '以语音为主：开关尚未就绪'
              : ((policy?.preferVoice ?? true) ? '以语音为主：已开启' : '以语音为主：已关闭')),
            h('span', { style: policy?.unavailable === true ? CSS.err : CSS.meta },
              policy?.unavailable === true
                ? '宿主半新增的 /voice-policy 路由还没加载（重启一次 DSH 即可用这个开关）。'
                  + '⚠️ 注意：桥接里**当前实际是「开启」**，AI 已经在优先发语音了。'
                : '开启后桥接每回合提醒 AI「能用 qq_say_voice 说就用语音」；文字只用于长内容/需精确转达/语音失败时'),
          ),

          // ── 分会话语音开关：覆盖全局，按"群 / 私聊"分别设 ──
          h('div', { style: { ...CSS.row, marginTop: 8, borderTop: '1px solid rgba(128,128,128,.25)', paddingTop: 8 } },
            h('span', { style: CSS.label }, '分会话语音'),
            h('button', { style: CSS.btn, disabled: busy, onClick: loadSessions }, '刷新会话列表'),
            h('span', { style: CSS.meta }, `全局当前：${(policy?.preferVoice ?? true) ? '语音优先' : '只用文字'}`),
          ),
          sessions ? h('div', null,
            ...((sessions.sessions ?? []).slice(0, 30).map((s) => h('div', { key: s.key, style: { ...CSS.row, gap: 6, marginTop: 2 } },
              h('span', { style: { ...CSS.meta, minWidth: 190 }, title: s.key },
                `${s.display ?? s.key}${s.inWhitelist ? '' : '（不在白名单）'}${s.lastSeen ? ` · 最近 ${s.lastSeen}` : ''}`),
              h('button', { style: s.mode === 'inherit' ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => setSessionMode(s.key, 'inherit') }, '跟随全局'),
              h('button', { style: s.mode === 'voice' ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => setSessionMode(s.key, 'voice') }, '语音'),
              h('button', { style: s.mode === 'text' ? CSS.btnPrimary : CSS.btn, disabled: busy, onClick: () => setSessionMode(s.key, 'text') }, '只用文字'),
            ))),
          ) : h('p', { style: CSS.meta }, '（还没读到会话列表——宿主半需重启一次 DSH，或桥接没起来）'),
          h('p', { style: CSS.meta }, '这里写的是桥接 `socialV2.voice.perSession`：桥接**每回合**按会话下发要求（改完桥接侧即生效，不用重启 DSH）；AI 的 `qq_say_voice` 也会在该会话为「只用文字」时直接拒绝。候选项 = 白名单里的会话 + 最近聊天记录里出现过的会话。'),

          h('div', { style: CSS.row },
            h('button', { style: CSS.btn, disabled: busy || !say.text.trim(), onClick: () => sendVoice(true) }, '预览（不发送）'),
            h('button', { style: CSS.btnPrimary, disabled: busy || !say.text.trim(), onClick: () => sendVoice(false) }, '发送语音'),
            sayResult ? h('span', { style: sayResult.ok ? CSS.ok : CSS.err }, sayResult.ok ? '成功' : `失败：${sayResult.error ?? '见下方'}`) : null,
          ),

          sayResult ? h('pre', { style: CSS.log }, JSON.stringify({ tts: sayResult.tts, bridge: sayResult.bridge }, null, 1)) : null,
        ),

        // ── ⑦ 语音发送限制（调试） ──────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '⑦ 语音发送限制（调试）'),
          h('p', { style: CSS.meta }, '桥接的 socialV2.voice 里那套「能不能发 / 发多长 / 发多大 / 发多快」。改完桥接热更新，立即生效；不用重启。'),

          !vlim
            ? h('p', { style: CSS.err }, '宿主半还没加载这组路由（/voice-limits 404）——这张卡片要等**重启一次 DSH** 才可用；重启后刷新页面即可。')
            : null,

          vlim ? h('p', { style: CSS.meta },
            `限制来源：${vlim.source === 'bridge-api' ? '桥接 API（权威）' : `config.json 兜底${vlim.sourceError ? `（桥接没响应：${vlim.sourceError}）` : ''}`}`
            + `　语音库：${vlim.library?.dir ?? '?'}（${vlim.library?.files?.length ?? 0} 个文件）`) : null,

          // 实际用量：桥接的计数器在内存里，这里是从 bridge.log 反推的近似值
          vlim?.quota ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '最近实际用量'),
            h('span', { style: CSS.meta },
              `1 分钟 ${vlim.quota.minute} 条（AI ${vlim.quota.aiMinute} / 操作者 ${vlim.quota.operatorMinute}）`
              + `　1 小时 ${vlim.quota.hour} 条（AI ${vlim.quota.aiHour} / 操作者 ${vlim.quota.operatorHour}）`
              + `　最后一次 ${vlim.quota.lastAt ?? '无记录'}`
              + (vlim.quota.lastAgeSec != null ? `（${vlim.quota.lastAgeSec}s 前）` : '')),
          ) : null,
          vlim?.quota ? h('p', { style: CSS.meta }, `⚠️ ${vlim.quota.source}：桥接的限流计数是内存里的，重启后清零；日志行只有时分秒，跨零点靠时间戳纠正。`): null,

          // AI 总闸 + 三个布尔项
          vlim ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, 'AI 能发语音（总闸）'),
            h('button', {
              style: vform.enabled ? CSS.btnPrimary : CSS.btn, disabled: busy,
              onClick: () => setVField('enabled', !(vform.enabled === true)),
            }, vform.enabled ? '已打开（点此关闭）' : '已关闭（点此打开）'),
            h('span', { style: CSS.meta }, '关掉后 AI 的 qq_send_voice 一律拒绝；面板第 ⑥ 组走操作者通道，不受影响'),
          ) : null,

          vlim ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '发送后自动回读校验'),
            h('button', {
              style: vform.autoReadback ? CSS.btnPrimary : CSS.btn, disabled: busy,
              onClick: () => setVField('autoReadback', !(vform.autoReadback === true)),
            }, vform.autoReadback ? '开' : '关'),
            h('span', { style: CSS.label }, '允许绝对路径'),
            h('button', {
              style: vform.allowAbsolutePath ? CSS.btnRisk : CSS.btn, disabled: busy,
              onClick: () => setVField('allowAbsolutePath', !(vform.allowAbsolutePath === true)),
            }, vform.allowAbsolutePath ? '开' : '关'),
            h('span', { style: CSS.meta }, '⚠️ 这个开关对 AI 通道已不再放宽（绝对路径仍必须落在语音库内）'),
          ) : null,

          vlim ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '智能音量档位'),
            ...['quiet', 'normal', 'loud'].map((k) => h('button', {
              key: k, style: vform.loudness === k ? CSS.btnPrimary : CSS.btn, disabled: busy,
              onClick: () => setVField('loudness', k),
            }, k)),
            h('span', { style: CSS.meta }, '仅当发送时带 normalize 才生效'),
          ) : null,

          vlim ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '语音库目录（只读）'),
            h('span', { style: CSS.meta }, vlim.limits?.dir ?? 'audio'),
            h('span', { style: CSS.label }, 'ffmpeg（只读）'),
            h('span', { style: CSS.meta }, vlim.limits?.ffmpegPath || '(走 PATH / FFMPEG_PATH)'),
          ) : null,

          vlim ? h('p', { style: CSS.meta }, '数值限制（留空 = 不改；频率写 0 = 不限）：') : null,
          ...(vlim ? VOICE_LIMIT_FIELDS.map(([key, title, unit]) => InputRow(key, title, unit, vform[key], setVField)) : []),

          vlim ? h('div', { style: CSS.row },
            h('button', { style: CSS.btnPrimary, disabled: busy, onClick: saveVoiceLimits }, '保存语音限制'),
            h('button', { style: CSS.btn, disabled: busy, onClick: resetVoiceLimits }, '恢复默认限制'),
            h('span', { style: CSS.meta }, '默认：300 秒 / 20 MB / 2 每分钟 / 10 每小时 / 音量 1'),
          ) : null,

          vlim ? h('p', { style: CSS.meta }, '预检（不发任何东西）：拿上面第 ⑥ 组填的文本 + 语音库里选中的文件，逐条判「这一条现在会不会被拒」。') : null,

          vlim ? h('div', { style: CSS.row },
            h('span', { style: CSS.label }, '预检文件'),
            h('select', {
              style: { ...CSS.input, width: 260 },
              value: vfile, onChange: (e) => setVfile(e.target.value),
            },
              h('option', { value: '' }, '（不校验文件，只看文本/额度）'),
              ...(vlim.library?.files ?? []).map((f) => h('option', { key: f.name, value: f.name },
                `${f.name}（${Math.round(f.bytes / 1024)} KB）`)),
            ),
            h('button', { style: CSS.btnPrimary, disabled: busy, onClick: checkVoice }, '运行预检'),
          ) : null,

          vcheck ? h('p', { style: vcheck.verdict?.operatorCanSend ? CSS.ok : CSS.err },
            vcheck.verdict?.operatorCanSend
              ? `操作者通道：可以发${vcheck.verdict?.aiCanSend ? '；AI 通道也可以' : '；但 AI 通道被总闸关着'}`
              : `操作者通道：会被拒（${(vcheck.verdict?.blockedBy ?? []).join('、')}）`) : null,

          vcheck ? h('div', { style: CSS.row },
            ...(vcheck.checks ?? []).map((c) => h('div', { key: c.id, style: { ...CSS.meta, flex: '1 0 100%' } },
              `${c.ok ? '✅' : '❌'} ${c.label} —— ${c.detail}`)),
          ) : null,

          vcheck?.bridgePreview ? h('pre', { style: CSS.log }, JSON.stringify(vcheck.bridgePreview, null, 1)) : null,

          vlim?.log?.length ? h('p', { style: CSS.meta }, '最近的 [voice] 日志（排「语音为什么发不出去」用）：') : null,
          vlim?.log?.length ? h('pre', { style: CSS.log }, vlim.log.join('\n')) : null,
        ),
      );
    }

    /**
     * 挂载：往 settings.section 槽注册一个「QQ 桥接」分区。
     * 槽位与注册形状照抄 DSH 自带的 settings-plugins 客户端插件（它只有 9.7 KB，是官方最小例子）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qq-bridge',
        order: 21,
        label: () => 'QQ 桥接',
      }, QqBridgeSection));
    }

    const inject = ['slots'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});