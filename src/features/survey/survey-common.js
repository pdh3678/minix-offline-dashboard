'use strict';
/* 설문 공용 — 공개 응답 페이지(form.html → form.js)와 대시보드 설문 관리(미리보기)가 같이 쓴다. 브라우저에서는 전역 SurveyKit,
   node에서는 require()(tests/survey-ui.test.js).

   · 안내문 렌더러(blocksHtml) — BlockNote 블록 JSON을 읽기 전용 HTML로. 응답 페이지가 5MB짜리 편집기 번들을 받지 않게 직접 그린다.
     허용 블록(문단·제목·글머리표·번호 목록)과 서식(굵게·기울임·밑줄·취소선·코드·색)만, 글자는 전부 이스케이프 — HTML 주입 불가.
     GAS(_svCleanBlocks)가 저장할 때 같은 목록으로 한 번 더 거른다.
   · 설문 양식(formHtml + mountForm) — 질문 유형별 입력, 전화번호 자동 하이픈, 기타(직접 입력), 카카오 우편번호, 사진 선택·압축, 검증.
     검증 규칙·문구는 GAS _svCleanAnswers와 같다(서버가 다시 검증한다 — 여기는 바로 알려 주기 위한 것).
   · 사진 압축(compressImage) — 긴 변 2000px·JPEG 품질 0.8. 다시 그리면서 EXIF(촬영 위치 등)도 빠진다.
     브라우저가 못 여는 형식(HEIC 등)은 원본을 10MB까지만. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SurveyKit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const TYPES = [
    { type: 'notice', label: '안내문 블록', icon: '📝' },
    { type: 'consent', label: '개인정보 수집·이용 동의', icon: '🔒' },
    { type: 'file', label: '파일 업로드(이미지)', icon: '📷' },
    { type: 'checkbox', label: '체크박스(복수 선택)', icon: '☑️' },
    { type: 'radio', label: '객관식(단일 선택)', icon: '🔘' },
    { type: 'dropdown', label: '드롭다운', icon: '🔽' },
    { type: 'short', label: '단답형', icon: '✏️' },
    { type: 'long', label: '장문형', icon: '📄' },
    { type: 'name', label: '이름', icon: '👤' },
    { type: 'phone', label: '전화번호', icon: '📱' },
    { type: 'address', label: '주소', icon: '🏠' },
    { type: 'date', label: '날짜', icon: '📅' },
    { type: 'scale', label: '1~5점 척도', icon: '⭐' }
  ];
  const TYPE_LABEL = {};
  TYPES.forEach(t => { TYPE_LABEL[t.type] = t.label; });
  const CHOICE = { checkbox: true, radio: true, dropdown: true };
  const PII = { name: true, phone: true, address: true };
  // 개인정보 동의 기본 문구 — GAS _svConsentDefaults와 같은 값
  const CONSENT_DEFAULT = {
    items: '성함, 연락처, 배송지 주소, 구매 영수증 사진', purpose: '이벤트 참여 확인 및 사은품 발송',
    period: '이벤트 마감 후 90일까지 보관 후 파기', refusal: '동의를 거부할 수 있으며, 거부 시 이벤트 참여 및 사은품 발송이 제한됩니다.',
    agreeLabel: '개인정보 수집·이용에 동의합니다.'
  };
  const OTHER_LABEL = '기타';
  const IMG_MAX_SIDE = 2000, IMG_QUALITY = 0.8, RAW_MAX_MB = 10, TOTAL_MAX_BYTES = 30 * 1024 * 1024;
  const POSTCODE_SRC = 'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const nl2br = s => esc(s).replace(/\n/g, '<br>');

  // ── 안내문 블록 → HTML ──
  const BLOCKS = { paragraph: true, heading: true, bulletListItem: true, numberedListItem: true };
  const COLORS = { gray: true, brown: true, red: true, orange: true, yellow: true, green: true, blue: true, purple: true, pink: true };
  function inlineHtml(content) {
    if (typeof content === 'string') return esc(content);
    if (!Array.isArray(content)) return '';
    return content.map(c => {
      if (!c) return '';
      if (c.type === 'link') {
        const href = String(c.href || '');
        const inner = inlineHtml(c.content);
        return /^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      }
      if (c.type !== 'text' || typeof c.text !== 'string') return '';
      let h = esc(c.text).replace(/\n/g, '<br>');
      const s = c.styles || {};
      if (s.code === true) h = `<code>${h}</code>`;
      if (s.strike === true) h = `<s>${h}</s>`;
      if (s.underline === true) h = `<u>${h}</u>`;
      if (s.italic === true) h = `<em>${h}</em>`;
      if (s.bold === true) h = `<strong>${h}</strong>`;
      const cls = [];
      if (COLORS[s.textColor]) cls.push('svb-c-' + s.textColor);
      if (COLORS[s.backgroundColor]) cls.push('svb-bg-' + s.backgroundColor);
      return cls.length ? `<span class="${cls.join(' ')}">${h}</span>` : h;
    }).join('');
  }
  function blockCls(p) {
    const cls = [];
    if (p && COLORS[p.textColor]) cls.push('svb-c-' + p.textColor);
    if (p && COLORS[p.backgroundColor]) cls.push('svb-bg-' + p.backgroundColor);
    if (p && (p.textAlignment === 'center' || p.textAlignment === 'right')) cls.push('svb-al-' + p.textAlignment);
    return cls.length ? ` class="${cls.join(' ')}"` : '';
  }
  function blocksHtml(blocks, depth) {
    depth = depth || 0;
    if (!Array.isArray(blocks) || depth > 3) return '';
    let out = '', listTag = '';
    const close = () => { if (listTag) { out += `</${listTag}>`; listTag = ''; } };
    blocks.forEach(b => {
      if (!b || !BLOCKS[b.type]) return;
      const kids = Array.isArray(b.children) && b.children.length ? blocksHtml(b.children, depth + 1) : '';
      const inner = inlineHtml(b.content);
      if (b.type === 'bulletListItem' || b.type === 'numberedListItem') {
        const tag = b.type === 'bulletListItem' ? 'ul' : 'ol';
        if (listTag !== tag) { close(); out += `<${tag}>`; listTag = tag; }
        out += `<li${blockCls(b.props)}>${inner}${kids}</li>`;
        return;
      }
      close();
      if (b.type === 'heading') {
        const lv = [1, 2, 3].indexOf(Number(b.props && b.props.level)) >= 0 ? Number(b.props.level) : 2;
        out += `<h${lv + 1}${blockCls(b.props)}>${inner}</h${lv + 1}>`;
      } else out += `<p${blockCls(b.props)}>${inner || '<br>'}</p>`;
      if (kids) out += `<div class="svb-indent">${kids}</div>`;
    });
    close();
    return out;
  }
  // 저장 전에 기본값 속성·빈 자식·블록 id를 덜어 낸다(시트 셀 5만 자 한도) — BlockNote는 이 모양도 그대로 읽는다
  function compactBlocks(blocks) {
    if (!Array.isArray(blocks)) return [];
    return blocks.map(b => {
      const o = { type: b.type };
      const p = {};
      Object.keys(b.props || {}).forEach(k => {
        const v = b.props[k];
        if (v === 'default' || v === 'left' || v === false || v == null || v === '') return;
        p[k] = v;
      });
      if (Object.keys(p).length) o.props = p;
      if (Array.isArray(b.content)) o.content = b.content.map(c => {
        if (c && c.type === 'text') {
          const st = {};
          Object.keys(c.styles || {}).forEach(k => { if (c.styles[k] && c.styles[k] !== 'default') st[k] = c.styles[k]; });
          return { type: 'text', text: c.text, styles: st };
        }
        return c;
      });
      if (Array.isArray(b.children) && b.children.length) o.children = compactBlocks(b.children);
      return o;
    });
  }
  // 안내문이 비었는지(빈 문단만 있는 경우 포함)
  function blocksEmpty(blocks) {
    return !(blocks || []).some(b => (Array.isArray(b.content) && b.content.some(c => c && (c.type === 'link' || String(c.text || '').trim()))) || blocksEmpty(b.children) === false);
  }

  // ── 전화번호 ──
  // 입력 중 자동 하이픈(010-1234-5678) — 숫자 11자리까지
  function formatPhoneTyping(s) {
    const d = String(s || '').replace(/\D/g, '').slice(0, 11);
    if (d.length < 4) return d;
    if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  }
  function formatPhone(s) {
    const d = String(s || '').replace(/\D/g, '');
    if (!/^01[016789]\d{7,8}$/.test(d)) return '';
    return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  }
  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
  }

  /* 검증 — answers는 collect()가 만든 모양, fileCounts = {질문ID: 장수}. {질문ID: 안내 문구}
     GAS _svCleanAnswers·_svCheckFiles와 같은 규칙·문구 */
  function validate(questions, answers, fileCounts) {
    const errors = {};
    (questions || []).forEach(q => {
      if (q.deleted) return;
      const t = q.type, v = answers[q.id], req = !!q.required;
      if (t === 'notice') return;
      if (t === 'file') {
        const n = (fileCounts && fileCounts[q.id]) || 0, max = q.maxFiles || 3;
        if (!n && req) errors[q.id] = '사진을 1장 이상 올려주세요.';
        else if (n > max) errors[q.id] = '사진은 최대 ' + max + '장까지 올릴 수 있습니다.';
        return;
      }
      if (t === 'consent') { if (v !== true && req) errors[q.id] = '개인정보 수집·이용에 동의해주세요.'; return; }
      if (CHOICE[t]) {
        const sel = (v && v.sel) || [], other = v && v.other != null ? String(v.other).trim() : null;
        if (other === '') { errors[q.id] = '기타 내용을 입력해주세요.'; return; }
        if (!sel.length && other == null && req) errors[q.id] = '선택해주세요.';
        return;
      }
      if (t === 'scale') { if ((v == null || v === '') && req) errors[q.id] = '점수를 선택해주세요.'; return; }
      if (t === 'address') {
        const a = v || {}, zip = String(a.zip || '').trim(), a1 = String(a.addr1 || '').trim(), a2 = String(a.addr2 || '').trim();
        if (!zip && !a1 && !a2) { if (req) errors[q.id] = '주소를 입력해주세요.'; return; }
        if (!/^\d{5}$/.test(zip) || !a1) { errors[q.id] = '주소 검색으로 우편번호와 기본주소를 입력해주세요.'; return; }
        if (!a2) errors[q.id] = '상세주소를 입력해주세요.';
        return;
      }
      const s = String(v == null ? '' : v).trim(), max = t === 'long' ? 5000 : t === 'name' ? 50 : 500;
      if (!s) { if (req) errors[q.id] = t === 'name' ? '성함을 입력해주세요.' : t === 'phone' ? '연락처를 입력해주세요.' : t === 'date' ? '날짜를 선택해주세요.' : '입력해주세요.'; return; }
      if (s.length > max) { errors[q.id] = max + '자 이내로 입력해주세요.'; return; }
      if (t === 'phone' && !formatPhone(s)) errors[q.id] = '010-0000-0000 형식으로 입력해주세요.';
      if (t === 'date' && !validDate(s)) errors[q.id] = '날짜 형식이 올바르지 않습니다.';
    });
    return errors;
  }

  // ── 양식 HTML ──
  function questionHtml(q, uid) {
    const name = uid + '-' + q.id, t = q.type;
    const req = q.required && t !== 'notice' ? '<span class="svf-req" aria-label="필수">*</span>' : '';
    const head = t === 'notice' ? (q.title ? `<div class="svf-q-hd"><span class="svf-q-title">${esc(q.title)}</span></div>` : '')
      : `<div class="svf-q-hd"><span class="svf-q-title" id="${esc(name)}-t">${esc(q.title)}</span>${req}</div>`;
    const desc = q.desc ? `<div class="svf-q-desc">${nl2br(q.desc)}</div>` : '';
    let body = '';
    if (t === 'notice') body = `<div class="svf-blocks">${blocksHtml(q.blocks)}</div>`;
    else if (t === 'consent') {
      const d = CONSENT_DEFAULT, row = (k, l) => `<tr><th scope="row">${l}</th><td>${nl2br(q[k] != null ? q[k] : d[k])}</td></tr>`;
      body = `<table class="svf-consent">${row('items', '수집 항목')}${row('purpose', '이용 목적')}${row('period', '보유 기간')}${row('refusal', '거부 권리와 불이익')}</table>
        <label class="svf-agree"><input type="checkbox" data-role="consent"><span><span class="svf-agree-t">${esc(q.agreeLabel || d.agreeLabel)} <b class="svf-req-txt">(필수)</b></span></span></label>`;
    } else if (t === 'file') {
      const max = q.maxFiles || 3;
      body = `<div class="svf-files" data-max="${max}"><div class="svf-file-list"></div>
        <label class="svf-file-btn"><input type="file" accept="image/*,.heic,.heif" multiple data-role="file" class="svf-hidden-input"><span>📷 사진 선택</span><small>최대 ${max}장</small></label>
        <div class="svf-hint">사진은 자동으로 줄여서 올립니다(긴 변 2000px).</div></div>`;
    } else if (t === 'checkbox' || t === 'radio') {
      const inType = t === 'checkbox' ? 'checkbox' : 'radio', chips = q.style === 'chips';
      const opts = (q.options || []).map(o => `<label class="${chips ? 'svf-chip' : 'svf-opt'}"><input type="${inType}" name="${esc(name)}" value="${esc(o)}" data-role="opt"><span>${esc(o)}</span></label>`).join('');
      const other = q.allowOther ? `<label class="${chips ? 'svf-chip' : 'svf-opt'} svf-other"><input type="${inType}" name="${esc(name)}" value="" data-role="other"><span>${OTHER_LABEL}</span></label>` : '';
      body = `<div class="${chips ? 'svf-chips' : 'svf-opts'}" role="group" aria-labelledby="${esc(name)}-t">${opts}${other}</div>` +
        (q.allowOther ? `<input type="text" class="svf-in svf-other-in" data-role="otherText" maxlength="200" placeholder="직접 입력" hidden>` : '');
    } else if (t === 'dropdown') {
      body = `<select class="svf-in svf-select" data-role="select" aria-labelledby="${esc(name)}-t"><option value="">선택하세요</option>` +
        (q.options || []).map((o, i) => `<option value="o${i}">${esc(o)}</option>`).join('') +
        (q.allowOther ? `<option value="__other">${OTHER_LABEL}(직접 입력)</option>` : '') + '</select>' +
        (q.allowOther ? `<input type="text" class="svf-in svf-other-in" data-role="otherText" maxlength="200" placeholder="직접 입력" hidden>` : '');
    } else if (t === 'short') body = `<input type="text" class="svf-in" data-role="text" maxlength="500" aria-labelledby="${esc(name)}-t">`;
    else if (t === 'long') body = `<textarea class="svf-in svf-ta" data-role="text" maxlength="5000" rows="4" aria-labelledby="${esc(name)}-t"></textarea>`;
    else if (t === 'name') body = `<input type="text" class="svf-in" data-role="text" maxlength="50" autocomplete="name" placeholder="홍길동" aria-labelledby="${esc(name)}-t">`;
    else if (t === 'phone') body = `<input type="tel" class="svf-in" data-role="phone" inputmode="numeric" autocomplete="tel" maxlength="13" placeholder="010-0000-0000" aria-labelledby="${esc(name)}-t">`;
    else if (t === 'address') {
      body = `<div class="svf-addr"><div class="svf-addr-row"><input type="text" class="svf-in svf-zip" data-role="zip" placeholder="우편번호" readonly inputmode="numeric" maxlength="5">
        <button type="button" class="svf-btn2" data-role="postcode">주소 검색</button></div>
        <input type="text" class="svf-in" data-role="addr1" placeholder="기본주소 (주소 검색으로 입력)" readonly maxlength="200">
        <input type="text" class="svf-in" data-role="addr2" placeholder="상세주소 (동·호수 등, 없으면 '없음')" maxlength="100" autocomplete="address-line2"></div>`;
    } else if (t === 'date') body = `<input type="date" class="svf-in svf-date" data-role="text" aria-labelledby="${esc(name)}-t">`;
    else if (t === 'scale') {
      body = `<div class="svf-scale" role="radiogroup" aria-labelledby="${esc(name)}-t">${[1, 2, 3, 4, 5].map(n => `<label class="svf-scale-n"><input type="radio" name="${esc(name)}" value="${n}" data-role="scale"><span>${n}</span></label>`).join('')}</div>` +
        (q.minLabel || q.maxLabel ? `<div class="svf-scale-lb"><span>${esc(q.minLabel)}</span><span>${esc(q.maxLabel)}</span></div>` : '');
    }
    return `<section class="svf-q svf-t-${t}" data-q="${esc(q.id)}">${head}${desc}${body}<div class="svf-q-err" role="alert"></div></section>`;
  }
  // 설문 전체 — survey = { title, notice, questions } (공개 보기). opts.preview면 제출 버튼 대신 안내
  function formHtml(survey, opts) {
    opts = opts || {};
    const uid = opts.uid || 'svf';
    const qs = (survey.questions || []).filter(q => !q.deleted);
    const notice = blocksHtml(survey.notice);
    return `<div class="svf">
      <h1 class="svf-title">${esc(survey.title)}</h1>
      ${notice ? `<div class="svf-notice svf-blocks">${notice}</div>` : ''}
      <form class="svf-form" novalidate autocomplete="on">
        ${qs.map(q => questionHtml(q, uid)).join('')}
        <div class="svf-hp" aria-hidden="true"><label>홈페이지<input type="text" name="website" tabindex="-1" autocomplete="off" data-role="hp"></label></div>
        <div class="svf-form-err" role="alert"></div>
        <button type="submit" class="svf-submit"${opts.preview ? ' disabled' : ''}>${opts.preview ? '미리보기 — 제출되지 않습니다' : '제출하기'}</button>
      </form></div>`;
  }

  // ── 사진 ──
  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  /* 압축 — {blob, type, size, origSize, compressed, w, h, thumbUrl}. 브라우저가 못 여는 형식은 compressed:false로 원본(10MB 넘으면 throw).
     <img>는 EXIF 방향을 반영해 그려지므로(현재 주요 브라우저) 세로 사진이 눕지 않는다 */
  async function compressImage(file) {
    let loaded = null;
    try { loaded = await loadImg(file); } catch (e) { loaded = null; }
    if (!loaded) {
      if (file.size > RAW_MAX_MB * 1048576) throw new Error('이 형식(' + (String(file.name || '').split('.').pop() || '알 수 없음').toUpperCase() + ')은 자동으로 줄일 수 없어 ' + RAW_MAX_MB + 'MB 이하만 올릴 수 있습니다. 카메라 설정을 JPG(호환성 우선)로 바꾸거나 화면을 캡처해 올려주세요.');
      if (!/^image\//.test(file.type || '') && !/\.(heic|heif|avif)$/i.test(file.name || '')) throw new Error('이미지 파일만 올릴 수 있습니다.');
      return { blob: file, type: file.type || 'image/heic', size: file.size, origSize: file.size, compressed: false, thumbUrl: '' };
    }
    const { img, url } = loaded;
    const w0 = img.naturalWidth, h0 = img.naturalHeight, r = Math.min(1, IMG_MAX_SIDE / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * r)), h = Math.max(1, Math.round(h0 * r));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // 투명 PNG가 검게 나오지 않게
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', IMG_QUALITY));
    if (!blob) throw new Error('사진을 처리하지 못했습니다. 다른 사진으로 시도해주세요.');
    return { blob, type: 'image/jpeg', size: blob.size, origSize: file.size, compressed: true, w, h, thumbUrl: URL.createObjectURL(blob) };
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('사진을 읽지 못했습니다.'));
      r.readAsDataURL(blob);
    });
  }
  const fmtBytes = n => n >= 1048576 ? (Math.round(n / 104857.6) / 10) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

  // ── 카카오 우편번호 — 처음 누를 때만 스크립트를 받고, 화면 위 레이어에 띄운다(모바일에서 새 창을 열지 않게) ──
  let postcodeP = null;
  function loadPostcode() {
    if (window.daum && window.daum.Postcode) return Promise.resolve();
    if (postcodeP) return postcodeP;
    postcodeP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = POSTCODE_SRC; s.async = true;
      s.onload = () => (window.daum && window.daum.Postcode ? resolve() : reject(new Error('postcode')));
      s.onerror = () => { postcodeP = null; reject(new Error('postcode')); };
      document.head.appendChild(s);
    });
    return postcodeP;
  }
  function openPostcode(onPick, onFail) {
    loadPostcode().then(() => {
      const ov = document.createElement('div');
      ov.className = 'svf-pc-ov';
      ov.innerHTML = '<div class="svf-pc-box" role="dialog" aria-label="주소 검색"><div class="svf-pc-hd"><b>주소 검색</b><button type="button" class="svf-pc-x" aria-label="닫기">✕</button></div><div class="svf-pc-body"></div></div>';
      document.body.appendChild(ov);
      const close = () => { if (ov.parentNode) ov.parentNode.removeChild(ov); };
      ov.querySelector('.svf-pc-x').onclick = close;
      ov.addEventListener('click', e => { if (e.target === ov) close(); });
      new window.daum.Postcode({
        width: '100%', height: '100%',
        oncomplete(data) {
          let addr = data.userSelectedType === 'J' ? data.jibunAddress : data.roadAddress;
          if (data.userSelectedType !== 'J') {
            const extra = [/[동로가]$/.test(data.bname || '') ? data.bname : '', data.apartment === 'Y' ? data.buildingName : ''].filter(Boolean).join(', ');
            if (extra) addr += ' (' + extra + ')';
          }
          onPick({ zip: data.zonecode, addr1: addr || data.address });
          close();
        }
      }).embed(ov.querySelector('.svf-pc-body'));
    }).catch(() => onFail && onFail());
  }

  /* 양식 붙이기 — root에 formHtml을 넣고 입력 동작을 건다. 반환: { collect(), validate(), showErrors(errors), busy(on, label) }
     opts.onSubmit(payload) — 제출 버튼(검증 통과 시). payload = { answers, files: [{q, blob, type}] , hp } */
  function mountForm(rootEl, survey, opts) {
    opts = opts || {};
    rootEl.innerHTML = formHtml(survey, opts);
    const qs = (survey.questions || []).filter(q => !q.deleted);
    const qById = {};
    qs.forEach(q => { qById[q.id] = q; });
    const files = {}; // 질문ID → [{key, name, blob, type, size, origSize, compressed, thumbUrl, busy, err}]
    const sec = id => rootEl.querySelector(`.svf-q[data-q="${cssEsc(id)}"]`);
    const setErr = (id, msg) => {
      const s = sec(id);
      if (!s) return;
      s.classList.toggle('svf-has-err', !!msg);
      s.querySelector('.svf-q-err').textContent = msg || '';
    };
    const form = rootEl.querySelector('.svf-form');

    // 입력 동작(위임)
    form.addEventListener('input', e => {
      const el = e.target, s = el.closest('.svf-q');
      if (!s) return;
      if (el.dataset.role === 'phone') {
        const pos = el.value.length, f = formatPhoneTyping(el.value);
        if (f !== el.value) { el.value = f; if (document.activeElement === el && pos === el.value.length) el.setSelectionRange(f.length, f.length); }
      }
      if (s.classList.contains('svf-has-err')) setErr(s.dataset.q, '');
    });
    form.addEventListener('change', e => {
      const el = e.target, s = el.closest('.svf-q');
      if (!s) return;
      const q = qById[s.dataset.q];
      if (el.dataset.role === 'opt' || el.dataset.role === 'other') {
        const otherOn = !!s.querySelector('input[data-role="other"]:checked'), ot = s.querySelector('[data-role="otherText"]');
        if (ot) { ot.hidden = !otherOn; if (otherOn && el.dataset.role === 'other') ot.focus(); }
      }
      if (el.dataset.role === 'select') {
        const ot = s.querySelector('[data-role="otherText"]');
        if (ot) { ot.hidden = el.value !== '__other'; if (!ot.hidden) ot.focus(); }
      }
      if (el.dataset.role === 'file') { addFiles(q, el.files); el.value = ''; }
      if (s.classList.contains('svf-has-err')) setErr(s.dataset.q, '');
    });
    form.addEventListener('click', e => {
      const el = e.target.closest('[data-role]');
      if (!el) return;
      const s = el.closest('.svf-q');
      if (el.dataset.role === 'postcode') {
        e.preventDefault();
        openPostcode(v => {
          s.querySelector('[data-role="zip"]').value = v.zip;
          s.querySelector('[data-role="addr1"]').value = v.addr1;
          setErr(s.dataset.q, '');
          s.querySelector('[data-role="addr2"]').focus();
        }, () => {
          // 우편번호 서비스를 못 불러오면 직접 입력할 수 있게 연다
          ['zip', 'addr1'].forEach(r => { s.querySelector(`[data-role="${r}"]`).readOnly = false; });
          setErr(s.dataset.q, '주소 검색을 불러오지 못했습니다. 우편번호(5자리)와 주소를 직접 입력해주세요.');
        });
      }
      if (el.dataset.role === 'rmFile') {
        e.preventDefault();
        const qid = s.dataset.q, list = files[qid] || [], i = list.findIndex(x => x.key === el.dataset.key);
        if (i >= 0) { if (list[i].thumbUrl) URL.revokeObjectURL(list[i].thumbUrl); list.splice(i, 1); }
        renderFiles(qid);
      }
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (opts.preview || !opts.onSubmit) return;
      const errors = api.validate();
      api.showErrors(errors);
      if (Object.keys(errors).length) return;
      opts.onSubmit(api.collect());
    });

    let fileSeq = 0;
    function addFiles(q, list) {
      const cur = files[q.id] = files[q.id] || [], max = q.maxFiles || 3;
      const picked = Array.prototype.slice.call(list || []);
      if (cur.length + picked.length > max) setErr(q.id, '사진은 최대 ' + max + '장까지 올릴 수 있습니다 — 앞의 ' + Math.max(0, max - cur.length) + '장만 담았습니다.');
      picked.slice(0, Math.max(0, max - cur.length)).forEach(file => {
        const item = { key: 'f' + (++fileSeq), name: file.name || '사진', busy: true, origSize: file.size };
        cur.push(item);
        compressImage(file).then(r => { Object.assign(item, r, { busy: false }); renderFiles(q.id); })
          .catch(err => {
            const i = cur.indexOf(item);
            if (i >= 0) cur.splice(i, 1);
            setErr(q.id, err.message);
            renderFiles(q.id);
          });
      });
      renderFiles(q.id);
    }
    function renderFiles(qid) {
      const s = sec(qid), list = files[qid] || [], q = qById[qid];
      s.querySelector('.svf-file-list').innerHTML = list.map(f => `<div class="svf-file">
        <div class="svf-file-th">${f.busy ? '<span class="svf-spin"></span>' : f.thumbUrl ? `<img src="${esc(f.thumbUrl)}" alt="">` : '<span class="svf-file-raw">원본</span>'}</div>
        <div class="svf-file-info"><div class="svf-file-name">${esc(f.name)}</div>
          <div class="svf-file-size">${f.busy ? '줄이는 중…' : f.compressed ? fmtBytes(f.origSize) + ' → ' + fmtBytes(f.size) : fmtBytes(f.size) + ' (원본)'}</div></div>
        <button type="button" class="svf-file-rm" data-role="rmFile" data-key="${f.key}" aria-label="사진 빼기">✕</button></div>`).join('');
      const btn = s.querySelector('.svf-file-btn');
      if (btn) btn.classList.toggle('svf-full', list.length >= (q.maxFiles || 3));
    }

    const api = {
      // 답변 — GAS _svCleanAnswers가 받는 모양
      collect() {
        const answers = {}, out = [];
        qs.forEach(q => {
          const s = sec(q.id);
          if (!s) return;
          const t = q.type;
          if (t === 'notice') return;
          if (t === 'consent') { if (s.querySelector('[data-role="consent"]').checked) answers[q.id] = true; return; }
          if (t === 'file') { (files[q.id] || []).forEach(f => { if (!f.busy && f.blob) out.push({ q: q.id, blob: f.blob, type: f.type }); }); return; }
          if (t === 'checkbox' || t === 'radio') {
            const sel = Array.prototype.slice.call(s.querySelectorAll('input[data-role="opt"]:checked')).map(x => x.value);
            const other = s.querySelector('input[data-role="other"]:checked');
            if (sel.length || other) answers[q.id] = other ? { sel, other: s.querySelector('[data-role="otherText"]').value.trim() } : { sel };
            return;
          }
          if (t === 'dropdown') {
            const v = s.querySelector('[data-role="select"]').value;
            if (v === '__other') answers[q.id] = { sel: [], other: s.querySelector('[data-role="otherText"]').value.trim() };
            else if (v) answers[q.id] = { sel: [q.options[Number(v.slice(1))]] };
            return;
          }
          if (t === 'scale') { const c = s.querySelector('input[data-role="scale"]:checked'); if (c) answers[q.id] = Number(c.value); return; }
          if (t === 'address') {
            const g = r => s.querySelector(`[data-role="${r}"]`).value.trim();
            if (g('zip') || g('addr1') || g('addr2')) answers[q.id] = { zip: g('zip'), addr1: g('addr1'), addr2: g('addr2') };
            return;
          }
          const el = s.querySelector('[data-role="text"],[data-role="phone"]'), v = el ? el.value.trim() : '';
          if (v) answers[q.id] = t === 'phone' ? (formatPhone(v) || v) : v;
        });
        const hp = form.querySelector('[data-role="hp"]');
        return { answers, files: out, hp: hp ? hp.value : '' };
      },
      validate() {
        const c = api.collect(), counts = {};
        c.files.forEach(f => { counts[f.q] = (counts[f.q] || 0) + 1; });
        const errors = validate(qs, c.answers, counts);
        Object.keys(files).forEach(qid => { if ((files[qid] || []).some(f => f.busy)) errors[qid] = '사진을 줄이는 중입니다. 잠시 후 다시 눌러주세요.'; });
        const total = c.files.reduce((n, f) => n + (f.blob ? f.blob.size : 0), 0);
        if (total > TOTAL_MAX_BYTES) { const first = qs.find(q => q.type === 'file'); if (first) errors[first.id] = '사진 용량 합계가 너무 큽니다(30MB 이하로 올려주세요).'; }
        return errors;
      },
      showErrors(errors) {
        let first = null;
        qs.forEach(q => { setErr(q.id, errors[q.id] || ''); if (errors[q.id] && !first) first = sec(q.id); });
        const fe = rootEl.querySelector('.svf-form-err');
        if (fe) fe.textContent = Object.keys(errors).length ? '입력하지 않았거나 형식이 맞지 않는 항목이 있습니다.' : '';
        if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      },
      setFormError(msg) { const fe = rootEl.querySelector('.svf-form-err'); if (fe) fe.textContent = msg || ''; },
      busy(on, label) {
        const b = rootEl.querySelector('.svf-submit');
        if (!b) return;
        b.disabled = !!on || !!opts.preview;
        b.textContent = on ? (label || '제출 중…') : (opts.preview ? '미리보기 — 제출되지 않습니다' : '제출하기');
      }
    };
    return api;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  return { TYPES, TYPE_LABEL, CHOICE, PII, CONSENT_DEFAULT, OTHER_LABEL, esc, blocksHtml, compactBlocks, blocksEmpty, formatPhone, formatPhoneTyping, validate,
    questionHtml, formHtml, mountForm, compressImage, blobToBase64, fmtBytes, openPostcode, POSTCODE_SRC };
});
