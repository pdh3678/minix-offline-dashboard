import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createFileBlockConfig, fileParse } from '@blocknote/core';
import { createReactBlockSpec, FileBlockWrapper } from '@blocknote/react';
import {
  isHtmlFile, isHtmlFileBlock, htmlSource, buildSrcdoc, heightFromMessage, clampHeight,
  loadHtmlContent, HEIGHT_INITIAL, HEIGHT_MIN, HEIGHT_MAX,
} from './htmlEmbed.js';

/* HTML 파일 임베드 (노션 스타일: 파일명 헤더 + 렌더링된 미리보기 + 캡션)
   기본 file 블록을 같은 type('file')으로 덮어쓴다 — 새 블록 타입을 만들면 이미 저장된 HTML 파일 블록이
   옛 모양 그대로 남고, 업로드/드롭/캡션/교체 같은 기본 파일 블록 기능도 다시 이어 붙여야 한다.
   props는 기본 file 블록 그대로 + embedView('embed'|'file') + embedHeight(0 = 자동). HTML이 아닌 파일은
   기본 모양(FileBlockWrapper) 그대로 그린다.

   ⚠ 보안 원칙 — HTML은 sandbox="allow-scripts" iframe의 srcdoc로만 그린다.
     allow-same-origin을 넣으면 iframe이 대시보드와 같은 출처가 되어 세션 토큰(localStorage)·쿠키·부모 DOM에
     그대로 닿는다. allow-top-navigation/forms/popups도 넣지 않는다. blob URL이나 같은 출처 새 창으로 여는
     기능도 만들지 않는다(그 순간 스크립트가 대시보드 출처로 실행된다). 다운로드는 Drive 주소로 받는다. */
const SANDBOX = 'allow-scripts';

const fileConfig = createFileBlockConfig();
const htmlAwareFileConfig = {
  ...fileConfig,
  propSchema: {
    ...fileConfig.propSchema,
    embedView: { default: 'embed', values: ['embed', 'file'] },
    embedHeight: { default: 0 },
  },
};

function FileIcon() {
  return (
    <svg className="rv2-html-embed-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm4 18H6V4h7v5h5v11ZM8.7 12.3 6.9 14l1.8 1.7-.9.9L5.1 14l2.7-2.6.9.9Zm6.6 0 .9-.9 2.7 2.6-2.7 2.6-.9-.9 1.8-1.7-1.8-1.7ZM12.6 11l1 .3-2.2 6.7-1-.3 2.2-6.7Z" />
    </svg>
  );
}

function openDownload(url) {
  // 새 탭 + noopener: 열린 쪽이 window.opener로 대시보드에 닿지 못하게
  window.open(url, '_blank', 'noopener,noreferrer');
}

function FullscreenModal({ name, load, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="rv2-html-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rv2-html-modal-box" role="dialog" aria-label={name}>
        <div className="rv2-html-modal-hd">
          <FileIcon />
          <span className="rv2-html-embed-name">{name}</span>
          <button type="button" className="rv2-html-embed-btn" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        {load.status === 'ready' ? (
          <iframe className="rv2-html-modal-frame" title={name} sandbox={SANDBOX} srcDoc={load.srcdoc} referrerPolicy="no-referrer" />
        ) : (
          <div className="rv2-html-modal-msg">{load.status === 'loading' ? '불러오는 중…' : '미리보기를 불러오지 못했습니다'}</div>
        )}
      </div>
    </div>,
    document.body
  );
}

function HtmlEmbed({ block, editor }) {
  const { name, url, caption, embedView, embedHeight } = block.props;
  const source = htmlSource(url);
  const isEmbed = embedView !== 'file';
  const [load, setLoad] = useState({ status: 'loading' }); // loading | ready | error
  const [autoHeight, setAutoHeight] = useState(HEIGHT_INITIAL);
  const [dragHeight, setDragHeight] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [reuploading, setReuploading] = useState(false);
  const frameRef = useRef(null);
  const menuRef = useRef(null);
  const dragRef = useRef(null);
  const fileInputRef = useRef(null);

  // 파일 블록 보기에서는 전체 화면을 열 때만 원문을 받는다(임베드 보기에서 전체 화면을 열고 닫아도 재요청 없음)
  const wantContent = isEmbed || fullscreen;
  useEffect(() => {
    if (!wantContent) return undefined;
    let alive = true;
    setLoad({ status: 'loading' });
    loadHtmlContent(url).then(
      (html) => { if (alive) setLoad({ status: 'ready', srcdoc: buildSrcdoc(html) }); },
      (err) => { if (alive) setLoad({ status: 'error', code: err.code || '', message: err.message }); }
    );
    return () => { alive = false; };
  }, [url, wantContent]);

  useEffect(() => {
    const onMessage = (e) => {
      const h = heightFromMessage(e, frameRef.current && frameRef.current.contentWindow);
      if (h != null) setAutoHeight(clampHeight(h));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  const height = dragHeight != null ? dragHeight : embedHeight > 0 ? clampHeight(embedHeight) : autoHeight;
  const canDownload = source.kind !== 'local';
  const canReupload = source.kind !== 'drive';

  // 높이 드래그 — 포인터 캡처로 iframe 위를 지나가도 이벤트를 놓치지 않게(드래그 중엔 iframe 포인터도 끈다)
  const onResizeDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: height };
    setDragHeight(height);
  };
  const onResizeMove = (e) => {
    if (!dragRef.current) return;
    setDragHeight(clampHeight(dragRef.current.startH + e.clientY - dragRef.current.startY));
  };
  const onResizeUp = (e) => {
    if (!dragRef.current) return;
    const h = clampHeight(dragRef.current.startH + e.clientY - dragRef.current.startY);
    dragRef.current = null;
    editor.updateBlock(block.id, { props: { embedHeight: h } });
    setDragHeight(null);
  };

  const onMenu = (fn) => () => { setMenuOpen(false); fn(); };

  const onReuploadPicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !isHtmlFile(file) || !editor.uploadFile) return;
    setReuploading(true);
    try {
      const res = await editor.uploadFile(file, block.id);
      if (editor.getBlock(block.id)) editor.updateBlock(block.id, typeof res === 'string' ? { props: { url: res, name: file.name } } : res);
    } catch (err) {
      /* 실패 안내는 uploadFile(imageUpload.js)이 토스트로 이미 띄웠다 */
    } finally {
      setReuploading(false);
    }
  };

  const errorDetail =
    load.code === 'LOCAL' ? '작성자 PC의 파일 경로(file:///…)로만 연결되어 있어 다른 사람은 열 수 없습니다. 파일을 다시 올리면 미리보기가 표시됩니다.'
    : load.code === 'TOO_LARGE' ? '파일이 5MB를 넘어 미리보기를 표시하지 않습니다.'
    : load.message || '';

  return (
    <div className="rv2-html-embed" contentEditable={false} draggable={false}>
      <div className="rv2-html-embed-hd">
        <FileIcon />
        <span className="rv2-html-embed-name" title={name}>{name || url}</span>
        <div className="rv2-html-embed-menu" ref={menuRef}>
          <button type="button" className="rv2-html-embed-btn" aria-label="메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>…</button>
          {menuOpen && (
            <div className="rv2-html-embed-pop" role="menu">
              <button type="button" role="menuitem" onClick={onMenu(() => setFullscreen(true))}>전체 화면 보기</button>
              <button type="button" role="menuitem" disabled={!canDownload} onClick={onMenu(() => openDownload(url))}>다운로드</button>
              <button type="button" role="menuitem" onClick={onMenu(() => editor.updateBlock(block.id, { props: { embedView: isEmbed ? 'file' : 'embed' } }))}>
                {isEmbed ? '파일 블록으로 보기' : '임베드로 보기'}
              </button>
              {canReupload && <button type="button" role="menuitem" onClick={onMenu(() => fileInputRef.current && fileInputRef.current.click())}>파일 다시 올리기</button>}
              <button type="button" role="menuitem" className="danger" onClick={onMenu(() => editor.removeBlocks([block.id]))}>삭제</button>
            </div>
          )}
        </div>
        <input ref={fileInputRef} type="file" accept=".html,.htm,text/html" hidden onChange={onReuploadPicked} />
      </div>

      {isEmbed && (
        <div className="rv2-html-embed-card">
          <div className="rv2-html-embed-body" style={load.status === 'error' && !reuploading ? undefined : { height }}>
            {reuploading || load.status === 'loading' ? (
              <div className="rv2-html-embed-skeleton">{reuploading ? '업로드 중…' : ''}</div>
            ) : load.status === 'error' ? (
              <div className="rv2-html-embed-error">
                <div className="rv2-html-embed-error-title">미리보기를 불러오지 못했습니다</div>
                {errorDetail && <div className="rv2-html-embed-error-detail">{errorDetail}</div>}
                <div className="rv2-html-embed-error-actions">
                  {canDownload && url && <button type="button" className="rv2-btn-cancel" onClick={() => openDownload(url)}>다운로드</button>}
                  {canReupload && <button type="button" className="rv2-btn-cancel" onClick={() => fileInputRef.current && fileInputRef.current.click()}>파일 다시 올리기</button>}
                </div>
              </div>
            ) : (
              <iframe
                ref={frameRef}
                className="rv2-html-embed-frame"
                title={name}
                sandbox={SANDBOX}
                srcDoc={load.srcdoc}
                referrerPolicy="no-referrer"
                style={dragHeight != null ? { pointerEvents: 'none' } : undefined}
              />
            )}
          </div>
          {load.status === 'ready' && (
            <button
              type="button"
              className={'rv2-html-embed-resize' + (dragHeight != null ? ' active' : '')}
              aria-label={'높이 조절 (' + HEIGHT_MIN + '~' + HEIGHT_MAX + 'px, 두 번 누르면 자동 높이)'}
              title="드래그해서 높이 조절 · 두 번 누르면 자동 높이"
              onPointerDown={onResizeDown}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeUp}
              onDoubleClick={() => editor.updateBlock(block.id, { props: { embedHeight: 0 } })}
            />
          )}
        </div>
      )}

      {caption && <div className="bn-file-caption rv2-html-embed-caption">{caption}</div>}
      {fullscreen && <FullscreenModal name={name} load={load} onClose={() => setFullscreen(false)} />}
    </div>
  );
}

function FileBlockView(props) {
  // url이 비었으면(업로드 중·아직 파일 없음) 기본 래퍼가 로딩 표시/파일 추가 버튼을 그린다
  if (props.block.props.url && isHtmlFileBlock(props.block)) return <HtmlEmbed {...props} />;
  return <FileBlockWrapper {...props} />;
}

// 복사·내보내기용 HTML은 기본 file 블록과 같다(링크 + 캡션) — 원문을 절대 섞지 않는다
function FileExternalHTML({ block }) {
  if (!block.props.url) return <p>Add file</p>;
  const link = <a href={block.props.url}>{block.props.name || block.props.url}</a>;
  if (!block.props.caption) return link;
  return <div>{link}<p>{block.props.caption}</p></div>;
}

export const htmlAwareFileBlockSpec = createReactBlockSpec(htmlAwareFileConfig, {
  meta: { fileBlockAccept: ['*/*'] },
  parse: fileParse(),
  render: FileBlockView,
  toExternalHTML: FileExternalHTML,
})();
