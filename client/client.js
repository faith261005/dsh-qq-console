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

      const saveWhitelist = () => run(() => api('/whitelist', {
        method: 'POST',
        body: {
          allow: { groups: parseList(groups), private: parseList(privates) },
          deny: { groups: parseList(denyGroups), private: [] },
          ownerQQ: ownerQQ.trim() === '' ? null : toNumber(ownerQQ, null),
        },
      }), '白名单已写入');

      const control = (action) => run(() => api('/process', { method: 'POST', body: { action } }), `已执行：${action}`);
      const setPaused = (paused) => run(() => api('/activity', { method: 'POST', body: { paused } }), paused ? '已暂停 AI 活动' : '已恢复 AI 活动');

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
          h('p', { style: CSS.meta }, '「暂停」只是让 AI 不再唤醒/不自动回复，进程仍在；「停止」会先禁用保活触发器再结束进程，否则它 ≤1 分钟又会被拉起来。'),
        ),

        // ── ② 白名单 ────────────────────────────────────────────────────────
        h('div', { style: CSS.card },
          h('h3', { style: CSS.cardTitle }, '② 白名单'),
          h('div', { style: CSS.row },
            h('label', { style: CSS.label }, '允许的群号（每行一个，或用逗号/空格分隔）'),
            h('textarea', { style: CSS.area, value: groups, onChange: (e) => setGroups(e.target.value) }),
          ),
          h('div', { style: CSS.row },
            h('label', { style: CSS.label }, '允许的私聊 QQ'),
            h('textarea', { style: CSS.area, value: privates, onChange: (e) => setPrivates(e.target.value) }),
          ),
          h('div', { style: CSS.row },
            h('label', { style: CSS.label }, '拒绝的群号（黑名单，优先于白名单）'),
            h('textarea', { style: CSS.area, value: denyGroups, onChange: (e) => setDenyGroups(e.target.value) }),
          ),
          h('div', { style: CSS.row },
            h('label', { style: CSS.label }, '管理员 QQ（ownerQQ）'),
            h('input', { style: CSS.input, value: ownerQQ, onChange: (e) => setOwnerQQ(e.target.value) }),
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