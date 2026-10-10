'use strict';
/* 공개 설문 응답 페이지(form.html) — 로그인 없음. Apps Script의 공개 액션 두 개(survey_getPublic·survey_submit)만 부른다.
   · 주소: /s/{설문 주소}(Render Rewrite) 또는 form.html?f={설문ID}. 이전 주소로 오면 주소창을 지금 주소로 바꾼다(다시 받지 않음)
   · 게시 중·기간 안일 때만 양식, 아니면(초안·없는 주소 포함) "마감되었습니다"
   · 제출: 사진은 고를 때 이미 줄여 둔 것(SurveyKit.compressImage)을 base64로. 버튼은 제출 중 막는다(중복 클릭 방지).
     제출 키(sid)는 페이지마다 하나 — 응답을 못 받아 다시 눌러도 서버는 한 번만 저장한다.
     서버가 "표시 후 5초 안 제출"을 거절하므로, 그보다 빨리 누르면 남은 시간만큼 기다렸다 보낸다
   · 개인정보는 콘솔에 남기지 않는다 */
(function () {
  const root = document.getElementById('svfRoot');
  if (!root) return;
  const LOAD_TIMEOUT_MS = 25000, SUBMIT_TIMEOUT_MS = 180000, MIN_FILL_MS = 5500;
  const sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  const K = window.SurveyKit, esc = K.esc;

  // 주소창 → 무엇을 열지
  function target() {
    const m = /^\/s\/([^/?#]+)\/?$/.exec(location.pathname);
    if (m) { try { return { slug: decodeURIComponent(m[1]).toLowerCase() }; } catch (e) { return { slug: m[1].toLowerCase() }; } }
    const f = new URLSearchParams(location.search).get('f');
    return f ? { id: f } : null;
  }

  // Apps Script 호출 — 본문을 JSON 문자열로만(헤더를 붙이지 않아야 CORS 사전 요청이 생기지 않는다)
  async function call(action, data, timeoutMs) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(_getGasUrl(), { method: 'POST', body: JSON.stringify({ action, data }), signal: ac.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally { clearTimeout(timer); }
  }

  function state(icon, title, body, retry) {
    root.innerHTML = `<div class="svf svf-state-card"><div class="svf-state-ic">${icon}</div><h1 class="svf-state-title">${esc(title)}</h1>` +
      (body ? `<p class="svf-state-body">${body}</p>` : '') + (retry ? '<button type="button" class="svf-submit svf-retry">다시 시도</button>' : '') + '</div>';
    const b = root.querySelector('.svf-retry');
    if (b) b.onclick = load;
  }
  function closed(title) {
    if (title) document.title = title;
    state('🔒', '마감되었습니다', (title ? `<b>${esc(title)}</b><br>` : '') + '참여해주셔서 감사합니다. 응답 기간이 아니거나 모집이 끝난 설문입니다.');
  }

  let survey = null, token = '', shownAt = 0, ctl = null, done = false;

  async function load() {
    const t = target();
    if (!t) { closed(''); return; }
    root.innerHTML = '<div class="svf-state"><span class="svf-spin"></span><p>설문을 불러오는 중…</p></div>';
    let j = null;
    for (let i = 0; i < 2 && !j; i++) {
      try { j = await call('survey_getPublic', t, LOAD_TIMEOUT_MS); } catch (e) { if (i === 1) { state('⚠️', '설문을 불러오지 못했습니다', '네트워크 상태를 확인한 뒤 다시 시도해주세요.', true); return; } }
    }
    if (!j || j.error) { state('⚠️', '설문을 불러오지 못했습니다', '잠시 후 다시 시도해주세요.', true); return; }
    // 이전 주소로 들어왔으면 주소창만 지금 주소로(이미 받은 설문으로 그대로 그린다)
    if (t.slug && j.slug && j.slug !== t.slug && history.replaceState) history.replaceState(null, '', '/s/' + encodeURIComponent(j.slug) + location.search + location.hash);
    if (j.closed || !j.survey) { closed(j.title || ''); return; }
    survey = j.survey; token = j.token; shownAt = Date.now();
    document.title = survey.title;
    ctl = K.mountForm(root, survey, { uid: 'svf', onSubmit: submit });
  }

  async function submit(payload) {
    if (done) return;
    ctl.setFormError('');
    const hasFiles = payload.files.length > 0;
    ctl.busy(true, hasFiles ? '사진 올리는 중…' : '제출 중…');
    try {
      const files = [];
      for (const f of payload.files) files.push({ q: f.q, data: await K.blobToBase64(f.blob) });
      const wait = shownAt + MIN_FILL_MS - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const j = await call('survey_submit', { surveyId: survey.id, token, hp: payload.hp, sid, answers: payload.answers, files }, SUBMIT_TIMEOUT_MS);
      if (j && j.success) { done = true; thanks(j.thanks || survey.thanks); return; }
      const code = j && j.code;
      if (code === 'INVALID') { ctl.showErrors(j.fields || {}); ctl.setFormError(j.error || '입력 내용을 확인해주세요.'); }
      else if (code === 'CLOSED') { done = true; closed(survey.title); return; }
      else ctl.setFormError((j && j.error) || '제출하지 못했습니다. 잠시 후 다시 시도해주세요.');
    } catch (e) {
      ctl.setFormError(e.message === 'TIMEOUT'
        ? '응답이 늦어지고 있습니다. 입력한 내용은 그대로 있으니 잠시 후 [제출하기]를 다시 눌러주세요(두 번 저장되지 않습니다).'
        : '네트워크 문제로 제출하지 못했습니다. 입력한 내용은 그대로 있으니 [제출하기]를 다시 눌러주세요.');
    }
    if (!done) ctl.busy(false);
  }

  function thanks(text) {
    root.innerHTML = `<div class="svf svf-state-card svf-done"><div class="svf-state-ic">✅</div><h1 class="svf-state-title">제출이 완료되었습니다</h1>
      <p class="svf-state-body">${esc(text || '참여해주셔서 감사합니다.').replace(/\n/g, '<br>')}</p></div>`;
    window.scrollTo(0, 0);
  }

  load();
})();
