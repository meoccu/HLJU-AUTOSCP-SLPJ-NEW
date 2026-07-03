// ==UserScript==
// @name         黑龙江大学自动评教助手
// @namespace    https://zlpj.hlju.edu.cn/
// @version      3.0.0
// @description  基于真实路由重写：自动进入问卷、判断题选"是"、量表题选满分、主观题填评语、自动提交、循环遍历全部待评课程。支持手动核验/全自动双模式。
// @author       WorkBuddy
// @match        *://zlpj.hlju.edu.cn/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   *  防重复注入：若已加载则直接退出
   * ========================================================================= */
  if (window.__HLJU_AUTO_EVAL__) {
    console.log('[自动评教] 脚本已加载，跳过重复注入');
    return;
  }
  window.__HLJU_AUTO_EVAL__ = true;

  /* =========================================================================
   *  配置
   * ========================================================================= */
  const CONFIG = {
    fillDelay: 800,
    submitDelay: 1000,
    pollInterval: 1500,
    // 评分档位：'5'=满分(选项第0个)，'4'=良好(第1个)
    scoreLevel: '5',
    // 两道主观题评语
    commentBest:
      '老师讲课条理清晰，知识点讲解通俗易懂，课堂节奏把控到位，课后答疑耐心细致，教学态度认真负责，收获非常大。',
    commentImprove:
      '建议可以多补充一些典型例题，拓宽习题讲解范围，进一步丰富线上教学资源，增加课堂互动环节。',
    // 单题默认填字（非两道主观题的兜底文本框）
    defaultText: '很好',
    // 'manual'(填完暂停等用户核验提交) | 'auto'(全自动)
    mode: 'manual',
  };

  /* =========================================================================
   *  运行状态
   * ========================================================================= */
  const STATE = {
    running: false,
    totalCount: 0,
    doneCount: 0,
    loopActive: false,
    // 当前问卷的主观题填写索引（用于区分两段评语）
    textIndex: 0,
  };

  const LOG = '[自动评教]';
  function log(...a) { console.log(LOG, ...a); }

  function toast(msg, dur) {
    dur = dur || 2000;
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;top:24px;left:50%;transform:translateX(-50%);' +
      'background:linear-gradient(135deg,#1e293b,#0f172a);color:#fff;padding:12px 26px;border-radius:12px;' +
      'z-index:2147483647;font-size:14px;white-space:nowrap;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;' +
      'box-shadow:0 8px 32px rgba(15,23,42,.3),0 2px 8px rgba(15,23,42,.15);' +
      'border:1px solid rgba(255,255,255,.1);letter-spacing:.3px;' +
      'opacity:0;transition:opacity .3s,transform .3s;';
    document.body.appendChild(el);
    requestAnimationFrame(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(-10px)';
      setTimeout(function () { el.remove(); }, 300);
    }, dur);
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* =========================================================================
   *  路由检测 —— 基于真实 hash
   *    /survery/children/surverySubmit/  → 问卷页
   *    /survery                          → 列表页
   * ========================================================================= */
  function detectPage() {
    const h = window.location.hash;
    if (h.includes('/survery/children/surverySubmit/')) return 'survey';
    if (h.includes('/survery')) return 'list';
    return 'other';
  }

  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function triggerVueInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /* =========================================================================
   *  弹窗自动确认（vux weui-dialog / sweetalert2）
   * ========================================================================= */
  function startDialogWatcher() {
    const observer = new MutationObserver(() => {
      if (!STATE.running) return;

      // vux confirm —— 自动点"确定"
      const confirmBtns = document.querySelectorAll('.weui-dialog__btn_primary');
      for (const btn of confirmBtns) {
        if (isVisible(btn) && btn.textContent.includes('确定')) {
          log('自动确认弹窗');
          btn.click();
        }
      }

      // vux alert —— 自动关闭
      const alertBtns = document.querySelectorAll('.vux-alert .weui-dialog__btn_primary');
      for (const btn of alertBtns) {
        if (isVisible(btn)) {
          log('自动关闭提示弹窗');
          btn.click();
        }
      }

      // sweetalert2
      const swalConfirm = document.querySelector('.swal2-confirm');
      if (swalConfirm && isVisible(swalConfirm)) {
        log('自动确认 swal 弹窗');
        swalConfirm.click();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  /* =========================================================================
   *  列表页：获取待评教条目
   *    结构：.survery .item.bottom 中，含 .icon-defen 表示已评
   * ========================================================================= */
  function getFirstPendingItem() {
    const items = document.querySelectorAll('.survery .item.bottom');
    for (const item of items) {
      if (!item.querySelector('.icon-defen')) {
        return item;
      }
    }
    return null;
  }

  function countPendingItems() {
    let count = 0;
    const items = document.querySelectorAll('.survery .item.bottom');
    for (const item of items) {
      if (!item.querySelector('.icon-defen')) count++;
    }
    return count;
  }

  function getItemTitle(item) {
    if (!item) return '未知问卷';
    const titleEl = item.querySelector('.title');
    return titleEl ? titleEl.textContent.trim() : '未知问卷';
  }

  /* =========================================================================
   *  列表页：处理循环
   * ========================================================================= */
  async function processListLoop() {
    if (STATE.loopActive) return;
    STATE.loopActive = true;

    try {
      while (STATE.running) {
        await delay(CONFIG.pollInterval);

        if (detectPage() !== 'list') { STATE.loopActive = false; return; }

        const pendingCount = countPendingItems();
        if (pendingCount === 0) {
          log('所有问卷已完成！');
          toast('全部评教问卷已完成 🎉', 3000);
          STATE.running = false;
          setStatus('已完成', '#10b981');
          STATE.loopActive = false;
          return;
        }

        if (STATE.totalCount === 0) {
          STATE.totalCount = pendingCount;
          STATE.doneCount = 0;
          log('找到 ' + pendingCount + ' 个待完成问卷');
          toast('找到 ' + pendingCount + ' 个待评问卷，开始自动评教...', 2500);
        }

        updateProgress();

        const item = getFirstPendingItem();
        if (!item) continue;

        log('处理: ' + getItemTitle(item));
        setStatus('进入: ' + getItemTitle(item), '#7cba23');

        // 重置主观题索引
        STATE.textIndex = 0;

        item.click();

        // 等待离开列表页
        let retry = 0;
        while (detectPage() === 'list' && retry < 20) {
          await delay(500);
          retry++;
        }

        if (detectPage() === 'survey') {
          await handleSurveyPage();
        }

        // 等待返回列表页
        if (CONFIG.mode === 'manual') {
          setStatus('等待核验提交...', '#f59e0b');
        }
        retry = 0;
        while (STATE.running && retry < 300) {
          await delay(1000);
          retry++;
          if (detectPage() === 'list') {
            const first = getFirstPendingItem();
            if (first || countPendingItems() === 0) {
              await delay(1500);
              break;
            }
          }
        }

        if (!STATE.running) { STATE.loopActive = false; return; }
        setStatus('运行中...', '#7cba23');
        await delay(1500);
      }
    } finally {
      STATE.loopActive = false;
    }
  }

  /* =========================================================================
   *  问卷页处理
   * ========================================================================= */
  async function handleSurveyPage() {
    log('问卷页：等待加载...');
    await delay(CONFIG.fillDelay);

    for (let attempt = 0; attempt < 10; attempt++) {
      if (await tryFillAndSubmit()) break;
      await delay(1000);
    }
  }

  async function tryFillAndSubmit() {
    const filled = await fillAllQuestions();
    if (!filled) return false;

    log('填写完成，准备提交...');

    if (CONFIG.mode === 'manual') {
      toast('填写完成，请核验后手动提交', 3000);
      setStatus('等待核验提交...', '#f59e0b');
      return true;
    }

    await delay(CONFIG.submitDelay);

    // 查找提交按钮
    const allBtns = document.querySelectorAll(
      'button, a.weui-btn, .x-button, [role="button"], .submitbtn'
    );
    for (const btn of allBtns) {
      if (!isVisible(btn)) continue;
      const txt = (btn.textContent || '').trim();
      if (txt === '提交' || txt === '暂存' || txt === '保存') {
        log('点击提交按钮:', txt);
        btn.click();
        STATE.doneCount++;
        updateProgress();
        return true;
      }
    }

    log('未找到提交按钮');
    return false;
  }

  async function fillAllQuestions() {
    try {
      // 每个问卷重置主观题索引
      STATE.textIndex = 0;
      fillRadios();
      fillSelects();
      fillTextFields();
      fillSortInputs();
      fillCheckboxes();
      await delay(200);
      return true;
    } catch (e) {
      log('填写出错:', e);
      return false;
    }
  }

  /* =========================================================================
   *  选项选择策略：
   *    2 选项 → 0（判断题"是"）
   *    5 选项 → scoreLevel 对应索引（'5'→0, '4'→1）
   *    其他   → 0（最优）
   *    假设选项降序排列：5,4,3,2,1（符合黑大评教"满分在前"）
   * ========================================================================= */
  function pickOptionIndex(count) {
    if (count === 2) return 0; // 判断题：选"是"
    if (count === 5) {
      // 量表题：5分→index0，4分→index1
      return CONFIG.scoreLevel === '4' ? 1 : 0;
    }
    return 0; // 其他：选最优（第一个）
  }

  function fillRadios() {
    const groups = new Map();
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const r of radios) {
      const name = r.getAttribute('name');
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    }

    for (const [, group] of groups) {
      if (group.some((r) => r.checked)) continue;
      const idx = pickOptionIndex(group.length);
      group[idx].click();
    }
  }

  function fillSelects() {
    const selects = document.querySelectorAll('select');
    for (const sel of selects) {
      const count = sel.options.length;
      if (count > 1) {
        sel.selectedIndex = pickOptionIndex(count);
        triggerVueInput(sel);
      }
    }
  }

  // 填写文本框与文本域：
  //   textarea 按顺序对应两道主观题评语（满意/改进）
  //   其他 input 填默认文本
  function fillTextFields() {
    const inputs = document.querySelectorAll(
      'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"])'
    );
    for (const inp of inputs) {
      if (inp.readOnly) continue;
      if (inp.classList.contains('matrix_sort') || inp.classList.contains('sortnum')) continue;
      if (!inp.value || inp.value.trim() === '') {
        inp.value = CONFIG.defaultText;
        triggerVueInput(inp);
      }
    }

    // textarea：按顺序填两段评语
    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (ta.value && ta.value.trim() !== '') continue; // 已有内容跳过
      let text;
      if (STATE.textIndex === 0) {
        text = CONFIG.commentBest;
      } else if (STATE.textIndex === 1) {
        text = CONFIG.commentImprove;
      } else {
        // 超出两道的兜底：循环使用满意评语
        text = CONFIG.commentBest;
      }
      STATE.textIndex++;
      ta.value = text;
      triggerVueInput(ta);
    }
  }

  function fillSortInputs() {
    const sortInputs = document.querySelectorAll('.matrix_sort, .sortnum');
    for (let i = 0; i < sortInputs.length; i++) {
      if (!sortInputs[i].value || sortInputs[i].value === '') {
        sortInputs[i].value = String(i + 1);
        sortInputs[i].classList.add('sortnum-sel');
        triggerVueInput(sortInputs[i]);
      }
    }
  }

  function fillCheckboxes() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
    for (const cb of checkboxes) {
      if ((cb.id || '').startsWith('ae-')) continue;
      cb.click();
    }
  }

  function updateProgress() {
    const wrap = document.getElementById('ae-progress-wrap');
    const doneEl = document.getElementById('ae-done');
    const totalEl = document.getElementById('ae-total');
    const fill = document.getElementById('ae-progress-fill');
    if (wrap) wrap.classList.add('show');
    if (doneEl) doneEl.textContent = STATE.doneCount;
    if (totalEl) totalEl.textContent = STATE.totalCount;
    if (fill && STATE.totalCount > 0) {
      const pct = Math.round((STATE.doneCount / STATE.totalCount) * 100);
      fill.style.width = pct + '%';
    }
  }

  /* =========================================================================
   *  控制面板 —— 现代玻璃拟态 UI
   * ========================================================================= */
  function createPanel() {
    // 若已存在则移除（防重复）
    const old = document.getElementById('auto-eval-panel');
    if (old) old.remove();

    // 注入样式（仅一次）
    if (!document.getElementById('ae-panel-style')) {
      const sty = document.createElement('style');
      sty.id = 'ae-panel-style';
      sty.textContent =
        '@import url("https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap");' +
        '#auto-eval-panel{position:fixed;top:16px;right:16px;z-index:2147483646;' +
        'width:290px;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;font-size:13px;' +
        'background:rgba(255,255,255,0.92);backdrop-filter:blur(16px) saturate(1.6);' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.6);' +
        'border-radius:16px;border:1px solid rgba(255,255,255,.6);' +
        'box-shadow:0 8px 32px rgba(15,23,42,.12),0 2px 8px rgba(15,23,42,.06);' +
        'overflow:hidden;user-select:none;' +
        'transition:opacity .3s,transform .3s;}' +
        '#auto-eval-panel:hover{box-shadow:0 12px 40px rgba(15,23,42,.16),0 4px 12px rgba(15,23,42,.08);}' +
        '#auto-eval-panel *{box-sizing:border-box;}' +
        // 头部
        '#auto-eval-panel .ae-header{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#06b6d4 100%);' +
        'padding:16px 18px;display:flex;justify-content:space-between;align-items:center;position:relative;overflow:hidden;}' +
        '#auto-eval-panel .ae-header::before{content:"";position:absolute;inset:0;' +
        'background:linear-gradient(135deg,rgba(255,255,255,.15) 0%,transparent 50%);pointer-events:none;}' +
        '#auto-eval-panel .ae-header-left{display:flex;align-items:center;gap:10px;position:relative;z-index:1;}' +
        '#auto-eval-panel .ae-logo{width:34px;height:34px;border-radius:9px;background:rgba(255,255,255,.22);' +
        'display:grid;place-items:center;font-size:18px;backdrop-filter:blur(4px);}' +
        '#auto-eval-panel .ae-title{color:#fff;font-size:15px;font-weight:700;letter-spacing:.3px;line-height:1.3;}' +
        '#auto-eval-panel .ae-title span{display:block;font-size:10px;font-weight:400;opacity:.8;margin-top:1px;}' +
        '#auto-eval-panel .ae-close{cursor:pointer;font-size:22px;color:rgba(255,255,255,.7);' +
        'line-height:1;padding:4px;border-radius:6px;transition:.2s;position:relative;z-index:1;}' +
        '#auto-eval-panel .ae-close:hover{color:#fff;background:rgba(255,255,255,.18);}' +
        // 主体
        '#auto-eval-panel .ae-body{padding:16px 18px;}' +
        // 状态条
        '#auto-eval-panel .ae-status-bar{display:flex;align-items:center;gap:8px;padding:9px 12px;' +
        'background:linear-gradient(135deg,#f1f5f9,#e2e8f0);border-radius:10px;margin-bottom:14px;}' +
        '#auto-eval-panel .ae-status-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex-shrink:0;' +
        'transition:.3s;}' +
        '#auto-eval-panel .ae-status-dot.running{background:#10b981;animation:ae-blink 1.4s infinite;}' +
        '#auto-eval-panel .ae-status-dot.done{background:#6366f1;}' +
        '#auto-eval-panel .ae-status-dot.error{background:#ef4444;}' +
        '#auto-eval-panel .ae-status-dot.paused{background:#f59e0b;}' +
        '#auto-eval-panel .ae-status-text{font-size:12px;color:#475569;font-weight:500;}' +
        '@keyframes ae-blink{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(16,185,129,.4)}50%{opacity:.6;box-shadow:0 0 0 6px rgba(16,185,129,0)}}' +
        // 进度条
        '#auto-eval-panel .ae-progress-wrap{margin-bottom:14px;display:none;}' +
        '#auto-eval-panel .ae-progress-wrap.show{display:block;}' +
        '#auto-eval-panel .ae-progress-info{display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:5px;}' +
        '#auto-eval-panel .ae-progress-info b{color:#6366f1;font-size:12px;}' +
        '#auto-eval-panel .ae-progress-bar{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;}' +
        '#auto-eval-panel .ae-progress-fill{height:100%;border-radius:3px;' +
        'background:linear-gradient(90deg,#6366f1,#8b5cf6,#06b6d4);' +
        'transition:width .5s ease;width:0%;}' +
        // 行
        '#auto-eval-panel .ae-row{margin-bottom:12px;}' +
        '#auto-eval-panel .ae-label{display:block;font-size:11px;font-weight:600;color:#64748b;' +
        'margin-bottom:6px;letter-spacing:.3px;}' +
        // 分段按钮
        '#auto-eval-panel .ae-seg{display:flex;gap:6px;background:#f1f5f9;padding:3px;border-radius:9px;}' +
        '#auto-eval-panel .ae-seg button{flex:1;padding:7px 0;border:none;background:transparent;' +
        'border-radius:7px;cursor:pointer;font-size:12px;font-weight:500;color:#64748b;transition:.2s;font-family:inherit;}' +
        '#auto-eval-panel .ae-seg button:hover:not(.active){background:rgba(255,255,255,.6);color:#475569;}' +
        '#auto-eval-panel .ae-seg button.active{background:#fff;color:#6366f1;font-weight:600;' +
        'box-shadow:0 2px 8px rgba(99,102,241,.2);}' +
        // 主按钮组
        '#auto-eval-panel .ae-btns{display:flex;gap:8px;margin-bottom:12px;}' +
        '#auto-eval-panel .ae-btn{flex:1;padding:10px;border:none;border-radius:10px;cursor:pointer;' +
        'font-size:13px;font-weight:600;font-family:inherit;transition:.2s;display:flex;align-items:center;justify-content:center;gap:5px;}' +
        '#auto-eval-panel .ae-btn:active{transform:scale(.96);}' +
        '#auto-eval-panel .ae-btn-start{background:linear-gradient(135deg,#10b981,#059669);color:#fff;' +
        'box-shadow:0 4px 14px rgba(16,185,129,.3);}' +
        '#auto-eval-panel .ae-btn-start:hover{box-shadow:0 6px 20px rgba(16,185,129,.45);transform:translateY(-1px);}' +
        '#auto-eval-panel .ae-btn-stop{flex:0 0 auto;padding:10px 16px;background:#f1f5f9;color:#64748b;' +
        'border:1px solid #e2e8f0;}' +
        '#auto-eval-panel .ae-btn-stop:hover{background:#fee2e2;color:#ef4444;border-color:#fecaca;}' +
        // 开关行
        '#auto-eval-panel .ae-switch-row{display:flex;align-items:center;justify-content:space-between;' +
        'padding:10px 12px;background:#f8fafc;border-radius:9px;margin-bottom:12px;cursor:pointer;transition:.2s;}' +
        '#auto-eval-panel .ae-switch-row:hover{background:#f1f5f9;}' +
        '#auto-eval-panel .ae-switch-row .ae-switch-label{font-size:12px;color:#475569;font-weight:500;}' +
        '#auto-eval-panel .ae-switch-row .ae-switch-label span{display:block;font-size:10px;color:#94a3b8;margin-top:1px;}' +
        // 方块亮灭指示器
        '#auto-eval-panel .ae-toggle{width:42px;height:24px;border-radius:7px;flex-shrink:0;cursor:pointer;' +
        'background:#e2e8f0;border:1px solid #cbd5e1;transition:.25s;position:relative;}' +
        '#auto-eval-panel .ae-toggle::after{content:"";position:absolute;width:10px;height:10px;' +
        'border-radius:50%;background:#94a3b8;top:50%;left:50%;transform:translate(-50%,-50%);transition:.25s;}' +
        '#auto-eval-panel .ae-toggle.on{background:linear-gradient(135deg,#10b981,#059669);' +
        'border-color:#059669;box-shadow:0 2px 10px rgba(16,185,129,.35);}' +
        '#auto-eval-panel .ae-toggle.on::after{background:#fff;box-shadow:0 0 6px rgba(255,255,255,.6);}' +
        // 折叠区
        '#auto-eval-panel .ae-adv-toggle{display:flex;align-items:center;gap:5px;font-size:12px;' +
        'color:#6366f1;cursor:pointer;font-weight:500;padding:6px 0;transition:.2s;}' +
        '#auto-eval-panel .ae-adv-toggle:hover{color:#4f46e5;}' +
        '#auto-eval-panel .ae-adv-toggle .ae-arrow{transition:.3s;display:inline-block;}' +
        '#auto-eval-panel .ae-adv-toggle.open .ae-arrow{transform:rotate(180deg);}' +
        '#auto-eval-panel .ae-adv{max-height:0;overflow:hidden;transition:.35s ease;}' +
        '#auto-eval-panel .ae-adv.open{max-height:260px;}' +
        '#auto-eval-panel .ae-adv-inner{padding-top:10px;border-top:1px solid #f1f5f9;margin-top:6px;}' +
        '#auto-eval-panel textarea{width:100%;height:46px;padding:8px 10px;border:1px solid #e2e8f0;' +
        'border-radius:8px;font-size:11px;font-family:inherit;resize:vertical;background:#f8fafc;' +
        'transition:.2s;line-height:1.5;}' +
        '#auto-eval-panel textarea:focus{outline:none;border-color:#818cf8;background:#fff;' +
        'box-shadow:0 0 0 3px rgba(99,102,241,.12);}' +
        // 底部提示
        '#auto-eval-panel .ae-tip{margin-top:12px;padding-top:10px;border-top:1px solid #f1f5f9;' +
        'display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#94a3b8;}' +
        '#auto-eval-panel .ae-tip kbd{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;' +
        'padding:1px 5px;font-size:10px;font-family:monospace;color:#64748b;}' +
        // 折叠态
        '#auto-eval-panel.collapsed .ae-body{display:none;}' +
        '#auto-eval-panel.collapsed{width:auto;}' +
        '#auto-eval-panel.collapsed .ae-header{border-radius:16px;}';
      document.head.appendChild(sty);
    }

    const panel = document.createElement('div');
    panel.id = 'auto-eval-panel';
    panel.innerHTML =
      '<div class="ae-header" id="ae-header">' +
        '<div class="ae-header-left">' +
          '<div class="ae-logo">📚</div>' +
          '<div class="ae-title">自动评教助手<span>HLJU · v3.0</span></div>' +
        '</div>' +
        '<span class="ae-close" id="ae-close">&times;</span>' +
      '</div>' +
      '<div class="ae-body">' +
        '<div class="ae-status-bar">' +
          '<span class="ae-status-dot" id="ae-status-dot"></span>' +
          '<span class="ae-status-text" id="ae-status">待命中</span>' +
        '</div>' +
        '<div class="ae-progress-wrap" id="ae-progress-wrap">' +
          '<div class="ae-progress-info">' +
            '<span>评教进度</span>' +
            '<span><b id="ae-done">0</b> / <span id="ae-total">0</span></span>' +
          '</div>' +
          '<div class="ae-progress-bar"><div class="ae-progress-fill" id="ae-progress-fill"></div></div>' +
        '</div>' +
        '<div class="ae-row">' +
          '<label class="ae-label">评分档位</label>' +
          '<div class="ae-seg" id="ae-score-seg">' +
            '<button data-score="5" class="active">满分 5分</button>' +
            '<button data-score="4">良好 4分</button>' +
          '</div>' +
        '</div>' +
        '<div class="ae-btns">' +
          '<button class="ae-btn ae-btn-start" id="ae-start">▶ 开始评教</button>' +
          '<button class="ae-btn ae-btn-stop" id="ae-stop">■</button>' +
        '</div>' +
        '<div class="ae-switch-row" id="ae-auto-row">' +
          '<div class="ae-switch-label">自动提交<span>关闭则填完暂停等你核验</span></div>' +
          '<div class="ae-toggle" id="ae-toggle"></div>' +
        '</div>' +
        '<div class="ae-adv-toggle" id="ae-adv-toggle">' +
          '<span class="ae-arrow">▾</span> 评语设置' +
        '</div>' +
        '<div class="ae-adv" id="ae-adv">' +
          '<div class="ae-adv-inner">' +
            '<div class="ae-row"><label class="ae-label">① 最满意方面</label>' +
            '<textarea id="ae-cmt-best"></textarea></div>' +
            '<div class="ae-row"><label class="ae-label">② 需改进方面</label>' +
            '<textarea id="ae-cmt-improve"></textarea></div>' +
          '</div>' +
        '</div>' +
        '<div class="ae-tip">' +
          '<span>仅评教页显示</span>' +
          '<span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd></span>' +
        '</div>' +
      '</div>';

    document.body.appendChild(panel);

    // 填充评语
    document.getElementById('ae-cmt-best').value = CONFIG.commentBest;
    document.getElementById('ae-cmt-improve').value = CONFIG.commentImprove;

    // 绑定事件
    document.getElementById('ae-close').onclick = function () {
      panel.style.display = 'none';
    };
    document.getElementById('ae-start').onclick = start;
    document.getElementById('ae-stop').onclick = stop;
    // 自动提交开关（点整行切换方块亮灭）
    const toggle = document.getElementById('ae-toggle');
    function syncToggle() {
      if (CONFIG.mode === 'auto') toggle.classList.add('on');
      else toggle.classList.remove('on');
    }
    syncToggle();
    document.getElementById('ae-auto-row').onclick = function () {
      CONFIG.mode = CONFIG.mode === 'auto' ? 'manual' : 'auto';
      syncToggle();
      log('模式切换:', CONFIG.mode);
    };
    // 评分档位
    const segBtns = document.querySelectorAll('#ae-score-seg button');
    segBtns.forEach(function (btn) {
      btn.onclick = function () {
        segBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        CONFIG.scoreLevel = btn.dataset.score;
        log('评分档位 → ' + CONFIG.scoreLevel + ' 分');
      };
    });
    // 评语展开（动画折叠）
    const advToggle = document.getElementById('ae-adv-toggle');
    const adv = document.getElementById('ae-adv');
    advToggle.onclick = function () {
      adv.classList.toggle('open');
      advToggle.classList.toggle('open');
    };
    // 评语保存
    document.getElementById('ae-cmt-best').onblur = function () {
      CONFIG.commentBest = this.value;
      saveConfig();
    };
    document.getElementById('ae-cmt-improve').onblur = function () {
      CONFIG.commentImprove = this.value;
      saveConfig();
    };
  }

  function setStatus(msg, color) {
    color = color || '#94a3b8';
    const el = document.getElementById('ae-status');
    const dot = document.getElementById('ae-status-dot');
    if (el) el.textContent = msg;
    if (dot) {
      dot.className = 'ae-status-dot';
      if (/运行|填写|进入/.test(msg)) dot.classList.add('running');
      else if (/完成/.test(msg)) dot.classList.add('done');
      else if (/出错/.test(msg)) dot.classList.add('error');
      else if (/暂停|停止|等待|核验/.test(msg)) dot.classList.add('paused');
    }
  }

  /* =========================================================================
   *  配置持久化（localStorage）
   * ========================================================================= */
  function saveConfig() {
    try {
      localStorage.setItem(
        'hlju_auto_eval_config',
        JSON.stringify({
          scoreLevel: CONFIG.scoreLevel,
          commentBest: CONFIG.commentBest,
          commentImprove: CONFIG.commentImprove,
          mode: CONFIG.mode,
        })
      );
    } catch (e) {}
  }

  function loadConfig() {
    try {
      const s = localStorage.getItem('hlju_auto_eval_config');
      if (s) {
        const c = JSON.parse(s);
        if (c.scoreLevel) CONFIG.scoreLevel = c.scoreLevel;
        if (c.commentBest) CONFIG.commentBest = c.commentBest;
        if (c.commentImprove) CONFIG.commentImprove = c.commentImprove;
        if (c.mode) CONFIG.mode = c.mode;
      }
    } catch (e) {}
  }

  /* =========================================================================
   *  启停控制
   * ========================================================================= */
  async function start() {
    if (STATE.running) {
      toast('已在运行中...');
      return;
    }
    STATE.running = true;
    STATE.totalCount = 0;
    STATE.doneCount = 0;
    setStatus('运行中...', '#7cba23');

    const page = detectPage();
    log('开始，当前页面:', page, '| 模式:', CONFIG.mode);

    try {
      if (page === 'list') {
        await processListLoop();
      } else if (page === 'survey') {
        await handleSurveyPage();
        await waitForListPage();
        if (STATE.running) await processListLoop();
      } else {
        toast('请先进入评教列表页面', 2500);
        STATE.running = false;
        setStatus('待命中');
      }
    } catch (e) {
      log('出错:', e);
      toast('出错: ' + e.message, 3000);
      STATE.running = false;
      setStatus('出错', '#ef4444');
    }

    if (!STATE.running) setStatus('待命中');
  }

  async function waitForListPage() {
    for (let i = 0; i < 90; i++) {
      if (detectPage() === 'list') {
        await delay(2000);
        return;
      }
      await delay(1000);
    }
  }

  function stop() {
    STATE.running = false;
    setStatus('已停止');
    toast('已停止');
  }

  /* =========================================================================
   *  面板显示控制：只在评教页（list/survey）显示，课表等其他页面自动隐藏
   * ========================================================================= */
  function isEvalPage() {
    const p = detectPage();
    return p === 'list' || p === 'survey';
  }

  function showPanelIfEval() {
    const panel = document.getElementById('auto-eval-panel');
    if (!panel) return;
    // 仅在评教页面显示面板，其他页面（课表等）隐藏
    panel.style.display = isEvalPage() ? 'block' : 'none';
  }

  /* =========================================================================
   *  初始化
   * ========================================================================= */
  function init() {
    loadConfig();

    log('脚本已加载 v3.0.0, 当前页面:', detectPage(), '| 模式:', CONFIG.mode);

    // 仅在评教页面创建并显示面板
    if (isEvalPage()) {
      createPanel();
      syncPanelState();
    }

    // hashchange 监听：路由变化时动态显示/隐藏面板 + 自动继续处理
    let lastHash = window.location.hash;
    window.addEventListener('hashchange', function () {
      const h = window.location.hash;
      if (h === lastHash) return;
      lastHash = h;

      const page = detectPage();
      log('路由变化 ->', page);

      // 进入评教页：确保面板存在并显示
      if (page === 'list' || page === 'survey') {
        if (!document.getElementById('auto-eval-panel')) {
          createPanel();
          syncPanelState();
        }
        showPanelIfEval();
      } else {
        // 离开评教页（进入课表等）：隐藏面板
        const panel = document.getElementById('auto-eval-panel');
        if (panel) panel.style.display = 'none';
        // 若正在运行且离开评教页，暂停处理（不停止，等回来再继续）
        if (STATE.running) {
          log('离开评教页面，暂停处理');
        }
        return;
      }

      // 运行中的自动继续逻辑
      if (!STATE.running) return;
      if (page === 'survey') {
        handleSurveyPage();
      } else if (page === 'list') {
        updateProgress();
        setStatus('运行中...', '#7cba23');
        setTimeout(function () {
          if (STATE.running) processListLoop();
        }, 1500);
      }
    });

    startDialogWatcher();

    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        if (STATE.running) stop();
        else start();
      }
    });

    if (isEvalPage()) {
      toast('自动评教脚本已就绪 | Ctrl+Shift+A 启动', 2500);
    }
  }

  // 同步面板状态（从配置填充）
  function syncPanelState() {
    const toggle = document.getElementById('ae-toggle');
    if (toggle) {
      if (CONFIG.mode === 'auto') toggle.classList.add('on');
      else toggle.classList.remove('on');
    }
    const segBtns = document.querySelectorAll('#ae-score-seg button');
    if (segBtns.length) {
      segBtns.forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.score === CONFIG.scoreLevel);
      });
    }
    const cmtBest = document.getElementById('ae-cmt-best');
    if (cmtBest) cmtBest.value = CONFIG.commentBest;
    const cmtImprove = document.getElementById('ae-cmt-improve');
    if (cmtImprove) cmtImprove.value = CONFIG.commentImprove;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
