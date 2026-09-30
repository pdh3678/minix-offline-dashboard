// Drive 재업로드 — 기존 Editor.js 회고와 동일한 GAS 액션(uploadReviewImage/uploadReviewImageByUrl)을
// 그대로 재사용. 이미지 URL은 lh3.googleusercontent.com/d/<fileId>(조직 내 링크 공유)로 고정되어
// base64를 시트/응답에 남기지 않음.
import { isHtmlFile, uploadHtmlFile } from './htmlEmbed.js';

const UPLOAD_TIMEOUT_MS = 60000; // GAS 콜드스타트 + 전송 감안

// BlockNote uploadFile: 파일 선택/드롭/실제 파일 붙여넣기(스크린샷 등)에서 호출됨.
// HTML은 Drive 첨부 폴더에 원문 그대로 올리고 블록 props를 돌려준다(임베드 미리보기는 htmlEmbedBlock.jsx).
export function makeUploadFile(bridge) {
  return async function uploadFile(file) {
    if (isHtmlFile(file)) return uploadHtml(bridge, file);
    if (!file || !file.type || !file.type.startsWith('image/')) {
      throw new Error('이미지 또는 HTML 파일만 업로드할 수 있습니다.');
    }
    const res = await bridge.resizeImageToDataURL(file, 1400, 1400, 0.82);
    const j = await bridge.gasWrite(
      'uploadReviewImage',
      { base64: res.base64, mimeType: res.mimeType },
      { _timeoutMs: UPLOAD_TIMEOUT_MS }
    );
    if (!j || j.error || !j.url) throw new Error((j && j.error) || '이미지 업로드에 실패했습니다.');
    return j.url;
  };
}

// 파일 패널·드롭 경로(BlockNote)는 실패 사유를 화면에 안 보여줘서 토스트로 직접 알린다.
async function uploadHtml(bridge, file) {
  try {
    const r = await uploadHtmlFile(bridge, file);
    if (r.tooLarge) {
      bridge.showToast('5MB를 넘는 HTML은 미리보기 없이 파일로 첨부됩니다.');
      return { props: { name: r.name, url: r.url, embedView: 'file' } };
    }
    return { props: { name: r.name, url: r.url } };
  } catch (e) {
    bridge.showToast('HTML 업로드 실패: ' + e.message, { type: 'error' });
    throw e;
  }
}

// 노션 붙여넣기는 만료되는 S3 서명 URL을 img src로 그대로 물고 옴 — 그대로 저장하면 나중에
// 깨진 이미지가 됨. GAS가 서버(UrlFetchApp)에서 즉시 가져와 Drive에 영구 저장.
export async function reuploadExternalImage(bridge, url) {
  const j = await bridge.gasWrite('uploadReviewImageByUrl', { url }, { _timeoutMs: UPLOAD_TIMEOUT_MS });
  if (!j || j.error || !j.url) throw new Error((j && j.error) || '이미지 재업로드에 실패했습니다.');
  return j.url;
}

// 우리가 이미 Drive에 올려 lh3.googleusercontent.com 링크로 저장한 이미지인지 판별 —
// 재업로드 대상에서 제외해 같은 이미지를 편집할 때마다 매번 다시 올리는 것을 방지.
export function isDriveImageUrl(url) {
  return /^https:\/\/lh3\.googleusercontent\.com\//.test(String(url || ''));
}

// 문서 전체에서 image 블록을 재귀로 수집(컬럼 children까지 포함)
function collectImageBlocks(blocks, out) {
  (blocks || []).forEach((b) => {
    if (b.type === 'image' && b.props && b.props.url) out.push(b);
    if (b.children && b.children.length) collectImageBlocks(b.children, out);
  });
  return out;
}

// 붙여넣기 직후 호출 — 외부(비-Drive) URL을 가진 image 블록을 찾아 Drive로 재업로드하고
// 블록 URL을 교체. 실패한 이미지는 원본 링크를 유지(조용히 누락시키지 않음).
export async function reuploadExternalImagesInDocument(editor, bridge, onProgress) {
  const targets = collectImageBlocks(editor.document, []).filter((b) => !isDriveImageUrl(b.props.url));
  if (!targets.length) return { total: 0, failed: 0 };
  let failed = 0;
  await Promise.all(
    targets.map(async (block) => {
      try {
        const driveUrl = await reuploadExternalImage(bridge, block.props.url);
        editor.updateBlock(block.id, { props: { ...block.props, url: driveUrl } });
      } catch (e) {
        failed++;
        console.warn('[회고] 이미지 재업로드 실패 — 원본 링크 유지:', e);
      }
    })
  );
  if (onProgress) onProgress({ total: targets.length, failed });
  return { total: targets.length, failed };
}
