﻿// ==UserScript==
// @name         Control UI 任务看板 v6.2（三台拆分 + 任务流 + 数据面板）
// @namespace    openclaw.gu-ce
// @version      0.8.0
// @description  Control UI 任务看板 v6.2（2026-08-23 顾码 6点P2/P3）：①成果展示区（顶部今日/本周产出，/api/outputs 纯静态，运营视角清单：文件类型 emoji 前缀 + 时间今天/昨天 + path 悬停）；②任务流 tab（/api/taskflow/chain，纯 CSS grid+左侧竖线层级，失败节点高亮，零图表库）；③看板三台拆分（🟢任务运营台=队列+梯队+成果展示区 主屏 / 💰成本健康台=成本趋势+运营总览+渠道凭证健康 副屏 / 📚知识资产台=知识库+注册表+选题池+素材供需 按需 tab）；④registry/kb_stats 降级（仅知识资产台按需打开）；⑤6点P2/P3：三数据面板占位文案去内部编号（数据源已就绪·按需加载，timeout 3s→6s）；选题池英文→中文映射（topics→选题总数、material_to_topic→素材→选题转化率、topic_to_script→选题→脚本转化率、pending/selected/draft→中文）；角色面板平铺网格改头部行+点击下拉（计划≤5+技能≤12，默认收起一屏全览）。保留三队列/梯队/手动刷新/数据指纹/mock 降级/挂载点（agent-chat / chat-workspace-rail / app-shell）。全只读：无任何写操作入口/按钮/输入框。
// @match        http://127.0.0.1:18789/*
// @match        http://localhost:18789/*
// @match        http://127.0.0.1:18789
// @match        http://localhost:18789
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @updateURL    https://anzi9527.github.io/cross-validate/taskboard.user.js
// @downloadURL  https://anzi9527.github.io/cross-validate/taskboard.user.js
// ==/UserScript==

(function () {
  'use strict';

  var VERSION = 'v6.2';
  var API_URL = 'http://127.0.0.1:9903/api/board';
  var API_BASE = 'http://127.0.0.1:9903';
  var MOUNT_TICK_MS = 5000; // 挂载点周期重评（保留）
  // v5.4：取消自动刷新机制（无 POLL_MS / 无 live tick），全部数据靠手动刷新按钮 + 首次加载
  var MAX_ROWS = 0;      // v5.5: 0 = 全部显示（sidecar 已全量返回，前端不再截断）
  var QUEUE_MAXH = '220px'; // 每队列滚动区最大高度
  var TIER_MAXH = '140px';  // 实时每梯队滚动区最大高度
  var LS_KEY = 'gce-tb5-prefs-v1';
  var MODE_KEY = 'gce-mount-mode'; // auto|rail|input|float
  var TIER_ORDER = ['critical', 'high', 'medium', 'low', 'unmapped'];

  // v6.0 端点面板：view 标记归属（ops=任务运营台 / flow=任务流 / health=成本健康台 / knowledge=知识资产台）
  // 按需拉取：仅拉当前视图面板 + always + 已拉取过的；kb/registry 仅打开知识资产台时拉取（降级）
  var VIEWS = [
    { key: 'ops',       title: '🟢 任务运营台' },
    { key: 'flow',      title: '🔗 任务流' },
    { key: 'health',    title: '💰 成本健康台' },
    { key: 'knowledge', title: '📚 知识资产台' }
  ];
  var PANELS = [
    { key: 'outputs',  path: '/api/outputs',         view: 'ops',  always: true, title: '🏆 成果展示区', badge: outputsBadge },
    { key: 'flow',     path: '/api/taskflow/chain',  view: 'flow', title: '🔗 任务流',     badge: flowBadge },
    { key: 'cost',     path: '/api/cost_trend',      view: 'health', title: '💰 成本趋势',   badge: function (d) { return d ? (d.week_over_week ? (d.week_over_week.pct != null ? (d.week_over_week.pct >= 0 ? '+' : '') + d.week_over_week.pct + '%' : '-') : '-') : '-'; } },
    { key: 'flywheel', path: '/api/flywheel',        view: 'health', title: '🔄 运营总览',   badge: function (d) { return d ? (d.asset_reuse_rate != null ? Math.round(d.asset_reuse_rate * 100) + '%' : '-') : '-'; } },
    { key: 'kb',       path: '/api/kb_stats',        view: 'knowledge', title: '📚 知识库',     badge: function (d) { return d ? (d.total_cards != null ? d.total_cards : '-') : '-'; } },
    { key: 'registry', path: '/api/registry',        view: 'knowledge', title: '🗂 资产注册表', badge: function (d) { return d ? (d.asset_count != null ? d.asset_count : (d.groups ? d.groups.length : '-')) : '-'; } },
    { key: 'roles',    path: '/api/roles',           view: 'ops', title: '🎭 角色面板',   badge: function (d) { return d ? (d.total != null ? d.total : (d.roles ? d.roles.length : '-')) : '-'; } },
    // v6.2 6点P2/P3：三数据面板（placeholder=true → 未就绪降级占位，统一超时 6s）
    { key: 'topic_pool',     path: '/api/topic_pool',      view: 'knowledge', timeout: 6000, placeholder: true, title: '🎯 选题池',     badge: topicPoolBadge },
    { key: 'material',       path: '/api/material_supply', view: 'knowledge', timeout: 6000, placeholder: true, title: '🧩 素材供需',   badge: materialBadge },
    { key: 'channel_health', path: '/api/channel_health',  view: 'health',    timeout: 6000, placeholder: true, title: '📡 渠道/凭证/采集健康', badge: channelBadge }
  ];

  var STATE = {
    data: null,
    panels: {},          // v5.6: { key: {data, ok, mock, error} }
    lastOk: 0,
    error: null,
    timer: null,
    mountTimer: null,
    fetched: false,
    injecting: false,
    injected: false,
    mount: null,          // 'rail' | 'input' | 'float' | null
    mountDetail: '',      // 挂载位置附加说明
    collapsed: false,     // 总折叠（localStorage）
    collapsedSections: {},// 每队列独立折叠
    refreshing: false,    // 手动刷新中
    lastRefresh: 0,
    desiredStreak: 0,     // 期望挂载点连续命中计数（防抖）
    lastDesired: null,
    lastRailMigrateAt: 0, // 时间戳：上次迁移到 rail（升级冷却用）
    view: 'ops'           // v6.0 三台拆分：ops=任务运营台 flow=任务流 health=成本健康台 knowledge=知识资产台
  };

  // ---------- localStorage（GM_getValue 持久化） ----------
  function loadPrefs() {
    try {
      var raw = GM_getValue(LS_KEY, null);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.collapsed === 'boolean') STATE.collapsed = p.collapsed;
        if (p.sections && typeof p.sections === 'object') STATE.collapsedSections = p.sections;
        if (p.view) {
          var vk = VIEWS.some(function (v) { return v.key === p.view; });
          if (vk) STATE.view = p.view;
        }
      }
    } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try {
      GM_setValue(LS_KEY, JSON.stringify({ collapsed: STATE.collapsed, sections: STATE.collapsedSections, view: STATE.view }));
    } catch (e) { /* ignore */ }
  }
  function getModeOverride() {
    try { return GM_getValue(MODE_KEY, 'auto'); } catch (e) { return 'auto'; }
  }
  function toggleCollapsed() {
    STATE.collapsed = !STATE.collapsed;
    savePrefs();
    render();
  }
  function toggleSection(key) {
    // rail 模式：collapsedSections[key]===true 表示展开；input/float：false 表示展开
    if (STATE.mount === 'rail') {
      STATE.collapsedSections[key] = !(STATE.collapsedSections[key] === true);
    } else {
      STATE.collapsedSections[key] = !STATE.collapsedSections[key];
    }
    savePrefs();
    render();
  }

  // ---------- 样式 ----------
  GM_addStyle(`
    .gce-tb5 { display:block; width:100%; box-sizing:border-box;
      margin:2px 0 6px; padding:0; border:1px solid rgba(127,127,127,.35);
      border-radius:8px; background:rgba(127,127,127,.08);
      font:12px/1.45 ui-monospace, Consolas, monospace; color:inherit; overflow:hidden; }
    .gce-tb5__head { display:flex; align-items:center; gap:8px;
      padding:8px 10px 6px; cursor:pointer; user-select:none; }
    .gce-tb5__head:hover { background:rgba(127,127,127,.06); }
    .gce-tb5__dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; }
    .gce-tb5__dot--ok { background:#4caf50; box-shadow:0 0 4px #4caf50; }
    .gce-tb5__dot--err { background:#f44336; box-shadow:0 0 4px #f44336; }
    .gce-tb5__dot--off { background:#9e9e9e; }
    .gce-tb5__title { font-weight:600; white-space:nowrap; }
    .gce-tb5__ver { font-size:10px; opacity:.6; font-weight:400; margin-left:2px; }
    .gce-tb5__counts { margin-left:8px; font-size:11px; opacity:.8; white-space:nowrap; }
    .gce-tb5__counts b { font-weight:600; }
    .gce-tb5__meta { font-size:11px; opacity:.55; margin-left:auto; white-space:nowrap; }
    .gce-tb5__caret { font-size:10px; opacity:.7; margin-left:4px; }
    .gce-tb5__err { color:#f44336; padding:0 10px 6px; font-size:11px; }

    /* 手动刷新按钮 */
    .gce-tb5__refresh { display:inline-flex; align-items:center; gap:4px;
      padding:2px 8px; margin-left:6px; border:1px solid rgba(127,127,127,.4);
      border-radius:10px; font-size:11px; cursor:pointer; user-select:none;
      background:rgba(127,127,127,.12); color:inherit; white-space:nowrap; }
    .gce-tb5__refresh:hover { background:rgba(127,127,127,.25); }
    .gce-tb5__refresh:active { transform:scale(.96); }
    .gce-tb5__refresh--spin svg { animation:gce-tb5-spin .8s linear infinite; }
    @keyframes gce-tb5-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
    .gce-tb5__refresh--ok { border-color:rgba(76,175,80,.5); color:#4caf50; }
    .gce-tb5__refresh--err { border-color:rgba(244,67,54,.5); color:#f44336; }
    .gce-tb5__reflabel { font-size:10px; opacity:.7; }

    .gce-tb5__body { padding:0 10px 8px; }
    .gce-tb5__summarygrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
      gap:6px 10px; margin-bottom:6px; }
    .gce-tb5__cell { display:flex; justify-content:space-between; gap:6px;
      padding:3px 6px; border-radius:6px; background:rgba(127,127,127,.1); }

    .gce-tb5__section { border-top:1px dashed rgba(127,127,127,.28); padding:4px 0 2px; }
    .gce-tb5__sechead { display:flex; align-items:center; gap:6px; cursor:pointer;
      padding:3px 2px; font-weight:600; user-select:none; }
    .gce-tb5__sechead:hover { background:rgba(127,127,127,.05); }
    .gce-tb5__secbadge { font-size:10px; font-weight:400; padding:0 6px; border-radius:8px;
      background:rgba(127,127,127,.2); }
    .gce-tb5__seclabel { font-size:10px; opacity:.55; margin-left:auto; }

    /* 每队列垂直滚动条（v5.5：全部显示 + 每队列独立滚动） */
    .gce-tb5__qbody { overflow-y:auto; }   /* 垂直滚动条 */
    .gce-tb5__qbody::-webkit-scrollbar { width:8px; }
    .gce-tb5__qbody::-webkit-scrollbar-thumb { background:rgba(127,127,127,.35); border-radius:4px; }
    .gce-tb5__qbody::-webkit-scrollbar-track { background:rgba(127,127,127,.08); }
    .gce-tb5__qbody--auto { max-height:220px; }
    .gce-tb5__qbody--live { max-height:320px; }
    .gce-tb5__qbody--pending { max-height:220px; }

    /* 梯队分组 */
    .gce-tb5__tier { margin-top:4px; border:1px solid rgba(127,127,127,.15);
      border-radius:6px; overflow:hidden; }
    .gce-tb5__tierhead { display:flex; align-items:center; gap:6px;
      padding:3px 6px; font-weight:600; font-size:11px; cursor:pointer; user-select:none;
      background:rgba(127,127,127,.08); }
    .gce-tb5__tierhead:hover { background:rgba(127,127,127,.14); }
    .gce-tb5__tierhead .gce-tb5__tiercount { font-size:10px; font-weight:400;
      padding:0 6px; border-radius:8px; background:rgba(127,127,127,.2); }
    .gce-tb5__tierhead .gce-tb5__tierdesc { font-size:10px; opacity:.5; margin-left:auto; font-weight:400; }
    .gce-tb5__tier--critical .gce-tb5__tierhead { border-left:3px solid #f44336; }
    .gce-tb5__tier--high .gce-tb5__tierhead { border-left:3px solid #ff9800; }
    .gce-tb5__tier--medium .gce-tb5__tierhead { border-left:3px solid #ffc107; }
    .gce-tb5__tier--low .gce-tb5__tierhead { border-left:3px solid #4caf50; }
    .gce-tb5__tier--unmapped .gce-tb5__tierhead { border-left:3px solid #9e9e9e; }
    .gce-tb5__tierbody { overflow-y:auto; max-height:140px; }   /* 垂直滚动条 */
    .gce-tb5__tierbody::-webkit-scrollbar { width:8px; }
    .gce-tb5__tierbody::-webkit-scrollbar-thumb { background:rgba(127,127,127,.35); border-radius:4px; }
    .gce-tb5__tierbody::-webkit-scrollbar-track { background:rgba(127,127,127,.08); }

    .gce-tb5__table { width:100%; border-collapse:collapse; margin-top:3px; }
    .gce-tb5__table th { text-align:left; font-size:10px; opacity:.55; font-weight:400;
      padding:1px 4px; border-bottom:1px solid rgba(127,127,127,.2); }
    .gce-tb5__table td { padding:2px 4px; font-size:11px; vertical-align:middle;
      border-bottom:1px solid rgba(127,127,127,.08); white-space:nowrap; }
    .gce-tb5__table td.gce-tb5__tname { max-width:180px; overflow:hidden; text-overflow:ellipsis; }
    .gce-tb5__table tr:last-child td { border-bottom:none; }
    .gce-tb5__st-ok { color:#4caf50; }
    .gce-tb5__st-err { color:#f44336; }
    .gce-tb5__st-run { color:#2196f3; }
    .gce-tb5__st-wait { color:#ff9800; }
    .gce-tb5__st-dim { color:#9e9e9e; }
    .gce-tb5__bar { position:relative; width:100%; min-width:90px; height:12px;
      background:rgba(127,127,127,.18); border-radius:6px; overflow:hidden; }
    .gce-tb5__barfill { position:absolute; left:0; top:0; bottom:0;
      background:linear-gradient(90deg,#2196f3,#4caf50); transition:width .4s ease; }
    .gce-tb5__barlabel { position:absolute; inset:0; display:flex; align-items:center;
      justify-content:center; font-size:9px; color:inherit; text-shadow:0 0 2px rgba(0,0,0,.6); }
    .gce-tb5__trunc { font-size:10px; opacity:.6; padding:2px 2px 0; }
    .gce-tb5__empty { font-size:11px; opacity:.6; padding:4px 2px; }
    .gce-tb5__livepulse { display:inline-block; width:7px; height:7px; border-radius:50%;
      background:#2196f3; margin-right:4px; animation:gce-tb5-pulse 1.2s infinite; }
    @keyframes gce-tb5-pulse { 0%,100%{opacity:1} 50%{opacity:.25} }

    /* rail 紧凑模式 */
    .gce-tb5--rail { font-size:11px; margin:0 0 8px; }
    .gce-tb5--rail .gce-tb5__head { padding:6px 8px 4px; gap:6px; }
    .gce-tb5--rail .gce-tb5__body { padding:0 8px 6px; }
    .gce-tb5--rail .gce-tb5__summarygrid { grid-template-columns:repeat(3,1fr); gap:4px 6px; }
    .gce-tb5--rail .gce-tb5__cell { padding:2px 4px; font-size:10px; }
    .gce-tb5--rail .gce-tb5__table td { font-size:10px; padding:1px 3px; }
    .gce-tb5--rail .gce-tb5__table td.gce-tb5__tname { max-width:110px; }
    .gce-tb5--rail .gce-tb5__bar { min-width:60px; height:10px; }
    .gce-tb5--rail .gce-tb5__counts { font-size:10px; margin-left:4px; }
    .gce-tb5--rail .gce-tb5__meta { font-size:9px; }
    .gce-tb5--rail .gce-tb5__qgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin-bottom:6px; }
    .gce-tb5--rail .gce-tb5__qcell { display:flex; flex-direction:column; align-items:center; gap:2px;
      padding:5px 2px; border-radius:6px; background:rgba(127,127,127,.1); cursor:pointer; user-select:none; }
    .gce-tb5--rail .gce-tb5__qcell:hover { background:rgba(127,127,127,.2); }
    .gce-tb5--rail .gce-tb5__qcell b { font-size:16px; line-height:1; }
    .gce-tb5--rail .gce-tb5__qlabel { font-size:9px; opacity:.6; }
    .gce-tb5--rail .gce-tb5__table { display:block; overflow-x:auto; }
    .gce-tb5--rail .gce-tb5__table tbody { display:table; width:100%; }
    .gce-tb5--rail .gce-tb5__table td.gce-tb5__tname { max-width:90px; }

    /* 浮动面板兜底 */
    .gce-tb5--float { position:fixed; right:12px; top:70px; width:340px;
      max-height:70vh; overflow-y:auto; z-index:9999;
      background:rgba(22,22,28,.94); color:#e8e8e8;
      box-shadow:0 4px 24px rgba(0,0,0,.45); border:1px solid rgba(127,127,127,.4); }
    .gce-tb5--float .gce-tb5__head { padding:8px 10px; }
    .gce-tb5--float .gce-tb5__body { padding:0 10px 8px; }

    /* ===== v5.6 端点面板 #4 ===== */
    /* 📊 数据指纹（头部） */
    .gce-tb5__fingerprint { display:inline-flex; align-items:center; gap:5px;
      margin-left:8px; font-size:10px; opacity:.8; white-space:nowrap; }
    .gce-tb5__fp-dot { width:6px; height:6px; border-radius:50%; display:inline-block; }
    .gce-tb5__fp-dot--ok { background:#4caf50; }
    .gce-tb5__fp-dot--mock { background:#ff9800; }
    .gce-tb5__fp-dot--err { background:#f44336; }

    /* 面板主体滚动容器 */
    .gce-tb5__pbody { overflow-y:auto; }
    .gce-tb5__pbody::-webkit-scrollbar { width:8px; }
    .gce-tb5__pbody::-webkit-scrollbar-thumb { background:rgba(127,127,127,.35); border-radius:4px; }
    .gce-tb5__pbody--kb, .gce-tb5__pbody--registry { max-height:260px; }
    .gce-tb5__pbody--cost, .gce-tb5__pbody--flywheel { max-height:240px; }

    /* 面板内小表/统计 */
    .gce-tb5__stat { display:flex; justify-content:space-between; gap:8px;
      padding:2px 6px; border-radius:4px; background:rgba(127,127,127,.08); margin:2px 0; }
    .gce-tb5__stat b { font-weight:600; }
    .gce-tb5__statgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
      gap:4px 8px; margin:2px 0 4px; }
    .gce-tb5__tag { display:inline-block; padding:0 6px; border-radius:8px; font-size:10px;
      background:rgba(127,127,127,.2); margin:1px 2px 1px 0; white-space:nowrap; }
    .gce-tb5__tag--hot { background:rgba(255,152,0,.3); }

    /* 趋势行（纯 CSS 条形，无图表库） */
    .gce-tb5__trend { display:flex; align-items:center; gap:6px; padding:1px 0; }
    .gce-tb5__trend-label { flex:none; width:86px; font-size:10px; opacity:.7;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gce-tb5__trend-track { flex:1; height:10px; background:rgba(127,127,127,.15);
      border-radius:5px; overflow:hidden; position:relative; min-width:40px; }
    .gce-tb5__trend-fill { position:absolute; left:0; top:0; bottom:0;
      background:linear-gradient(90deg,#2196f3,#4caf50); border-radius:5px; }
    .gce-tb5__trend-fill--warn { background:linear-gradient(90deg,#ff9800,#f44336); }
    .gce-tb5__trend-val { flex:none; width:52px; text-align:right; font-size:10px; opacity:.85; }

    /* ===== 2026-08-23 优化节点周报（内容质量 v2.2 方案A）===== */
    .gce-tb5__optnodes { margin-top:4px; }
    .gce-tb5__optsec { display:flex; align-items:center; gap:6px; margin-top:4px;
      font-weight:600; font-size:11px; }
    .gce-tb5__optwarn { font-size:11px; padding:1px 6px; border-radius:4px;
      background:rgba(127,127,127,.06); margin:1px 0; }
    .gce-tb5__optchips { margin-top:2px; }
    .gce-tb5__optchips .gce-tb5__tag { margin:1px 3px 1px 0; }

    /* 资产注册表：按 node/domain 分组 */
    .gce-tb5__regnode { margin-top:3px; }
    .gce-tb5__regnodehead { display:flex; align-items:center; gap:6px;
      padding:2px 6px; font-weight:600; font-size:10px; cursor:pointer; user-select:none;
      background:rgba(127,127,127,.1); border-radius:4px; }
    .gce-tb5__regnodehead:hover { background:rgba(127,127,127,.18); }
    .gce-tb5__regnodecount { font-size:10px; font-weight:400; padding:0 6px; border-radius:8px;
      background:rgba(127,127,127,.2); margin-left:auto; }

    /* 状态着色（面板用，对齐队列配色） */
    .gce-tb5__st-ok { color:#4caf50; }
    .gce-tb5__st-err { color:#f44336; }
    .gce-tb5__st-run { color:#2196f3; }
    .gce-tb5__st-wait { color:#ff9800; }
    .gce-tb5__st-dim { color:#9e9e9e; }

    /* v5.7 方案A：计划/作用徽标 */
    .gce-tb5__plan { display:inline-block; max-width:150px; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; vertical-align:middle;
      font-size:10px; color:#82b1ff; background:rgba(33,150,243,.12);
      border-radius:4px; padding:0 5px; line-height:16px; cursor:default; }
    .gce-tb5__plan-cell { max-width:160px; }

    /* mock 提示 */
    .gce-tb5__mock { font-size:10px; color:#ff9800; opacity:.85; padding:2px 0 0; }
    .gce-tb5__mock::before { content:'⚡ '; }

    /* v6.0 角色面板 */
    .gce-tb5__roles { display:flex; flex-direction:column; gap:4px; margin:2px 0 4px; }
    .gce-tb5__rolecard { background:rgba(127,127,127,.08); border-radius:6px; padding:5px 7px; }
    .gce-tb5__rolehead { display:flex; align-items:center; gap:7px; }
    .gce-tb5__roleavatar { font-size:16px; line-height:1; flex:none; }
    .gce-tb5__rolename { display:flex; align-items:center; gap:6px; flex:1; min-width:0; overflow:hidden; }
    .gce-tb5__rolename b { font-weight:600; white-space:nowrap; }
    .gce-tb5__roledim { font-size:10px; opacity:.55; white-space:nowrap; }
    .gce-tb5__roleskills { display:flex; flex-wrap:wrap; gap:2px 4px; margin-top:4px; }
    /* v6.2 6点P2/P3：角色头部行 + 点击展开/收起下拉 */
    .gce-tb5__rolehead--fold { cursor:pointer; user-select:none; flex-wrap:wrap; }
    .gce-tb5__rolesummary { flex:none; font-size:10px; opacity:.7; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; max-width:46%; }
    .gce-tb5__rolecaret { flex:none; font-size:10px; opacity:.6; width:12px; text-align:center; }
    .gce-tb5__rolefold { margin:4px 0 0 2px; padding-left:8px; border-left:1px solid rgba(127,127,127,.25); }
    .gce-tb5__rolefold .gce-tb5__roleskills { margin-top:2px; }
    .gce-tb5__rolefold .gce-tb5__roledim { white-space:normal; line-height:1.5; }
    .gce-tb5__pbody--roles { max-height:320px; }

    /* ===== v6.0 三台拆分：视图切换 + 成果展示区 + 任务流（P0-2 顾码） ===== */
    .gce-tb5__desks { display:flex; gap:4px; margin:0 0 6px; }
    .gce-tb5__deskbtn { flex:1; text-align:center; padding:4px 2px; border-radius:6px; font-size:11px;
      cursor:pointer; user-select:none; background:rgba(127,127,127,.1); white-space:nowrap; overflow:hidden; }
    .gce-tb5__deskbtn:hover { background:rgba(127,127,127,.2); }
    .gce-tb5__deskbtn--on { background:rgba(33,150,243,.28); font-weight:600;
      box-shadow:inset 0 0 0 1px rgba(33,150,243,.55); }
    .gce-tb5__fp-dot--off { background:#9e9e9e; opacity:.5; }
    .gce-tb5__pbody--outputs { max-height:200px; }
    .gce-tb5__achhead { font-size:11px; font-weight:600; opacity:.85; margin:3px 0 2px; }
    /* v6.2 6点P2/P3：成果区运营清单（小结行 + emoji 前缀） */
    .gce-tb5__achsum { font-size:11px; font-weight:600; padding:2px 6px; border-radius:4px;
      background:rgba(127,127,127,.12); margin:1px 0 3px; }
    .gce-tb5__achemoji { flex:none; width:16px; text-align:center; font-size:11px; }
    .gce-tb5__achitem { padding:1px 4px; border-radius:4px; cursor:default; }
    .gce-tb5__achitem:nth-child(odd) { background:rgba(127,127,127,.06); }
    .gce-tb5__achline { display:flex; gap:6px; align-items:baseline; font-size:11px; }
    .gce-tb5__achname { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gce-tb5__achmeta { font-size:10px; opacity:.6; padding-left:22px; line-height:1.5; }
    .gce-tb5__flow { margin:2px 0 4px; }
    .gce-tb5__flowchain { display:grid; grid-template-columns:14px 1fr; gap:0; margin:2px 0 8px; }
    .gce-tb5__flowrail { display:flex; flex-direction:column; align-items:center; }
    .gce-tb5__flowdot { width:9px; height:9px; border-radius:50%; background:#2196f3; margin-top:4px; flex:none; }
    .gce-tb5__flowdot--fail { background:#f44336; box-shadow:0 0 4px #f44336; }
    .gce-tb5__flowline { width:2px; flex:1; background:rgba(127,127,127,.35); min-height:8px; }
    .gce-tb5__flowcol { min-width:0; }
    .gce-tb5__flownode { border:1px solid rgba(127,127,127,.18); border-left:3px solid #4caf50;
      border-radius:5px; padding:3px 6px; margin:2px 0 2px 2px; font-size:11px; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap; }
    .gce-tb5__flownode--ok { border-left-color:#4caf50; }
    .gce-tb5__flownode--run { border-left-color:#2196f3; }
    .gce-tb5__flownode--wait { border-left-color:#ff9800; }
    .gce-tb5__flownode--fail { border-left-color:#f44336; background:rgba(244,67,54,.14); }
    .gce-tb5__flowmeta { font-size:10px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .gce-tb5--rail .gce-tb5__deskbtn { font-size:10px; padding:3px 1px; }
  `);

  // ---------- 工具 ----------
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function relTime(ts) {
    if (!ts) return '-';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h';
  }
  function boolBadge(v) {
    if (v === true) return '<span class="gce-tb5__st-ok">● 激活</span>';
    if (v === false) return '<span class="gce-tb5__st-dim">○ 空闲</span>';
    return '<span class="gce-tb5__st-wait">? 未知</span>';
  }
  // v5.8：主控状态徽标（sidecar summary.master_control = {status, note}）
  // active → 绿「主控运行中」；inactive → 黄「主控未激活」；no_file → 灰「无主控文件」；error → 红
  // 兼容旧字段：s.master_active 存在时优先用旧逻辑
  function masterBadge(s) {
    if (s == null) return boolBadge(null);
    if (s.master_active === true || s.master_active === false) return boolBadge(s.master_active); // 旧字段优先
    var mc = s.master_control || {};
    var note = mc.note ? '\n' + mc.note : '';
    if (mc.status === 'active') return '<span class="gce-tb5__st-ok" title="主控运行中' + esc(note) + '">● 主控运行中</span>';
    if (mc.status === 'inactive') return '<span class="gce-tb5__st-wait" title="主控未激活' + esc(note) + '">○ 主控未激活</span>';
    if (mc.status === 'error') return '<span class="gce-tb5__st-err" title="' + esc(mc.note || '主控错误') + '">✕ 主控错误</span>';
    return '<span class="gce-tb5__st-dim" title="无主控文件' + esc(note) + '">— 无主控文件</span>';
  }
  function statusClass(st) {
    if (st === 'ok' || st === 'success' || st === 'completed') return 'gce-tb5__st-ok';
    if (st === 'error' || st === 'failed') return 'gce-tb5__st-err';
    if (st === 'running' || st === 'executing') return 'gce-tb5__st-run';
    if (st === 'pending' || st === 'queued' || st === 'blocked') return 'gce-tb5__st-wait';
    return 'gce-tb5__st-dim';
  }
  function statusText(st) {
    var map = { ok: '✅ ok', success: '✅ ok', completed: '✅ ok', error: '❌ error',
      failed: '❌ failed', running: '▶ 执行中', executing: '▶ 执行中',
      pending: '⏳ 排队', queued: '⏳ 排队', blocked: '⛔ blocked', never: '— 从未' };
    return map[st] || esc(st || '-');
  }
  function tierClass(t) {
    return 'gce-tb5__tier--' + (t || 'unmapped');
  }
  function tierLabel(t) {
    var map = { critical: '🔴 关键', high: '🟠 高', medium: '🟡 中', low: '🟢 低', unmapped: '⚪ 未映射' };
    return map[t] || esc(t || '?');
  }

  // v5.7（方案A）：任务计划/作用展示
  function planBadge(t) {
    if (!t || !t.registered) return '<span class="gce-tb5__st-dim" title="未登记 task_meta">⚠ 未登记</span>';
    var tip = '作用: ' + (t.purpose || '') + (t.source ? '\n来源: ' + t.source : '');
    return '<span class="gce-tb5__plan" title="' + esc(tip) + '">' + esc(t.plan || '?') + '</span>';
  }

  // ---------- 数据拉取（手动刷新语义：客户端主动请求，无自动轮询实时） ----------
  // v5.6：主看板 + 4 端点面板并行拉取；端点 404/不可达 → 降级 mock（标注 [MOCK]）
  function fetchData(cb) {
    // v6.0 按需拉取：always（成果区）+ 当前视图面板 + 已拉取过的；kb/registry 仅知识资产台打开时拉取
    var want = PANELS.filter(function (p) { return p.always || p.view === STATE.view || STATE.panels[p.key]; });
    var done = 0, total = 1 + want.length;
    function fin() {
      done++;
      if (done >= total && cb) cb();
    }
    // v5.8: onerror/ontimeout 自动重试一次（2s 后），消化 sidecar 重启窗口；重试仍失败才报错
    function attemptBoard(retried) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API_URL,
        timeout: 8000,
        onload: function (res) {
          try {
            var j = JSON.parse(res.responseText);
            STATE.data = j;
            STATE.lastOk = Date.now();
            STATE.error = null;
          } catch (e) {
            STATE.error = '解析失败: ' + e.message;
          }
          fin();
        },
        onerror: function () {
          if (!retried) {
            setTimeout(function () { attemptBoard(true); }, 2000);
          } else {
            STATE.error = 'sidecar 不可达 (' + API_URL + ')';
            fin();
          }
        },
        ontimeout: function () {
          if (!retried) {
            setTimeout(function () { attemptBoard(true); }, 2000);
          } else {
            STATE.error = 'sidecar 超时 (8s)';
            fin();
          }
        }
      });
    }
    attemptBoard(false);
    // 端点面板并行拉取（按需）
    want.forEach(function (p) {
      fetchPanel(p, fin);
    });
  }

  // v6.0：切换台/tab——补拉该视图未拉取的面板后重渲染（registry/kb_stats 由此实现按需打开）
  function switchView(key) {
    if (STATE.view === key) return;
    STATE.view = key;
    savePrefs();
    var missing = PANELS.some(function (p) { return (p.always || p.view === key) && !STATE.panels[p.key]; });
    if (missing) fetchData(render); else render();
  }

  // 拉取单个面板端点；404/失败 → mock 降级；placeholder 面板（数据源在途）→ 降级占位
  // v5.8: onerror/ontimeout 自动重试一次（2s 后），消化 sidecar 重启窗口；重试仍失败才降级
  // v6.2: placeholder 面板统一超时 6s；404/超时/pending → 降级占位（不 mock、不刷错）
  function setPanel(panel, err) {
    if (panel.placeholder) {
      STATE.panels[panel.key] = { data: null, ok: false, mock: false, placeholder: true, error: err, at: Date.now() };
    } else {
      STATE.panels[panel.key] = { data: mockPanel(panel.key), ok: false, mock: true, error: err, at: Date.now() };
    }
  }
  function fetchPanel(panel, cb) {
    var url = API_BASE + panel.path;
    function attemptPanel(retried) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: panel.timeout || 6000,
        onload: function (res) {
          try {
            var j = JSON.parse(res.responseText);
            var pending = panel.placeholder && j && (j.status === 'pending' || j.state === 'pending' || j.pending === true || j.ready === false);
            if (res.status === 200 && j && !j.error && !pending) {
              STATE.panels[panel.key] = { data: j, ok: true, mock: false, error: null, at: Date.now() };
            } else if (res.status === 404) {
              setPanel(panel, '端点未就绪(404)');
            } else if (pending) {
              setPanel(panel, '数据源同步中(pending)');
            } else {
              setPanel(panel, '端点异常(' + res.status + ')');
            }
          } catch (e) {
            setPanel(panel, '解析失败');
          }
          cb && cb();
        },
        onerror: function () {
          if (!retried) {
            setTimeout(function () { attemptPanel(true); }, 2000);
          } else {
            setPanel(panel, '端点不可达');
            cb && cb();
          }
        },
        ontimeout: function () {
          if (!retried) {
            setTimeout(function () { attemptPanel(true); }, 2000);
          } else {
            setPanel(panel, '端点超时');
            cb && cb();
          }
        }
      });
    }
    attemptPanel(false);
  }

  // ---------- mock 数据（端点未就绪时先行开发用，联调后自动被真实数据覆盖） ----------
  // v5.6 联调后：mock 结构已对齐真实 API（/api/kb_stats 等顾码实现）
  function mockPanel(key) {
    var today = new Date();
    var nowMs = Date.now();
    function d(n) {
      var x = new Date(today); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10);
    }
    if (key === 'kb') {
      return {
        generated_at: new Date().toISOString(),
        total_cards: 258,
        by_tag: { 'gu-ce': 193, 'gu-coder': 100, 'gu-ops': 44, 'gu-chong': 49, 'gu-she': 20 },
        index_built_at: '2026-08-04 10:35'
      };
    }
    if (key === 'cost') {
      return {
        generated_at: new Date().toISOString(),
        daily: [
          { day: d(6), cost: 0.42 }, { day: d(5), cost: 0.51 },
          { day: d(4), cost: 0.38 }, { day: d(3), cost: 0.47 },
          { day: d(2), cost: 0.55 }, { day: d(1), cost: 0.44 },
          { day: d(0), cost: 0.36 }
        ],
        today: { day: d(0), cost: 0.36 },
        metrics: { cron_fail_rate_7d: 12.5 },
        alerts: [],
        week_over_week: { pct: -8.3 },
        budget_limit: 20.0, month_spent: 13.2
      };
    }
    if (key === 'registry') {
      return {
        registry_version: 'v1',
        total_assets: 48,
        assets: [
          { name: 'orchestrator.py', node: 'N1', domain: 'R1', owner: 'gu-she', status: '✅ 运行' },
          { name: 'guard_report.py', node: 'N2', domain: 'R2', owner: 'gu-ops', status: '✅ 运行' },
          { name: 'progress_check.py', node: 'N2', domain: 'R2', owner: 'gu-ops', status: '✅ 运行' },
          { name: 'budget_breaker.py', node: 'N3', domain: 'R3', owner: 'gu-chong', status: '⚠ 待验' },
          { name: 'check_balance.ps1', node: 'N3', domain: 'R3', owner: 'gu-ops', status: '✅ 运行' },
          { name: 'taskboard.user.js', node: 'N4', domain: 'R4', owner: 'gu-jian', status: '✅ 运行' }
        ],
        by_node: { N1: 14, N2: 10, N3: 10, N4: 5 }
      };
    }
    if (key === 'flywheel') {
      return {
        generated_at: new Date().toISOString(),
        p0_p3_use_rate: 0.286,
        asset_hit_rate: 1.0,
        reuse_today: { today: 4, used: 4, rate: 1.0 },
        gap_backlog: [
          { date: d(0), task: '零Token改造复核', gap_type: 'no_asset', role: 'gu-ce' },
          { date: d(0), task: '余额巡检脚本化', gap_type: 'no_asset', role: 'gu-ops' }
        ],
        gap_total: 12,
        total_cron_jobs: 21
      };
    }
    if (key === 'roles') {
      // 演示模式 mock：结构对齐真实 /api/roles（9 角色，emoji/color/skills 为真实值）
      function role(id, name, emoji, color, status, skills) {
        return { id: id, name: name, emoji: emoji, theme: '', tagline: '', status: status,
                 color: color, model: '', thinking: '', workspace: '', skills: skills, skills_count: skills.length };
      }
      return {
        generated_at: new Date().toISOString(),
        total: 9,
        source: 'mock',
        roles: [
          role('main', '小龙虾', '🦞', '#ff7a00', 'on', ['taskflow', 'summarize', 'xurl', 'diagram-maker', 'skill-creator', 'weather', 'browser', 'pdf', 'image', 'video-generate', 'tts', 'notion']),
          role('gu-ce', '顾策', '📋', '#9b59b6', 'on', ['article-analyzer', 'article-rewriter', 'blog-writer-zh', 'content-remix', 'find-skills', 'newsletter-launch', 'report-summary-builder', 'skillhub-preference']),
          role('gu-jian', '顾剪', '✂️', '#ff7a00', 'on', ['article-analyzer', 'article-rewriter', 'article-to-infographic', 'blog-writer-zh', 'content-remix', 'openclaw-zh', 'publish-checklist']),
          role('gu-she', '顾蛇', '🐍', '#e74c3c', 'idle', ['daily-ai-news', 'daily-trending', 'multi-source', 'wechat-article-search', 'weibo-hot-search-anonymous', 'xiaohongshu-crawler', 'audio-video-to-text', 'video-crawler', 'video-transcript', 'video-transcript-downloader']),
          role('gu-dao', '顾导', '🎬', '#4c9aff', 'idle', ['article-rewriter', 'article-to-infographic', 'article-tts', 'blog-writer-zh', 'content-remix', 'newsletter-launch', 'report-summary-builder', 'video-generator', 'video-script-generator', 'video-summary']),
          role('gu-chong', '顾虫', '📊', '#2ecc71', 'idle', ['daily-ai-news', 'daily-trending', 'multi-source', 'report-summary-builder', 'wechat-article-search', 'weibo-hot-search-anonymous', 'xiaohongshu-crawler']),
          role('gu-coder', '顾码', '💻', '#f1c40f', 'idle', ['ai-validator', 'article-publisher', 'article-rewriter', 'blog-writer-zh', 'content-publisher', 'publish-checklist', 'social-media-automator']),
          role('gu-ops', '顾维', '🔧', '#1abc9c', 'idle', ['ai-validator', 'find-skills', 'niuwan-usb', 'openclaw-zh', 'publish-checklist', 'report-summary-builder', 'skillhub-preference']),
          role('gu-shang', 'gu-shang', '🤖', '#4c9aff', 'idle', ['article-publisher', 'article-rewriter', 'blog-writer-zh', 'content-publisher', 'newsletter-launch', 'report-summary-builder', 'social-media-automator', 'video-generator'])
        ]
      };
    }
    if (key === 'flow') {
      // mock：结构对齐 /api/taskflow/chain（P0-1 端点就绪后自动被真实数据覆盖）
      return {
        generated_at: new Date().toISOString(),
        source: 'mock',
        count: 3,
        chains: [
          { task_id: 'daily-report', task_name: '日报产线', status: 'ok', role: 'gu-jian',
            script: { name: 'daily_report.py', path: '~/output/日报/daily_report.py' },
            cron: { expr: '0 8 * * *', last_run: '2026-08-18 08:00' },
            outputs: [{ name: '日报_2026-08-18.md', path: '~/output/日报/2026-08-18.md', time: '08-18 08:01', status: 'ok' }] },
          { task_id: 'cost-daily', task_name: '每日成本报表', status: 'ok', role: 'gu-ops',
            script: { name: 'cost_daily.py', path: '~/auto-money/cost_daily.py' },
            cron: { expr: '50 23 * * *', last_run: '2026-08-17 23:50' },
            outputs: [{ name: '每日成本报表_2026-08-16.md', path: '~/output/pending_review/每日成本报表_2026-08-16.md', time: '08-17 23:53', status: 'ok' }] },
          { task_id: 'bili-hot', task_name: 'B站热榜采集', status: 'failed', role: 'gu-she',
            script: { name: 'bili_hot.py', path: '~/auto-money/sources/bili_hot.py' },
            cron: { expr: '*/30 * * * *', last_run: '2026-08-18 00:00', status: 'failed' },
            outputs: [] }
        ]
      };
    }
    if (key === 'outputs') {
      // mock：结构对齐 /api/outputs（roles[].files[]，mtime_ms 驱动今日/本周过滤）
      var mockFiles = [];
      function of(name, path, time, hoursAgo) {
        mockFiles.push({ name: name, title: name, path: path, time: time, mtime: time, mtime_ms: nowMs - hoursAgo * 3600000, size: 1024, status: 'pending' });
      }
      of('日报_2026-08-18.md', '~/output/日报/2026-08-18.md', '08-18 00:10', 1);
      of('飞轮v6执行分配表_20260818.md', '~/output/pending_review/飞轮v6执行分配表_20260818.md', '08-18 00:26', 2);
      of('每日成本报表_2026-08-16.md', '~/output/pending_review/每日成本报表_2026-08-16.md', '08-17 23:53', 26);
      return { generated_at: new Date().toISOString(), source: 'mock', total_files: mockFiles.length, limit: 50,
               roles: { mock: { role: { id: 'mock', name: 'mock' }, files: mockFiles, count: mockFiles.length } } };
    }
    return { generated_at: new Date().toISOString(), error: 'unknown panel' };
  }
  // 手动刷新：带旋转反馈
  function manualRefresh(btn) {
    if (STATE.refreshing) return;
    STATE.refreshing = true;
    if (btn) btn.classList.add('gce-tb5__refresh--spin');
    fetchData(function () {
      STATE.refreshing = false;
      STATE.lastRefresh = Date.now();
      if (btn) btn.classList.remove('gce-tb5__refresh--spin');
      render();
    });
  }

  // ---------- 渲染 ----------
  function renderProgressBar(pct, label) {
    var bar = el('div', 'gce-tb5__bar');
    var fill = el('div', 'gce-tb5__barfill');
    fill.style.width = Math.max(2, Math.min(100, pct || 0)) + '%';
    bar.appendChild(fill);
    bar.appendChild(el('div', 'gce-tb5__barlabel', esc(label || '')));
    return bar;
  }

  function renderAutoTable(container, q) {
    if (!q || q.error) {
      container.appendChild(el('div', 'gce-tb5__empty', '⚠ ' + esc((q && q.error) || '无数据')));
      return;
    }
    if (!q.tasks.length) {
      container.appendChild(el('div', 'gce-tb5__empty', '暂无自动执行任务'));
      return;
    }
    var tbl = el('table', 'gce-tb5__table');
    var thead = el('thead');
    var hr = el('tr');
    ['梯队', '任务', '计划/作用', '发起', '执行', '状态'].forEach(function (h) {
      hr.appendChild(el('th', '', h));
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    q.tasks.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', '', '<span class="gce-tb5__st-dim">' + tierLabel(t.tier) + '</span>'));
      tr.appendChild(el('td', 'gce-tb5__tname', esc(t.name) + (t.enabled ? '' : ' <span class="gce-tb5__st-dim">(停)</span>')));
      tr.appendChild(el('td', 'gce-tb5__plan-cell', planBadge(t)));
      tr.appendChild(el('td', '', esc(t.next_run || '-')));
      tr.appendChild(el('td', '', esc(t.last_run || '-') + (t.last_duration && t.last_duration !== '-' ? ' · ' + esc(t.last_duration) : '')));
      tr.appendChild(el('td', 'gce-tb5__st-' + (t.last_status || ''), statusText(t.last_status) + (t.last_error ? ' <span title="' + esc(t.last_error) + '">⚠</span>' : '')));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    container.appendChild(tbl);
    if (q.truncated) container.appendChild(el('div', 'gce-tb5__trunc', '… 仅显示前 ' + MAX_ROWS + ' 条（共 ' + q.total + '）'));
  }

  // 实时梯队分组渲染（v5.4）：每梯队一个分组 + 垂直滚动条
  function renderLiveTiers(container, q) {
    if (!q || q.error) {
      container.appendChild(el('div', 'gce-tb5__empty', '⚠ ' + esc((q && q.error) || '无数据')));
      return;
    }
    if (!q.tasks.length) {
      container.appendChild(el('div', 'gce-tb5__empty', '当前无执行中的任务'));
      return;
    }
    var tiers = q.tiers || {};
    var meta = q.tier_meta || {};
    TIER_ORDER.forEach(function (tk) {
      var list = tiers[tk] || [];
      if (!list.length) return;
      var m = meta[tk] || {};
      var sec = el('div', 'gce-tb5__tier ' + tierClass(tk));
      var head = el('div', 'gce-tb5__tierhead');
      head.appendChild(el('span', '', tierLabel(tk)));
      head.appendChild(el('span', 'gce-tb5__tiercount', String(list.length)));
      if (m.desc) head.appendChild(el('span', 'gce-tb5__tierdesc', esc(m.desc)));
      sec.appendChild(head);
      // 垂直滚动条：每梯队 max-height 140px，overflow-y auto
      var body = el('div', 'gce-tb5__tierbody');
      body.style.maxHeight = TIER_MAXH;
      body.style.overflowY = 'auto';
      var tbl = el('table', 'gce-tb5__table');
      var thead = el('thead');
      var hr = el('tr');
      ['任务', '计划/作用', '发起', '已耗时', '进度'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
      thead.appendChild(hr);
      tbl.appendChild(thead);
      var tb = el('tbody');
      list.forEach(function (t) {
        var tr = el('tr');
        tr.appendChild(el('td', 'gce-tb5__tname', '<span class="gce-tb5__livepulse"></span>' + esc(t.name)));
        tr.appendChild(el('td', 'gce-tb5__plan-cell', planBadge(t)));
        tr.appendChild(el('td', '', esc(t.running_since || '-')));
        tr.appendChild(el('td', '', esc(t.elapsed || '-')));
        var ptd = el('td', '');
        ptd.appendChild(renderProgressBar(t.progress, t.progress_label + ' ' + (t.elapsed || '')));
        tr.appendChild(ptd);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      body.appendChild(tbl);
      sec.appendChild(body);
      container.appendChild(sec);
    });
    if (q.truncated) container.appendChild(el('div', 'gce-tb5__trunc', '… 仅显示前 ' + MAX_ROWS + ' 条（共 ' + q.total + '）'));
  }

  // v5.8：挂起队列三组渲染（abnormal/disabled/suspended），复用梯队分组样式
  var PENDING_GROUPS = [
    { key: 'abnormal',  title: '异常',        icon: '🔴', cls: 'gce-tb5__tier--critical' },
    { key: 'disabled',  title: '已禁用',      icon: '⚪', cls: 'gce-tb5__tier--unmapped' },
    { key: 'suspended', title: '挂起开发',    icon: '🟡', cls: 'gce-tb5__tier--medium' }
  ];
  // 三组各自的小标题 + 计数（异常/已禁用/挂起开发）
  function pendingGroupHead(sec, g, list) {
    var head = el('div', 'gce-tb5__tierhead');
    head.appendChild(el('span', '', g.icon + ' ' + g.title));
    head.appendChild(el('span', 'gce-tb5__tiercount', String(list.length)));
    sec.appendChild(head);
  }
  // 异常组：保留原有列（梯队/任务/计划/发起/执行/状态）
  function renderPendingAbnormal(container, list) {
    if (!list.length) return;
    var sec = el('div', 'gce-tb5__tier ' + 'gce-tb5__tier--critical');
    pendingGroupHead(sec, PENDING_GROUPS[0], list);
    var body = el('div', 'gce-tb5__tierbody');
    body.style.maxHeight = TIER_MAXH;
    body.style.overflowY = 'auto';
    var tbl = el('table', 'gce-tb5__table');
    var thead = el('thead');
    var hr = el('tr');
    ['梯队', '任务', '计划/作用', '发起', '执行', '状态'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    list.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', '', '<span class="gce-tb5__st-dim">' + tierLabel(t.tier) + '</span>'));
      tr.appendChild(el('td', 'gce-tb5__tname', esc(t.name)));
      tr.appendChild(el('td', 'gce-tb5__plan-cell', planBadge(t)));
      tr.appendChild(el('td', '', esc(t.launch_time || '-')));
      tr.appendChild(el('td', '', esc(t.exec_time || '-')));
      var stTd = el('td', '');
      stTd.innerHTML = '<span class="' + statusClass(t.status) + '">' + statusText(t.status) + '</span>' +
        (t.progress ? ' <span class="gce-tb5__st-dim">' + esc(t.progress) + '</span>' : '') +
        (t.error ? ' <span class="gce-tb5__st-err" title="' + esc(t.error) + '">⚠</span>' : '');
      tr.appendChild(stTd);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);
    sec.appendChild(body);
    container.appendChild(sec);
  }
  // 已禁用组：名称 + 最后运行时间 + 状态（禁用原因 tooltip）
  function renderPendingDisabled(container, list) {
    if (!list.length) return;
    var sec = el('div', 'gce-tb5__tier ' + 'gce-tb5__tier--unmapped');
    pendingGroupHead(sec, PENDING_GROUPS[1], list);
    var body = el('div', 'gce-tb5__tierbody');
    body.style.maxHeight = TIER_MAXH;
    body.style.overflowY = 'auto';
    var tbl = el('table', 'gce-tb5__table');
    var thead = el('thead');
    var hr = el('tr');
    ['任务', '最后运行', '状态'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    list.forEach(function (t) {
      var tr = el('tr');
      var nameTd = el('td', 'gce-tb5__tname', esc(t.name));
      nameTd.title = 'job_id: ' + (t.task_id || '') + (t.error ? '\n错误: ' + t.error : '');
      tr.appendChild(nameTd);
      tr.appendChild(el('td', '', esc(t.last_run || '-') + (t.last_duration && t.last_duration !== '-' ? ' · ' + esc(t.last_duration) : '')));
      var stTd = el('td', '');
      stTd.innerHTML = '<span class="' + statusClass(t.last_status) + '">' + statusText(t.last_status) + '</span>' +
        (t.error ? ' <span class="gce-tb5__st-err" title="' + esc(t.error) + '">⚠</span>' : '');
      tr.appendChild(stTd);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);
    sec.appendChild(body);
    container.appendChild(sec);
  }
  // 挂起开发组：job_id/plan/role/purpose 重点字段
  function renderPendingSuspended(container, list) {
    if (!list.length) return;
    var sec = el('div', 'gce-tb5__tier ' + 'gce-tb5__tier--medium');
    pendingGroupHead(sec, PENDING_GROUPS[2], list);
    var body = el('div', 'gce-tb5__tierbody');
    body.style.maxHeight = TIER_MAXH;
    body.style.overflowY = 'auto';
    var tbl = el('table', 'gce-tb5__table');
    var thead = el('thead');
    var hr = el('tr');
    ['job_id', '计划/作用', '角色', '用途', '状态'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = el('tbody');
    list.forEach(function (t) {
      var tr = el('tr');
      tr.appendChild(el('td', 'gce-tb5__tname', esc(t.job_id || t.task_id || t.name || '-')));
      tr.appendChild(el('td', 'gce-tb5__plan-cell', planBadge(t)));
      tr.appendChild(el('td', '', esc(t.role || '-')));
      tr.appendChild(el('td', '', esc(t.purpose || '-')));
      var stTd = el('td', '');
      stTd.innerHTML = '<span class="gce-tb5__st-wait">⏸ 挂起</span>' +
        (t.suspended_reason ? ' <span class="gce-tb5__st-dim" title="' + esc(t.suspended_reason) + '">ℹ</span>' : '');
      tr.appendChild(stTd);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);
    sec.appendChild(body);
    container.appendChild(sec);
  }
  function renderPendingTable(container, q) {
    if (!q || q.error) {
      container.appendChild(el('div', 'gce-tb5__empty', '⚠ ' + esc((q && q.error) || '无数据')));
      return;
    }
    var tasks = q.tasks || {};
    // 兼容：旧版数组结构（平铺）降级为 abnormal 组
    var abnormal = Array.isArray(tasks) ? tasks : (tasks.abnormal || []);
    var disabled = Array.isArray(tasks) ? [] : (tasks.disabled || []);
    var suspended = Array.isArray(tasks) ? [] : (tasks.suspended || []);
    var total = abnormal.length + disabled.length + suspended.length;
    if (!total) {
      container.appendChild(el('div', 'gce-tb5__empty', '无挂起/异常任务'));
      return;
    }
    renderPendingAbnormal(container, abnormal);
    renderPendingDisabled(container, disabled);
    renderPendingSuspended(container, suspended);
    if (q.truncated) container.appendChild(el('div', 'gce-tb5__trunc', '… 仅显示前 ' + MAX_ROWS + ' 条（共 ' + q.total + '）'));
  }

  // ===== v5.6 端点面板 #4 渲染函数（复用 renderSection + el/esc，纯 CSS 无图表库） =====

  // 通用：面板数据空/错误
  function panelEmpty(container, msg) {
    container.appendChild(el('div', 'gce-tb5__empty', '⚠ ' + esc(msg || '无数据')));
  }

  // 📚 知识库面板：/api/kb_stats（真实结构：by_tag 为 {tag: count} 对象）
  function renderKbPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    // 统计网格：总卡数/周增量/一致性
    var grid = el('div', 'gce-tb5__statgrid');
    function cell(label, val, cls) {
      var c = el('div', 'gce-tb5__stat');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', cls || '', esc(val)));
      grid.appendChild(c);
    }
    var total = d.total_cards != null ? d.total_cards : '-'
    cell('总卡数', total);
    // 增长展示（9问P2-#7）：/api/kb_stats 新增 growth{today,d7,d30,basis}；缺失不显示、不报错
    var g = d.growth && typeof d.growth === 'object' ? d.growth : null;
    if (g && (g.today != null || g.d7 != null || g.d30 != null)) {
      var c = el('div', 'gce-tb5__stat');
      // basis 口径悬浮（顾策拍板 08-20）：title 透明化「+N 是什么」
      if (g.basis != null) {
        var basisTxt = (typeof g.basis === 'object') ? JSON.stringify(g.basis) : String(g.basis);
        if (basisTxt) c.title = '统计口径: ' + basisTxt;
      }
      c.appendChild(el('span', '', '📈 增长'));
      var parts = [];
      if (g.today != null) parts.push('今日 <b class="' + (g.today > 0 ? 'gce-tb5__st-ok' : 'gce-tb5__st-dim') + '">+' + g.today + '</b>');
      if (g.d7 != null) parts.push('7日 +' + g.d7);
      if (g.d30 != null) parts.push('30日 +' + g.d30);
      c.appendChild(el('b', '', parts.join(' · ')));
      grid.appendChild(c);
    }
    cell('索引更新', d.index_built_at ? esc(d.index_built_at) : '-');
    if (d.week_added != null) cell('周增量', '+' + d.week_added);
    if (d.consistency != null) {
      cell('一致性', Math.round(d.consistency * 100) + '%',
        d.consistency >= 0.9 ? 'gce-tb5__st-ok' : (d.consistency >= 0.7 ? 'gce-tb5__st-wait' : 'gce-tb5__st-err'));
    }
    container.appendChild(grid);
    // 按 tag 分布：by_tag 可能是数组（mock）或对象（真实）
    var tags = [];
    if (Array.isArray(d.by_tag)) {
      d.by_tag.forEach(function (t) { tags.push({ tag: t.tag, count: t.count }); });
    } else if (d.by_tag && typeof d.by_tag === 'object') {
      var keys = Object.keys(d.by_tag);
      // 排序取 top 10
      keys.sort(function (a, b) { return (d.by_tag[b] || 0) - (d.by_tag[a] || 0); });
      keys.slice(0, 10).forEach(function (k) { tags.push({ tag: k, count: d.by_tag[k] }); });
    }
    if (tags.length) {
      var tagRow = el('div', '', '');
      var max = 1;
      tags.forEach(function (t) { if (t.count > max) max = t.count; });
      tags.forEach(function (t) {
        var hot = t.count >= max * 0.7;
        tagRow.appendChild(el('span', 'gce-tb5__tag' + (hot ? ' gce-tb5__tag--hot' : ''),
          esc(t.tag) + ' <b>' + t.count + '</b>'));
      });
      container.appendChild(tagRow);
    }
  }

  // 💰 成本面板：/api/cost_trend（真实结构：daily[].day/.cost + today/metrics/alerts）
  function renderCostPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    // 告警
    var alerts = d.alerts || [];
    alerts.forEach(function (a) {
      var cls = a.level === 'error' ? 'gce-tb5__st-err' : 'gce-tb5__st-wait';
      container.appendChild(el('div', 'gce-tb5__stat', '<span class="' + cls + '">⚠ [' + esc(a.code || '') + '] ' + esc(a.msg || '') + '</span>'));
    });
    // 今日成本 + 指标
    var t = d.today || {};
    var m = d.metrics || {};
    var grid = el('div', 'gce-tb5__statgrid');
    function cell(label, val, cls) {
      var c = el('div', 'gce-tb5__stat');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', cls || '', esc(val)));
      grid.appendChild(c);
    }
    if (t.cost != null) cell('今日成本', '¥' + Number(t.cost).toFixed(2),
      t.cost > 8 ? 'gce-tb5__st-err' : (t.cost > 5 ? 'gce-tb5__st-wait' : 'gce-tb5__st-ok'));
    if (m.cron_fail_rate_7d != null) cell('7d 失败率', m.cron_fail_rate_7d + '%',
      m.cron_fail_rate_7d > 30 ? 'gce-tb5__st-err' : (m.cron_fail_rate_7d > 15 ? 'gce-tb5__st-wait' : 'gce-tb5__st-ok'));
    if (t.reasoner_ratio != null) cell('reasoner 占比', t.reasoner_ratio + '%');
    if (d.week_over_week && d.week_over_week.pct != null) {
      var w = d.week_over_week;
      cell('周环比', (w.pct >= 0 ? '+' : '') + w.pct + '%', w.pct > 0 ? 'gce-tb5__st-err' : 'gce-tb5__st-ok');
    }
    if (d.budget_limit != null) {
      var pctUsed = Math.round((d.month_spent || 0) / d.budget_limit * 100);
      cell('月预算', esc(d.month_spent) + '/' + esc(d.budget_limit) + ' (' + pctUsed + '%)',
        pctUsed > 85 ? 'gce-tb5__st-err' : pctUsed > 65 ? 'gce-tb5__st-wait' : 'gce-tb5__st-ok');
    }
    container.appendChild(grid);
    // 趋势条形：daily[].day + daily[].cost（纯 CSS）
    var daily = d.daily || [];
    if (daily.length) {
      var max = 1;
      daily.forEach(function (x) { if ((x.cost || 0) > max) max = x.cost; });
      daily.forEach(function (x) {
        var row = el('div', 'gce-tb5__trend');
        row.appendChild(el('span', 'gce-tb5__trend-label', esc(String(x.day || '').slice(5))));
        var track = el('div', 'gce-tb5__trend-track');
        var pct = Math.max(3, Math.min(100, Math.round((x.cost || 0) / max * 100)));
        var fill = el('div', 'gce-tb5__trend-fill', '');
        fill.style.width = pct + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'gce-tb5__trend-val', '¥' + Number(x.cost || 0).toFixed(2)));
        container.appendChild(row);
      });
    }
  }

  // 🗂 资产注册表面板：/api/registry（真实结构：assets[] + by_node，按 node/domain 分组）
  function renderRegistryPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    // 总资产 + 版本
    container.appendChild(el('div', 'gce-tb5__stat',
      '总资产 <b>' + esc(d.total_assets != null ? d.total_assets : '-') + '</b>' +
      (d.registry_version ? ' <span class="gce-tb5__st-dim">v' + esc(d.registry_version) + '</span>' : '')));
    var assets = d.assets || [];
    if (!assets.length) { panelEmpty(container, '无资产'); return; }
    // 按 node 分组（保持 by_node 顺序或按数量降序）
    var nodes = {};
    var nodeOrder = [];
    assets.forEach(function (a) {
      var n = a.node || '?', dom = a.domain || '';
      var key = n + '|' + dom;
      if (!nodes[key]) { nodes[key] = { node: n, domain: dom, items: [] }; nodeOrder.push(key); }
      nodes[key].items.push(a);
    });
    // 按 node 数量降序
    nodeOrder.sort(function (a, b) { return nodes[b].items.length - nodes[a].items.length; });
    nodeOrder.forEach(function (key) {
      var g = nodes[key];
      var node = el('div', 'gce-tb5__regnode');
      var head = el('div', 'gce-tb5__regnodehead');
      head.appendChild(el('span', '', '● ' + esc(g.node)));
      head.appendChild(el('span', 'gce-tb5__st-dim', esc(g.domain || '')));
      head.appendChild(el('span', 'gce-tb5__regnodecount', String(g.items.length)));
      node.appendChild(head);
      var tbl = el('table', 'gce-tb5__table');
      var thead = el('thead'); var hr = el('tr');
      ['资产', 'owner', '状态'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
      thead.appendChild(hr); tbl.appendChild(thead);
      var tb = el('tbody');
      g.items.slice(0, 12).forEach(function (a) {
        var tr = el('tr');
        tr.appendChild(el('td', 'gce-tb5__tname', esc(a.name || '')));
        tr.appendChild(el('td', '', esc(a.owner || '-')));
        var st = String(a.status || '');
        var cls = /ok|运行|✅/.test(st) ? 'gce-tb5__st-ok' : /warn|⚠/.test(st) ? 'gce-tb5__st-wait' : /err|fail|❌/.test(st) ? 'gce-tb5__st-err' : 'gce-tb5__st-dim';
        tr.appendChild(el('td', cls, esc(st)));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      node.appendChild(tbl);
      container.appendChild(node);
    });
  }

  // 🔄 飞轮面板：/api/flywheel（真实结构：p0_p3_use_rate + asset_hit_rate + reuse_today + gap_backlog）
  function renderFlywheelPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    var grid = el('div', 'gce-tb5__statgrid');
    function cell(label, val, cls) {
      var c = el('div', 'gce-tb5__stat');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', cls || '', esc(val)));
      grid.appendChild(c);
    }
    // P0-P3 使用率
    cell('P0-P3 使用率', d.p0_p3_use_rate != null ? Math.round(d.p0_p3_use_rate * 100) + '%' : '-',
      d.p0_p3_use_rate >= 0.6 ? 'gce-tb5__st-ok' : d.p0_p3_use_rate >= 0.3 ? 'gce-tb5__st-wait' : 'gce-tb5__st-err');
    // 资产命中率/复用率
    var reuse = d.asset_hit_rate != null ? d.asset_hit_rate : (d.reuse_today ? d.reuse_today.rate : null);
    cell('资产命中率', reuse != null ? Math.round(reuse * 100) + '%' : '-',
      reuse >= 0.6 ? 'gce-tb5__st-ok' : 'gce-tb5__st-wait');
    // 今日复用
    if (d.reuse_today && d.reuse_today.used != null) {
      cell('今日复用', d.reuse_today.used + ' 次');
    }
    // 缺口积压
    var gaps = d.gap_backlog || [];
    cell('缺口积压', d.gap_total != null ? d.gap_total : (Array.isArray(gaps) ? gaps.length : '-'),
      gaps.length > 0 ? 'gce-tb5__st-wait' : 'gce-tb5__st-ok');
    if (d.total_cron_jobs != null) cell('cron 任务', d.total_cron_jobs);
    container.appendChild(grid);
    // 缺口积压明细（前 5 条）
    if (Array.isArray(gaps) && gaps.length) {
      var tbl = el('table', 'gce-tb5__table');
      var thead = el('thead'); var hr = el('tr');
      ['日期', '缺口', '类型'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
      thead.appendChild(hr); tbl.appendChild(thead);
      var tb = el('tbody');
      gaps.slice(0, 5).forEach(function (g) {
        var tr = el('tr');
        tr.appendChild(el('td', '', esc(String(g.date || '').slice(5))));
        tr.appendChild(el('td', 'gce-tb5__tname', esc(g.task || '')));
        tr.appendChild(el('td', '', '<span class="gce-tb5__tag">' + esc(g.gap_type || '-') + '</span>'));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      container.appendChild(tbl);
    }
  }

  // 🎭 角色面板：/api/roles（档案卡：emoji 头像 + 名字 + 主题色 + 技能列表 + 技能数）
  // v6.2 6点P2/P3：角色面板头部行 + 点击展开/收起下拉（计划≤5 + 技能≤12），默认收起一屏全览
  function roleStatusBadge(r) {
    var st = r.status;
    var liveFlag = r.status === 'live' || (r.ops && r.ops.live_tasks > 0);
    var h = '';
    if (liveFlag) h += '<span class="gce-tb5__st-ok">⚡ 实时中</span> ';
    if (st === 'on') h += '<span class="gce-tb5__st-ok">● 在线</span>';
    else if (st === 'err') h += '<span class="gce-tb5__st-err">✕ 异常</span>';
    else h += '<span class="gce-tb5__st-dim">○ 空闲</span>';
    return h;
  }
  function roleWeekSummary(r) {
    var ops = r.ops || null;
    var parts = [];
    if (ops && (ops.week_tasks != null || ops.week_runs != null)) {
      var weekTasks = ops.week_tasks != null ? ops.week_tasks : ops.week_runs;
      if (weekTasks > 0) {
        parts.push('周 ' + weekTasks + ' 任务');
        if (ops.week_success_rate != null) {
          var sr = Number(ops.week_success_rate);
          var srCls = sr >= 90 ? 'gce-tb5__st-ok' : sr >= 70 ? 'gce-tb5__st-wait' : 'gce-tb5__st-err';
          parts.push('成功率 <b class="' + srCls + '">' + Math.round(sr) + '%</b>');
        }
        if (ops.week_cost != null) parts.push('成本 ¥' + esc(ops.week_cost));
      } else {
        parts.push('<span class="gce-tb5__st-dim">本周无任务</span>');
      }
    }
    return parts.join(' · ');
  }
  function renderRolesPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    var roles = d.roles || [];
    if (!roles.length) { panelEmpty(container, '暂无角色'); return; }
    var grid = el('div', 'gce-tb5__roles', '');
    roles.forEach(function (r) {
      var card = el('div', 'gce-tb5__rolecard', '');
      var color = r.color || '#9c6bff';
      card.style.borderLeft = '3px solid ' + color;
      // ---- 头部行：emoji + 名字 + 状态 + 周摘要（默认收起，一屏全览） ----
      var head = el('div', 'gce-tb5__rolehead gce-tb5__rolehead--fold', '');
      head.appendChild(el('span', 'gce-tb5__roleavatar', esc(r.emoji || '❓')));
      var nameWrap = el('span', 'gce-tb5__rolename', '');
      nameWrap.appendChild(el('b', '', esc(r.name || r.id || '?')));
      if (r.id) nameWrap.appendChild(el('span', 'gce-tb5__roledim', esc(r.id)));
      nameWrap.appendChild(el('span', '', roleStatusBadge(r)));
      head.appendChild(nameWrap);
      var wk = roleWeekSummary(r);
      head.appendChild(el('span', 'gce-tb5__rolesummary', wk));
      head.appendChild(el('span', 'gce-tb5__rolecaret', '▾'));
      card.appendChild(head);
      // ---- 下拉区（默认隐藏，点击头部行展开/收起） ----
      var fold = el('div', 'gce-tb5__rolefold', '');
      fold.style.display = 'none';
      // 📋 计划（≤5 条；空显「无计划」）
      var plan = r.plan && typeof r.plan === 'object' ? r.plan : null;
      var planCount = plan && (plan.plan_count != null || (plan.plans && plan.plans.length)) ? (plan.plan_count != null ? plan.plan_count : (plan.plans ? plan.plans.length : 0)) : 0;
      var planLine = el('div', 'gce-tb5__roledim', '<b>📋 计划 ' + planCount + '</b>');
      var plans = (plan && plan.plans) || [];
      var shownPlans = 0;
      plans.slice(0, 5).forEach(function (p) {
        if (!p || typeof p !== 'object') return;
        var dirs = (p.directions || []).slice(0, 5);
        var line = el('div', '', '');
        line.appendChild(el('span', 'gce-tb5__st-dim', '· '));
        line.appendChild(el('span', '', esc(p.title || '计划')));
        if (dirs.length) line.appendChild(el('span', 'gce-tb5__st-dim', '：' + dirs.join(' / ')));
        planLine.appendChild(line);
        shownPlans++;
      });
      if (!shownPlans) planLine.appendChild(el('span', 'gce-tb5__st-dim', '无计划'));
      fold.appendChild(planLine);
      // 🛠 技能（≤12 条；空显「技能列表待接入」）
      var skills = r.skills || [];
      var skillLine = el('div', 'gce-tb5__roleskills', '');
      skillLine.appendChild(el('span', 'gce-tb5__roledim', '<b>🛠 技能</b>'));
      if (skills.length) {
        skills.slice(0, 12).forEach(function (s) {
          skillLine.appendChild(el('span', 'gce-tb5__tag', esc(s)));
        });
        if (skills.length > 12) skillLine.appendChild(el('span', 'gce-tb5__roledim', '+' + (skills.length - 12)));
      } else {
        skillLine.appendChild(el('span', 'gce-tb5__st-dim', '技能列表待接入'));
      }
      fold.appendChild(skillLine);
      card.appendChild(fold);
      // 点击头部行切换
      head.onclick = function () {
        var open = fold.style.display === 'none';
        fold.style.display = open ? '' : 'none';
        head.querySelector('.gce-tb5__rolecaret').textContent = open ? '▴' : '▾';
      };
      grid.appendChild(card);
    });
    container.appendChild(grid);
    if (d.source) container.appendChild(el('div', 'gce-tb5__roledim', '数据源: ' + esc(d.source) + (d.generated_at ? ' · ' + esc(String(d.generated_at).slice(0, 19).replace('T', ' ')) : '')));
  }

  // 📊 数据指纹：5 面板 · 更新时间 · 源在线数
  // ================= v6.0 三台拆分 + 任务流 + 成果展示区（P0-2 顾码 2026-08-18） =================

  var panelRenderers = {
    kb: renderKbPanel,
    cost: renderCostPanel,
    registry: renderRegistryPanel,
    flywheel: renderFlywheelPanel,
    roles: renderRolesPanel,
    flow: renderFlowPanel,
    outputs: renderAchievements,
    topic_pool: renderTopicPool,
    material: renderMaterial,
    channel_health: renderHealthChannel
  };

  // 视图切换栏（三台 + 任务流 tab）
  function renderViewTabs() {
    var bar = el('div', 'gce-tb5__desks');
    VIEWS.forEach(function (v) {
      var b = el('div', 'gce-tb5__deskbtn' + (STATE.view === v.key ? ' gce-tb5__deskbtn--on' : ''), v.title);
      b.title = v.key === 'ops' ? '任务队列+梯队+成果展示区（主屏）' : v.key === 'flow' ? '任务卡→脚本→cron→最近产出（只读）' : v.key === 'health' ? '成本趋势+运营总览+渠道凭证健康（异常才看）' : '知识库+注册表+选题池+素材供需（按需）';
      b.onclick = function () { switchView(v.key); };
      bar.appendChild(b);
    });
    return bar;
  }

  // 渲染单个面板节（已拉取才渲染；mock 时附 ⚡ 提示）
  function renderViewPanel(container, key) {
    var p = null;
    PANELS.forEach(function (x) { if (x.key === key) p = x; });
    var st = STATE.panels[key];
    if (!p || !st) return;
    var pBody = el('div', 'gce-tb5__qbody gce-tb5__pbody gce-tb5__pbody--' + key);
    renderSection(pBody, 'panel-' + key, p.title, p.badge(st.data), st.data, panelRenderers[key], false);
    if (st.mock) pBody.appendChild(el('div', 'gce-tb5__mock', 'mock 数据（端点 ' + p.path + ' 未就绪，' + esc(st.error || '') + '）'));
    container.appendChild(pBody);
  }

  // 🟢 任务运营台：状态摘要 + 三队列（梯队）+ 角色面板（底部）
  function renderOpsView(body, d) {
    var s = d.summary || {};
    var grid = el('div', 'gce-tb5__summarygrid');
    function cell(label, html) {
      var c = el('div', 'gce-tb5__cell');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', '', html));
      grid.appendChild(c);
    }
    cell('主控', masterBadge(s));
    cell('自动', s.auto_tasks || 0);
    cell('实时', s.live_tasks || 0);
    cell('挂起', '<span class="' + (s.pending_tasks ? 'gce-tb5__st-wait' : 'gce-tb5__st-dim') + '">' + (s.pending_tasks || 0) + '</span>');
    body.appendChild(grid);

    var q = d.queues || {};
    if (STATE.mount === 'rail') {
      var qGrid = el('div', 'gce-tb5__qgrid');
      function qCell(key, title) {
        var c = el('div', 'gce-tb5__qcell');
        var n = key === 'auto' ? (s.auto_tasks || 0) : key === 'live' ? (s.live_tasks || 0) : (s.pending_tasks || 0);
        var open = STATE.collapsedSections[key] !== false; // v5.5：默认展开
        c.appendChild(el('span', 'gce-tb5__qlabel', (open ? '▾ ' : '▸ ') + title));
        c.appendChild(el('b', '', String(n)));
        c.onclick = function () { toggleSection(key); };
        c.title = (open ? '点击折叠' : '点击展开') + ' ' + title + ' 明细';
        return c;
      }
      qGrid.appendChild(qCell('auto', '自动'));
      qGrid.appendChild(qCell('live', '实时'));
      qGrid.appendChild(qCell('pending', '挂起'));
      body.appendChild(qGrid);
      // 全部默认展开（collapsedSections[key] !== false），每队列滚动条控高
      if (STATE.collapsedSections['auto'] !== false) renderSection(body, 'auto', '自动执行任务队列', s.auto_tasks || 0, q.auto, renderAutoTable, false, true);
      if (STATE.collapsedSections['live'] !== false) renderSection(body, 'live', '实时任务队列', s.live_tasks || 0, q.live, renderLiveTiers, true, true);
      if (STATE.collapsedSections['pending'] !== false) renderSection(body, 'pending', '挂起任务队列', s.pending_tasks || 0, q.pending, renderPendingTable, false, true);
    } else {
      // input/float 完整布局
      renderSection(body, 'auto', '自动执行任务队列', s.auto_tasks || 0, q.auto, renderAutoTable, false);
      renderSection(body, 'live', '实时任务队列', s.live_tasks || 0, q.live, renderLiveTiers, true);
      renderSection(body, 'pending', '挂起任务队列', s.pending_tasks || 0, q.pending, renderPendingTable, false);
    }
    renderViewPanel(body, 'roles');
  }

  // 🔗 任务流 tab：/api/taskflow/chain
  function renderFlowView(body) { renderViewPanel(body, 'flow'); }

  // 💰 成本健康台：成本趋势 + 运营总览 + 渠道/凭证/采集健康（/api/channel_health，数据源在途→降级占位）
  function renderHealthView(body) {
    renderViewPanel(body, 'cost');
    renderViewPanel(body, 'flywheel');
    renderViewPanel(body, 'channel_health');
  }

  // 📚 知识资产台：知识库 + 资产注册表 + 选题池/素材供需（/api/topic_pool · /api/material_supply，端点未就绪→降级占位）
  function renderKnowledgeView(body) {
    renderViewPanel(body, 'kb');
    renderViewPanel(body, 'registry');
    renderViewPanel(body, 'topic_pool');
    renderViewPanel(body, 'material');
  }

  // ================= v6.2 6点P2/P3：选题池/素材供需/渠道健康 三数据面板 =================
  // 端点由顾维 sidecar / 顾蛇 channel_health.json 并行在途；未就绪（404/超时6s/pending）→ 降级占位
  var PLACEHOLDER_P1 = '数据源已就绪（按需加载）';

  function pct(v) {
    if (v == null || v === '') return '-';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    if (n <= 1.5) n = n * 100; // 0~1 比例 → 百分数
    return Math.round(n) + '%';
  }
  function fmtNum(v) {
    if (v == null || v === '') return '-';
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return String(Math.round(n * 100) / 100);
  }

  // 降级占位：不白屏、不报错刷屏；错误详情放 title 悬浮提示
  function panelDegraded(container, err) {
    var w = el('div', 'gce-tb5__empty', PLACEHOLDER_P1);
    if (err) w.title = '数据源未就绪：' + err;
    container.appendChild(w);
  }

  function topicPoolBadge(d) {
    if (!d || !d.counts) return '-';
    return d.counts.topics != null ? d.counts.topics : '-';
  }
  function materialBadge(d) {
    if (!d) return '-';
    var n = d.total_materials != null ? d.total_materials : (d.total != null ? d.total : (d.counts ? d.counts.total : null));
    return n != null ? n : '-';
  }
  function channelBadge(d) {
    if (!d) return '-';
    if (d.health_grade) {
      if (typeof d.health_grade === 'object') return d.health_grade.grade || '-';
      return d.health_grade;
    }
    if (Array.isArray(d.channels)) return d.channels.length;
    if (d.channels && typeof d.channels === 'object') return Object.keys(d.channels).length;
    return '-';
  }

  // 🎯 选题池：/api/topic_pool（topic_pool_index.json · 顾导 V11）
  // v6.2 6点P2/P3：英文→中文映射表（已中文透传 / 未命中 key 透传原值）
  var TOPIC_POOL_ZH = {
    'topics': '选题总数',
    'material_to_topic': '素材→选题转化率',
    'topic_to_script': '选题→脚本转化率',
    'pending': '待处理',
    'selected': '已选',
    'draft': '草稿'
  };
  function zhTopicLabel(k) {
    if (k == null) return k;
    if (Object.prototype.hasOwnProperty.call(TOPIC_POOL_ZH, k)) return TOPIC_POOL_ZH[k];
    return k; // 未命中透传原值
  }

  function renderTopicPool(container, d) {
    if (!d || d.error) { panelDegraded(container, (d && d.error) || '无数据'); return; }
    var counts = d.counts || {};
    var grid = el('div', 'gce-tb5__statgrid');
    function cell(label, val, cls) {
      var c = el('div', 'gce-tb5__stat');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', cls || '', esc(val)));
      grid.appendChild(c);
    }
    cell('选题总数', counts.topics != null ? counts.topics : '-');
    // 状态分布（池中/已拆解等）：by_status 对象；缺省回退 counts 其余数字字段
    var byStatus = (counts.by_status && typeof counts.by_status === 'object') ? counts.by_status
      : (d.by_status && typeof d.by_status === 'object') ? d.by_status : null;
    var statusKeys = [];
    if (byStatus) {
      statusKeys = Object.keys(byStatus).slice(0, 8);
    } else {
      Object.keys(counts).forEach(function (k) {
        if (k !== 'topics' && k !== 'by_status' && typeof counts[k] === 'number') statusKeys.push(k);
      });
    }
    statusKeys.forEach(function (k) {
      cell(zhTopicLabel(k), byStatus ? byStatus[k] : counts[k]);
    });
    container.appendChild(grid);
    // 漏斗：material_to_topic / topic_to_script（真实结构为数组 [{date,..},..] → 取末位最新值；兼容对象）
    var funnel = d.funnel || d.ratios || null;
    if (funnel && typeof funnel === 'object') {
      var fv = Array.isArray(funnel) ? (funnel[funnel.length - 1] || {}) : funnel;
      if (fv && typeof fv === 'object') {
        var fGrid = el('div', 'gce-tb5__statgrid');
        ['material_to_topic', 'topic_to_script'].forEach(function (k) {
          var v = fv[k];
          if (v == null) return;
          if (v && typeof v === 'object') v = (v.latest != null ? v.latest : v.value);
          var c = el('div', 'gce-tb5__stat');
          c.appendChild(el('span', '', esc(zhTopicLabel(k))));
          c.appendChild(el('b', 'gce-tb5__st-ok', esc(fmtNum(v))));
          fGrid.appendChild(c);
        });
        if (fGrid.children.length) container.appendChild(fGrid);
      }
    }
    if (d.generated_at) container.appendChild(el('div', 'gce-tb5__mock', '更新于 ' + esc(d.generated_at)));
  }

  // 🧩 素材供需：/api/material_supply（MATERIAL_SUPPLY_INDEX.json）
  function renderMaterial(container, d) {
    if (!d || d.error) { panelDegraded(container, (d && d.error) || '无数据'); return; }
    var grid = el('div', 'gce-tb5__statgrid');
    function cell(label, val, cls) {
      var c = el('div', 'gce-tb5__stat');
      c.appendChild(el('span', '', esc(label)));
      c.appendChild(el('b', cls || '', esc(val)));
      grid.appendChild(c);
    }
    // 字段对齐真实端点：total_materials / total_output / consumed_last_7d（保留旧字段兼容）
    var total = d.total_materials != null ? d.total_materials : (d.total != null ? d.total : (d.counts ? d.counts.total : null));
    cell('素材总数', total != null ? total : '-');
    var produced = d.total_output != null ? d.total_output
      : (d.total_produced != null ? d.total_produced
      : (d.stats && d.stats.total_produced != null) ? d.stats.total_produced
      : (d.produced != null ? d.produced : null));
    if (produced != null) cell('总产出量', produced, 'gce-tb5__st-ok');
    var consumed7 = d.consumed_last_7d != null ? d.consumed_last_7d
      : (d.consumed_7d != null ? d.consumed_7d
      : (d.stats && d.stats.consumed_7d != null) ? d.stats.consumed_7d
      : (d.consumption_7d != null ? d.consumption_7d : null));
    if (consumed7 != null) cell('近7天消耗', consumed7);
    container.appendChild(grid);
    // by_status 分布表
    var byStatus = (d.by_status && typeof d.by_status === 'object') ? d.by_status
      : (d.counts && d.counts.by_status && typeof d.counts.by_status === 'object') ? d.counts.by_status : null;
    if (byStatus) {
      var keys = Object.keys(byStatus);
      if (keys.length) {
        var tbl = el('table', 'gce-tb5__table');
        tbl.innerHTML = '<tr><th>状态</th><th>数量</th></tr>';
        keys.slice(0, 10).forEach(function (k) {
          var tr = document.createElement('tr');
          tr.appendChild(el('td', 'gce-tb5__tname', esc(k)));
          tr.appendChild(el('td', '', esc(byStatus[k])));
          tbl.appendChild(tr);
        });
        container.appendChild(tbl);
      }
    }
    if (d.generated_at) container.appendChild(el('div', 'gce-tb5__mock', '更新于 ' + esc(d.generated_at)));
  }

  // 📡 渠道/凭证/采集健康：/api/channel_health（channel_health.json · 顾蛇）
  // 真实结构：{status, source, data:{generated_at, report_date, channels:{name:{7d:{...success_rate},30d:{...}}},
  //   false_positives:{count,by_rule,items}, health_grade:{grade,thresholds,per_channel}}}
  function renderHealthChannel(container, d) {
    if (!d || d.error) { panelDegraded(container, (d && d.error) || '无数据'); return; }
    // 解包：真实端点 data 包裹；无 data 时回退原结构
    var src = (d.data && typeof d.data === 'object') ? d.data : d;
    // health_grade 为对象 → 取 .grade（'ok'/'warn'/'critical'）；字符串直接用
    var hg = src.health_grade;
    var hgVal = hg && typeof hg === 'object' ? hg.grade : hg;
    // false_positives 为对象 → 取 .count
    var fp = (src.false_positives && typeof src.false_positives === 'object') ? src.false_positives.count
      : (src.false_positive_count != null ? src.false_positive_count : src.false_positives);
    if (hgVal != null || fp != null) {
      var g = String(hgVal || '').toLowerCase();
      var gCls = g === 'ok' ? 'gce-tb5__st-ok' : g === 'warn' ? 'gce-tb5__st-wait' : g === 'critical' ? 'gce-tb5__st-err'
        : (/^[ab]/.test(g) ? 'gce-tb5__st-ok' : (/^[cd]/.test(g) ? 'gce-tb5__st-wait' : 'gce-tb5__st-err'));
      var html = hgVal != null ? '健康等级 <b class="' + gCls + '">' + esc(hgVal) + '</b>' : '';
      if (fp != null) html += (html ? ' · ' : '') + '假阳性 <b>' + esc(fp) + '</b>';
      if (html) container.appendChild(el('div', 'gce-tb5__empty', html));
    }
    // 各渠道成功率（近 7/30 天）：真实为对象 {name:{7d,30d}}；兼容数组旧结构
    var chObj = src.channels && typeof src.channels === 'object' && !Array.isArray(src.channels) ? src.channels : null;
    var chArr = Array.isArray(src.channels) ? src.channels : (Array.isArray(src.channel_health) ? src.channel_health : null);
    if (chObj) {
      var keys = Object.keys(chObj);
      if (keys.length) {
        var tbl = el('table', 'gce-tb5__table');
        tbl.innerHTML = '<tr><th>渠道</th><th>7天成功率</th><th>30天成功率</th></tr>';
        keys.slice(0, 12).forEach(function (name) {
          var ch = chObj[name] || {};
          // success_rate 为 0-100 整数；pct() 对 0~1 比例自动放大，对 0-100 原样
          var r7 = pct(ch['7d'] ? ch['7d'].success_rate : ch.success_rate_7d);
          var r30 = pct(ch['30d'] ? ch['30d'].success_rate : ch.success_rate_30d);
          var tr = document.createElement('tr');
          tr.appendChild(el('td', 'gce-tb5__tname', esc(name)));
          tr.appendChild(el('td', '', r7));
          tr.appendChild(el('td', '', r30));
          tbl.appendChild(tr);
        });
        container.appendChild(tbl);
      }
    } else if (chArr && chArr.length) {
      var tbl2 = el('table', 'gce-tb5__table');
      tbl2.innerHTML = '<tr><th>渠道</th><th>7天成功率</th><th>30天成功率</th></tr>';
      chArr.slice(0, 12).forEach(function (ch) {
        if (!ch || typeof ch !== 'object') return;
        var name = ch.name || ch.channel || ch.id || '?';
        var r7 = pct(ch.success_rate_7d != null ? ch.success_rate_7d : (ch.rate_7d != null ? ch.rate_7d : ch.success_7d));
        var r30 = pct(ch.success_rate_30d != null ? ch.success_rate_30d : (ch.rate_30d != null ? ch.rate_30d : ch.success_30d));
        var tr = document.createElement('tr');
        tr.appendChild(el('td', 'gce-tb5__tname', esc(name)));
        tr.appendChild(el('td', '', r7));
        tr.appendChild(el('td', '', r30));
        tbl2.appendChild(tr);
      });
      container.appendChild(tbl2);
    } else if (hgVal == null && fp == null) {
      panelEmpty(container, '结构未识别');
      return;
    }
    if (src.generated_at) container.appendChild(el('div', 'gce-tb5__mock', '更新于 ' + esc(src.generated_at)));
  }

  // ---------- 成果展示区（v6.0 J1）：/api/outputs 今日/本周产出，纯静态 ----------
  function collectOutputFiles(d) {
    var files = [];
    if (!d) return files;
    // 时间戳兜底：发布记录无 mtime_ms，用 day 字符串推导（本地时区，与 todayStart 同源）
    function dayTs(dayStr) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayStr || '');
      if (!m) return 0;
      return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    }
    function pushItem(f, role) {
      files.push({ name: f.title || f.name || '?', path: f.path || '', time: f.time || f.mtime || '', ts: f.mtime_ms || dayTs(f.day) || 0, role: role || f.role || f.owner || '-' });
    }
    if (d.roles && typeof d.roles === 'object') {
      Object.keys(d.roles).forEach(function (rid) {
        var r = d.roles[rid] || {};
        var roleName = (r.role && (r.role.name || r.role.id)) || rid;
        (r.files || []).forEach(function (f) { pushItem(f, roleName); });
      });
    } else if (d.today || d.week || d.categories) {
      // v6 契约对齐：/api/outputs ≡ /api/showcase（今日/本周发布记录 + 域产物），按 path+name 去重
      var seen = {};
      function addGroup(list, role) {
        (list || []).forEach(function (f) {
          var k = (f.path || '') + '|' + (f.title || f.name || '');
          if (seen[k]) return; seen[k] = 1;
          pushItem(f, role);
        });
      }
      addGroup(d.today && d.today.published, '发布');
      addGroup(d.today && d.today.domain_products, '域产物');
      addGroup(d.week && d.week.published, '发布');
      addGroup(d.week && d.week.domain_products, '域产物');
    } else {
      var arr = Array.isArray(d.files) ? d.files : (Array.isArray(d.results) ? d.results : (Array.isArray(d.outputs) ? d.outputs : null));
      (arr || []).forEach(function (f) { pushItem(f, f.role || f.owner || '-'); });
    }
    return files;
  }
  function outputsBadge(d) {
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return collectOutputFiles(d).filter(function (f) { return f.ts >= todayStart; }).length;
  }
  // v6.2 6点P2/P3：成果区运营视角（文件类型 emoji 前缀 + path 悬停 + 今天/昨天时间 + 顶部小结）
  function outputEmoji(f) {
    if (f.role === '发布') return '📣'; // 发布→📣
    var name = String(f.name || '') + '|' + String(f.path || '');
    if (/card|卡片|deep_|knowledge/i.test(name)) return '🖼️'; // 卡片→🖼️
    var m = /\.([a-z0-9]+)$/i.exec(String(f.name || ''));
    var ext = m ? m[1].toLowerCase() : '';
    if (ext === 'py') return '⚙️';   // .py→⚙️
    if (ext === 'mp4') return '🎬';  // .mp4→🎬
    return '📄'; // .md 及默认→📄
  }
  function achTimeText(f) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    var hm = (f.time && String(f.time).length >= 5) ? String(f.time).slice(-5) : '';
    if (!f.ts) return hm ? hm : esc(f.time || '');
    var d = new Date(f.ts);
    if (isNaN(d)) return hm ? hm : esc(f.time || '');
    var now = new Date();
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (same) return '今天 ' + hm;
    var yst = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    var isY = d.getFullYear() === yst.getFullYear() && d.getMonth() === yst.getMonth() && d.getDate() === yst.getDate();
    if (isY) return '昨天 ' + hm;
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm; // 更早：MM-DD HH:MM
  }
  function renderAchievements(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    var files = collectOutputFiles(d);
    if (!files.length) { panelEmpty(container, '暂无产出记录（/api/outputs）'); return; }
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var weekStart = todayStart - 6 * 86400000;
    function sortDesc(a, b) { return (b.ts || 0) - (a.ts || 0); }
    var today = files.filter(function (f) { return f.ts >= todayStart; }).sort(sortDesc);
    var week = files.filter(function (f) { return f.ts >= weekStart && f.ts < todayStart; }).sort(sortDesc);
    // 最近发布 Z：今日发布记录数（优先 sidecar 直算 published_count，回退文件级统计）
    var pubToday = (d.today && d.today.published_count != null) ? d.today.published_count
      : files.filter(function (f) { return f.role === '发布' && f.ts >= todayStart; }).length;
    // 顶部小结行：今日 X 项 · 本周 Y 项 · 最近发布 Z
    container.appendChild(el('div', 'gce-tb5__achsum', '今日 <b>' + today.length + '</b> 项 · 本周 <b>' + week.length + '</b> 项 · 最近发布 <b>' + pubToday + '</b>'));
    function block(title, list) {
      container.appendChild(el('div', 'gce-tb5__achhead', title + ' <span class="gce-tb5__secbadge">' + list.length + '</span>'));
      if (!list.length) { container.appendChild(el('div', 'gce-tb5__empty', '暂无')); return; }
      list.slice(0, 15).forEach(function (f) {
        // 每条两行：L1=emoji+名（去路径）；L2=时间 · 角色 合并一行（运营清单视觉）
        var item = el('div', 'gce-tb5__achitem');
        var tip = f.path || '';
        if (tip) item.title = tip; // path 折叠为悬停 title
        var l1 = el('div', 'gce-tb5__achline', '');
        l1.appendChild(el('span', 'gce-tb5__achemoji', outputEmoji(f)));
        l1.appendChild(el('span', 'gce-tb5__achname', esc(f.name)));
        item.appendChild(l1);
        var metaParts = [achTimeText(f)];
        if (f.role && f.role !== '-') metaParts.push(f.role);
        item.appendChild(el('div', 'gce-tb5__achmeta', metaParts.join(' · ')));
        container.appendChild(item);
      });
      if (list.length > 15) container.appendChild(el('div', 'gce-tb5__trunc', '… 仅显示前 15 条（共 ' + list.length + '）'));
    }
    block('今日', today);
    block('本周', week);
  }

  // ---------- 任务流（v6.0 N2）：/api/taskflow/chain 层级渲染（纯 CSS grid + 左侧竖线，失败高亮） ----------
  function flowStatus(s) {
    if (!s) return 'run';
    var x = String(s).toLowerCase();
    if (/fail|error|err|异常|失败/.test(x)) return 'fail';
    if (/ok|done|成功|正常/.test(x)) return 'ok';
    if (/wait|pend|挂起|disabled|禁用/.test(x)) return 'wait';
    return 'run';
  }
  function flowNode(container, cls, titleHtml, metaHtml) {
    var n = el('div', 'gce-tb5__flownode ' + cls);
    n.appendChild(el('div', '', titleHtml));
    if (metaHtml) n.appendChild(el('div', 'gce-tb5__flowmeta', metaHtml));
    container.appendChild(n);
  }
  function flowBadge(d) {
    if (!d) return '-';
    var list = Array.isArray(d.chains) ? d.chains : (Array.isArray(d.chain) ? d.chain : (Array.isArray(d.tasks) ? d.tasks : []));
    return list.length || '-';
  }
  function renderFlowPanel(container, d) {
    if (!d || d.error) { panelEmpty(container, (d && d.error) || '无数据'); return; }
    var list = Array.isArray(d.chains) ? d.chains : (Array.isArray(d.chain) ? d.chain : (Array.isArray(d.tasks) ? d.tasks : []));
    if (!list.length) { panelEmpty(container, '任务链为空（/api/taskflow/chain）'); return; }
    container.appendChild(el('div', 'gce-tb5__flow'));
    // #5 任务流说明（9问#3-B）：只读链路说明文案
    container.appendChild(el('div', 'gce-tb5__roledim', '任务卡 → 脚本/cron → 最近产出 只读链路，展示任务从调度到产出的完整闭环'));
    list.slice(0, 20).forEach(function (t) {
      var st = flowStatus(t.status);
      var stCls = st === 'fail' ? 'gce-tb5__flownode--fail' : st === 'ok' ? 'gce-tb5__flownode--ok' : st === 'wait' ? 'gce-tb5__flownode--wait' : 'gce-tb5__flownode--run';
      var row = el('div', 'gce-tb5__flowchain');
      var rail = el('div', 'gce-tb5__flowrail');
      rail.appendChild(el('div', 'gce-tb5__flowdot' + (st === 'fail' ? ' gce-tb5__flowdot--fail' : '')));
      rail.appendChild(el('div', 'gce-tb5__flowline'));
      row.appendChild(rail);
      var col = el('div', 'gce-tb5__flowcol');
      // 任务卡
      flowNode(col, stCls,
        '📋 ' + esc(t.task_name || t.name || t.title || t.task_id || '任务') +
        (t.role ? ' <span class="gce-tb5__st-dim">[' + esc(t.role) + ']</span>' : '') +
        ' <span class="' + (st === 'fail' ? 'gce-tb5__st-err' : 'gce-tb5__st-dim') + '">' + esc(t.status || '') + '</span>',
        t.task_id ? 'id: ' + esc(t.task_id) : '');
      // 脚本
      var sc = t.script || t.script_info || (t.scripts && t.scripts[0]);
      if (sc) {
        var scName = typeof sc === 'string' ? sc : (sc.name || sc.script || '脚本');
        var scSt = typeof sc === 'object' ? flowStatus(sc.status) : 'ok';
        flowNode(col, scSt === 'fail' ? 'gce-tb5__flownode--fail' : 'gce-tb5__flownode--ok',
          '⚙️ ' + esc(scName),
          (typeof sc === 'object' && sc.path) ? esc(sc.path) : '');
      }
      // cron
      var cr = t.cron || t.schedule || t.cron_info;
      if (cr) {
        var crExpr = typeof cr === 'string' ? cr : (cr.expr || cr.cron || cr.schedule || 'cron');
        var crSt = typeof cr === 'object' ? flowStatus(cr.status) : 'ok';
        flowNode(col, crSt === 'fail' ? 'gce-tb5__flownode--fail' : 'gce-tb5__flownode--ok',
          '🕐 ' + esc(crExpr),
          (typeof cr === 'object' && (cr.last_run || cr.last_run_at)) ? 'last: ' + esc(cr.last_run || cr.last_run_at) : '');
      }
      // 最近产出（最多 3 条）
      var outs = t.outputs || t.output_files || t.results || t.files || [];
      if (Array.isArray(outs) && outs.length) {
        outs.slice(0, 3).forEach(function (o) {
          var oName = typeof o === 'string' ? o : (o.title || o.name || '产出');
          var oSt = typeof o === 'object' ? flowStatus(o.status) : 'ok';
          flowNode(col, oSt === 'fail' ? 'gce-tb5__flownode--fail' : 'gce-tb5__flownode--ok',
            '📄 ' + esc(oName),
            (typeof o === 'object' && o.path) ? esc(o.path) : '');
        });
        if (outs.length > 3) col.appendChild(el('div', 'gce-tb5__trunc', '… 共 ' + outs.length + ' 条产出'));
      }
      row.appendChild(col);
      container.appendChild(row);
    });
    if (list.length > 20) container.appendChild(el('div', 'gce-tb5__trunc', '… 仅显示前 20 条链（共 ' + list.length + '）'));
  }

  function renderFingerprint() {
    var fp = el('span', 'gce-tb5__fingerprint', '');
    var total = PANELS.length;
    var ok = 0, mock = 0, err = 0, off = 0;
    PANELS.forEach(function (p) {
      var s = STATE.panels[p.key];
      if (!s) { off++; return; }
      if (s.mock) mock++; else if (s.ok) ok++; else err++;
    });
    var mainOk = !!(STATE.data && !STATE.error);
    var online = (mainOk ? 1 : 0) + ok;
    var dots = '';
    dots += '<span class="gce-tb5__fp-dot ' + (mainOk ? 'gce-tb5__fp-dot--ok' : 'gce-tb5__fp-dot--err') + '" title="主看板"></span>';
    PANELS.forEach(function (p) {
      var s = STATE.panels[p.key];
      var cls = !s ? 'gce-tb5__fp-dot--off' : (s.mock ? 'gce-tb5__fp-dot--mock' : s.ok ? 'gce-tb5__fp-dot--ok' : 'gce-tb5__fp-dot--err');
      dots += '<span class="gce-tb5__fp-dot ' + cls + '" title="' + esc(p.title) + '"></span>';
    });
    var now = new Date();
    var upd = now.toLocaleTimeString('zh-CN', { hour12: false });
    fp.innerHTML = '📊 ' + total + '面板 · ' + esc(upd) + ' · 源在线<b>' + online + '</b>/' + (total + 1) + ' ' + dots +
      (mock ? ' <span class="gce-tb5__st-wait">mock×' + mock + '</span>' : '') +
      (off ? ' <span class="gce-tb5__st-dim">待开×' + off + '</span>' : '');
    return fp;
  }

  // ===== 2026-08-23 优化节点周报（内容质量 v2.2 方案A）：渲染 d.summary.opt_nodes_weekly =====
  // 字段对齐后端 _opt_nodes_weekly_summary()：total/by_status/recent_new/in_progress/zombie_nodes/pending_overdue/trend_7d
  var OPTN_STATUS_ORDER = ['pending', 'classified', 'in_progress', 'closed', 'rejected'];
  function renderOptNodeTable(container, list) {
    if (!list || !list.length) { container.appendChild(el('div', 'gce-tb5__empty', '无')); return; }
    var tbl = el('table', 'gce-tb5__table');
    var thead = el('thead'); var hr = el('tr');
    ['节点', '标题', '优先级', '状态'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    thead.appendChild(hr); tbl.appendChild(thead);
    var tb = el('tbody');
    list.slice(0, 10).forEach(function (it) {
      var tr = el('tr');
      tr.appendChild(el('td', '', esc(it.node_id || '-')));
      tr.appendChild(el('td', 'gce-tb5__tname', esc(it.title || '')));
      var pr = String(it.priority == null ? '' : it.priority);
      var prCls = /P0|高|critical/i.test(pr) ? 'gce-tb5__st-err' : (/P1|中|high/i.test(pr) ? 'gce-tb5__st-wait' : (/P2|低|medium/i.test(pr) ? 'gce-tb5__st-dim' : 'gce-tb5__st-dim'));
      tr.appendChild(el('td', prCls, esc(pr || '-')));
      var st = String(it.status || '');
      var stCls = st === 'closed' || st === 'rejected' ? 'gce-tb5__st-ok' : (st === 'in_progress' ? 'gce-tb5__st-run' : (st === 'pending' ? 'gce-tb5__st-wait' : 'gce-tb5__st-dim'));
      tr.appendChild(el('td', stCls, esc(st || '-')));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    container.appendChild(tbl);
    if (list.length > 10) container.appendChild(el('div', 'gce-tb5__trunc', '… 共 ' + list.length + ' 条，仅显示前 10'));
  }
  function renderOptNodes(container, d) {
    if (!d || d.error) {
      container.appendChild(el('div', 'gce-tb5__empty', '节点数据未就绪' + (d && d.error ? '（' + esc(d.error) + '）' : '')));
      return;
    }
    // 标题 + 总数徽标 + 状态计数（非0显示）
    var head = el('div', 'gce-tb5__optsec');
    head.appendChild(el('span', '', '🔧 优化节点'));
    head.appendChild(el('span', 'gce-tb5__secbadge', '共 ' + (d.total != null ? d.total : 0)));
    var by = d.by_status || {};
    OPTN_STATUS_ORDER.forEach(function (k) {
      if (by[k]) head.appendChild(el('span', 'gce-tb5__secbadge', esc(k) + ' ' + by[k]));
    });
    container.appendChild(head);
    // 本周新增（最多 10 条）
    container.appendChild(el('div', 'gce-tb5__optsec', '🆕 本周新增'));
    renderOptNodeTable(container, d.recent_new);
    // 进行中
    container.appendChild(el('div', 'gce-tb5__optsec', '▶ 进行中'));
    renderOptNodeTable(container, d.in_progress);
    // ⚠️ 僵尸节点（红色）+ pending 超期待复核（橙色）
    container.appendChild(el('div', 'gce-tb5__optsec', '⚠ 待复核'));
    var z = d.zombie_nodes || [];
    var po = d.pending_overdue || [];
    if (!z.length && !po.length) {
      container.appendChild(el('div', 'gce-tb5__empty', '无'));
    } else {
      if (z.length) {
        container.appendChild(el('div', 'gce-tb5__optwarn', '<span class="gce-tb5__st-err">僵尸节点 ×' + z.length + '</span>：' +
          z.slice(0, 8).map(function (n) { return esc(n.node_id || n.title || '-'); }).join('、')));
      }
      if (po.length) {
        container.appendChild(el('div', 'gce-tb5__optwarn', '<span class="gce-tb5__st-wait">pending 超期 ×' + po.length + '</span>：' +
          po.slice(0, 8).map(function (n) { return esc(n.node_id || n.title || '-'); }).join('、')));
      }
    }
    // 7 日趋势（文本样式，无图表库）
    var t = d.trend_7d || [];
    container.appendChild(el('div', 'gce-tb5__optsec', '📈 7日趋势'));
    if (!t.length) {
      container.appendChild(el('div', 'gce-tb5__empty', '无'));
    } else {
      var chips = el('div', 'gce-tb5__optchips');
      t.forEach(function (x) {
        var dd = String(x.day || '').slice(5);
        chips.appendChild(el('span', 'gce-tb5__tag', esc(dd) + ' <span class="gce-tb5__st-ok">+' + (x.new || 0) + '</span>/<span class="gce-tb5__st-dim">-' + (x.closed || 0) + '</span>'));
      });
      container.appendChild(chips);
    }
    // 数据源
    if (d.source) container.appendChild(el('div', 'gce-tb5__trunc', '源：' + esc(d.source)));
  }

  function renderSection(container, key, title, badge, q, renderFn, live, forceOpen) {
    var sec = el('div', 'gce-tb5__section');
    var head = el('div', 'gce-tb5__sechead');
    var collapsed = forceOpen ? false : STATE.collapsedSections[key];
    head.appendChild(el('span', '', collapsed ? '▸' : '▾'));
    head.appendChild(document.createTextNode(title));
    head.appendChild(el('span', 'gce-tb5__secbadge', String(badge)));
    if (live) head.appendChild(el('span', 'gce-tb5__seclabel', '[梯队分组]'));
    else head.appendChild(el('span', 'gce-tb5__seclabel', '[静态]'));
    head.onclick = function () { toggleSection(key); };
    sec.appendChild(head);
    if (!collapsed) {
      // v5.5：每队列一个滚动容器（全部显示，超高时出现垂直滚动条）
      var body = el('div', 'gce-tb5__qbody gce-tb5__qbody--' + (key === 'live' ? 'live' : key === 'pending' ? 'pending' : 'auto'));
      body.style.maxHeight = key === 'live' ? '320px' : QUEUE_MAXH;
      body.style.overflowY = 'auto';
      renderFn(body, q);
      sec.appendChild(body);
    }
    container.appendChild(sec);
  }

  function renderRefreshBtn() {
    var btn = el('span', 'gce-tb5__refresh', '');
    btn.title = '手动刷新全部数据（取消自动实时刷新）';
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>' +
      '<span>刷新</span>';
    btn.onclick = function (ev) {
      ev.stopPropagation();
      manualRefresh(btn);
    };
    return btn;
  }

  function render() {
    var root = document.getElementById('gce-tb5-root');
    if (!root) return;
    root.innerHTML = '';

    var d = STATE.data;
    var ok = !!(d && !STATE.error);

    // 头部（整板折叠）——标题带版本号
    var head = el('div', 'gce-tb5__head');
    head.appendChild(el('span', 'gce-tb5__dot ' + (ok ? 'gce-tb5__dot--ok' : (STATE.error ? 'gce-tb5__dot--err' : 'gce-tb5__dot--off'))));
    head.appendChild(el('span', 'gce-tb5__title', '📋 任务看板<span class="gce-tb5__ver">' + VERSION + '</span>'));
    if (d && d.summary) {
      var counts = el('span', 'gce-tb5__counts', '');
      var cd = d.summary.cost_daily || {};
      counts.innerHTML = '自动 <b>' + (d.summary.auto_tasks || 0) + '</b> · 实时 <b>' + (d.summary.live_tasks || 0) + '</b> · 挂起 <b>' + (d.summary.pending_tasks || 0) + '</b>' + (d.summary.task_meta_rate != null ? ' · 登记 <b>' + d.summary.task_meta_rate + '</b>' : '') + (cd.cost != null ? ' · 成本 <b>￥' + Number(cd.cost).toFixed(2) + '</b>' : '');
      head.appendChild(counts);
    }
    var meta = el('span', 'gce-tb5__meta', '');
    var mountLabel = STATE.mount === 'rail' ? ('右侧栏' + (STATE.mountDetail ? '(' + STATE.mountDetail + ')' : ''))
      : (STATE.mount === 'input' ? '输入框' : (STATE.mount === 'float' ? '浮动' : '?'));
    if (d && d.summary) meta.textContent = mountLabel + ' · ' + fmtTime(d.summary.last_generated || d.generated_at) + ' · ' + relTime(STATE.lastOk);
    else meta.textContent = mountLabel + ' · 未连接';
    head.appendChild(meta);
    // 📊 数据指纹（v5.6 端点面板 #4）
    head.appendChild(renderFingerprint());
    // 手动刷新按钮（v5.4）
    head.appendChild(renderRefreshBtn());
    head.appendChild(el('span', 'gce-tb5__caret', STATE.collapsed ? '▲ 展开' : '▼ 收起'));
    head.onclick = toggleCollapsed;
    root.appendChild(head);

    if (!d || STATE.error) {
      root.appendChild(el('div', 'gce-tb5__err', '⚠ ' + esc(STATE.error || '无数据') + '（sidecar: ' + API_URL + '）'));
      return;
    }

    // 折叠态：只显示头部
    if (STATE.collapsed) return;

    var s = d.summary || {};
    var body = el('div', 'gce-tb5__body');

    // ===== v6.0 成果展示区（顶部，全视图可见）：/api/outputs 今日/本周产出，纯静态 =====
    var outSt = STATE.panels['outputs'];
    if (outSt) {
      var outWrap = el('div', 'gce-tb5__qbody gce-tb5__pbody gce-tb5__pbody--outputs');
      renderSection(outWrap, 'panel-outputs', '🏆 成果展示区（今日 / 本周）', outputsBadge(outSt.data), outSt.data, renderAchievements, false);
      if (outSt.mock) outWrap.appendChild(el('div', 'gce-tb5__mock', 'mock 数据（端点 /api/outputs 未就绪，' + esc(outSt.error || '') + '）'));
      body.appendChild(outWrap);
    }

    // ===== 2026-08-23 优化节点周报（内容质量 v2.2 方案A）：summary.opt_nodes_weekly，折叠式 =====
    var optData = s.opt_nodes_weekly;
    var optSec = el('div', 'gce-tb5__section gce-tb5__optnodes');
    var optCollapsed = !!STATE.collapsedSections['opt_nodes']; // 默认展开（undefined → 展开）
    var optHead = el('div', 'gce-tb5__sechead');
    optHead.appendChild(el('span', '', optCollapsed ? '▸' : '▾'));
    var optTitleHtml = '🔧 优化节点';
    if (optData && !optData.error) {
      var optTotal = optData.total != null ? optData.total : 0;
      var optWarn = (optData.zombie_nodes || []).length + (optData.pending_overdue || []).length;
      optTitleHtml += ' <span class="gce-tb5__secbadge">共 ' + optTotal + '</span>';
      if (optWarn) optTitleHtml += ' <span class="gce-tb5__st-err">⚠ 待复核' + optWarn + '</span>';
    }
    optHead.appendChild(el('span', '', optTitleHtml));
    optHead.appendChild(el('span', 'gce-tb5__seclabel', optData && optData.error ? '[未就绪]' : '[周报]'));
    optHead.onclick = function () { toggleSection('opt_nodes'); };
    optSec.appendChild(optHead);
    if (!optCollapsed) {
      var optBody = el('div', 'gce-tb5__qbody gce-tb5__pbody');
      renderOptNodes(optBody, optData);
      optSec.appendChild(optBody);
    }
    body.appendChild(optSec);

    // ===== v6.0 三台拆分 + 任务流 tab（registry/kb_stats 已从主视图移除，仅知识资产台按需打开） =====
    body.appendChild(renderViewTabs());

    if (STATE.view === 'flow') renderFlowView(body);
    else if (STATE.view === 'health') renderHealthView(body);
    else if (STATE.view === 'knowledge') renderKnowledgeView(body);
    else renderOpsView(body, d);

    root.appendChild(body);
  }

  // ---------- 挂载点计算（v5.3.2 稳定优先，v5.4 保留） ----------
  function tryExpandRail(rail) {
    // 已禁用自动点击（v5.3.2）：避免点击非展开按钮引发 UI 抖动
    return false;
  }

  // 右缘贴边面板几何探测（跨版本兜底，未来 app-shell 也可用）
  function findRightPanel() {
    var cands = [];
    try {
      cands = Array.prototype.slice.call(document.querySelectorAll(
        'aside,[class*="rail"],[class*="sidebar"],[class*="panel"],[class*="pane"],[class*="dock"]'
      ));
    } catch (e) { return null; }
    var best = null, bestScore = 0;
    cands.forEach(function (e) {
      if (!(e instanceof HTMLElement)) return;
      var cls = typeof e.className === 'string' ? e.className : '';
      if (/detail|preview|transient|dropdown|menu|popover|tooltip/i.test(cls)) return;
      var p = e;
      while (p) {
        if (p.classList && p.classList.contains && p.classList.contains('chat-workspace-rail--collapsed')) return;
        p = p.parentElement;
      }
      var r = e.getBoundingClientRect();
      if (r.width < 60 || r.height < 120) return;
      if (r.top >= 250) return;
      var rightGap = window.innerWidth - r.right;
      if (rightGap > 40) return;
      var score = (40 - rightGap) * 2 + (cls.length) + (250 - r.top) / 10;
      if (score > bestScore) { bestScore = score; best = e; }
    });
    return best;
  }

  // 计算当前最优挂载目标（含手动覆盖模式）
  function computeMountTarget() {
    var mode = getModeOverride();

    if (mode === 'float') {
      return { kind: 'float', node: document.body, detail: 'manual' };
    }
    if (mode === 'input') {
      var inp = document.querySelector('.agent-chat__input') || document.querySelector('.agent-chat__composer-shell');
      if (inp) return { kind: 'input', node: inp, detail: 'manual' };
      return null;
    }
    if (mode === 'rail') {
      var rOnly = document.querySelector('.chat-workspace-rail');
      if (rOnly) return railTarget(rOnly);
      return null;
    }

    // auto 模式
    var rail = document.querySelector('.chat-workspace-rail');
    if (rail) {
      var rt = railTarget(rail);
      if (rt) return rt;
    }
    var geom = findRightPanel();
    if (geom) return { kind: 'rail', node: geom, detail: 'geom' };
    var input = document.querySelector('.agent-chat__input') || document.querySelector('.agent-chat__composer-shell');
    if (input) return { kind: 'input', node: input, detail: '' };
    return { kind: 'float', node: document.body, detail: 'fallback' };
  }

  function railTarget(rail) {
    var collapsed = rail.classList && rail.classList.contains('chat-workspace-rail--collapsed');
    if (collapsed) {
      return null;
    }
    var scroll = rail.querySelector('.chat-workspace-rail__scroll');
    if (scroll) return { kind: 'rail', node: scroll, detail: 'scroll' };
    return { kind: 'rail', node: rail, detail: 'aside' };
  }

  // 注入到指定目标（迁移时重建）
  function injectTo(target) {
    var existing = document.getElementById('gce-tb5-root');
    if (existing) existing.remove();

    var root = el('div', 'gce-tb5' +
      (target.kind === 'rail' ? ' gce-tb5--rail' : '') +
      (target.kind === 'float' ? ' gce-tb5--float' : ''));
    root.id = 'gce-tb5-root';
    root.title = 'Control UI 任务看板 ' + VERSION + ' · 三队列 · 手动刷新 · 进度零 token';

    if (target.kind === 'rail') {
      var wrapper = el('section', 'chat-workspace-rail__section');
      wrapper.appendChild(root);
      target.node.insertBefore(wrapper, target.node.firstChild);
    } else if (target.kind === 'float') {
      target.node.appendChild(root);
    } else {
      target.node.insertBefore(root, target.node.firstChild);
    }
    if (target.node && target.node.style) target.node.style.display = '';

    STATE.injected = true;
    STATE.mount = target.kind;
    STATE.mountDetail = target.detail || '';
  }

  // ---------- 周期重评（保留 v5.3 挂载点逻辑） ----------
  function evaluateMount() {
    var target = computeMountTarget();
    var root = document.getElementById('gce-tb5-root');

    var desired = target ? target.kind + '|' + (target.detail || '') : 'none';
    if (STATE.lastDesired !== desired) {
      STATE.lastDesired = desired;
      STATE.desiredStreak = 1;
    } else {
      STATE.desiredStreak++;
    }

    if (!root) {
      if (target && STATE.desiredStreak >= 2) {
        injectTo(target);
        if (STATE.data === null) fetchData(render); else render();
      }
      return;
    }

    if (target && STATE.desiredStreak >= 2) {
      var targetKind = target.kind;
      var targetDetail = target.detail || '';
      if (STATE.mount !== targetKind || STATE.mountDetail !== targetDetail) {
        var downgrade = (STATE.mount === 'rail') && (targetKind !== 'rail');
        var upgrade = (STATE.mount !== 'rail') && (targetKind === 'rail');
        var now = Date.now();
        if (downgrade) {
          injectTo(target);
          render();
          STATE.lastRailMigrateAt = now;
        } else if (upgrade) {
          var firstTime = STATE.lastRailMigrateAt === 0;
          var cooled = (now - (STATE.lastRailMigrateAt || 0)) > 60000;
          if (STATE.desiredStreak >= 4 && (firstTime || cooled)) {
            injectTo(target);
            render();
            STATE.lastRailMigrateAt = now;
          }
        } else {
          injectTo(target);
          render();
        }
      }
    }
  }

  // ---------- 启动 ----------
  function start() {
    loadPrefs();
    // v5.4：无任何自动数据轮询（取消实时刷新机制）——只保留挂载点周期重评（UI 挂载无关数据）
    if (!STATE.mountTimer) {
      STATE.mountTimer = setInterval(evaluateMount, MOUNT_TICK_MS);
    }
    // 立即首评 + 首次加载数据
    evaluateMount();
    fetchData(render);
  }

  start();
})();
