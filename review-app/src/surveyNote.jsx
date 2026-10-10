import { createRoot } from 'react-dom/client';
import {
  BlockNoteSchema,
  createBulletListItemBlockSpec,
  createHeadingBlockSpec,
  createNumberedListItemBlockSpec,
  createParagraphBlockSpec,
} from '@blocknote/core';
import * as coreLocales from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { reviewTheme } from './theme.js';

// 설문 안내문 편집기 — 대시보드 설문 관리(src/features/survey/survey-admin.js)가 안내문 블록마다 하나씩 띄운다.
// 응답 페이지는 이 번들을 받지 않고 저장된 블록 JSON을 SurveyKit.blocksHtml로 직접 그리므로, 그 렌더러가 아는 것만 허용한다:
// 문단·제목(1~3)·글머리표·번호 목록 + 기본 서식(굵게·기울임·밑줄·취소선·코드·글자색·배경색). 이모지는 ':'로 고른다(기본 이모지 선택기).
// GAS(_svCleanBlocks)가 저장할 때 같은 목록으로 한 번 더 거른다 — 세 곳의 목록을 같이 바꿀 것.
const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: createParagraphBlockSpec(),
    heading: createHeadingBlockSpec({ levels: [1, 2, 3] }),
    bulletListItem: createBulletListItemBlockSpec(),
    numberedListItem: createNumberedListItemBlockSpec(),
  },
});

function SurveyNoteEditor({ initialBlocks, onChange }) {
  const editor = useCreateBlockNote({
    schema,
    dictionary: coreLocales.ko,
    initialContent: Array.isArray(initialBlocks) && initialBlocks.length ? initialBlocks : undefined,
  });
  // portalElements default:null — 메뉴를 body로 빼서 대시보드 사이드바(z-index)에 가리지 않게(회고 편집기와 같은 이유)
  return (
    <BlockNoteView editor={editor} theme={reviewTheme} onChange={() => onChange(editor.document)} portalElements={{ default: null }} />
  );
}

// container에 편집기를 띄운다 — 반환값의 unmount()로 정리. 블록이 잘못돼 띄우지 못하면 예외를 그대로 던진다(호출부가 안내)
export function mountSurveyNote(container, opts) {
  const o = opts || {};
  const root = createRoot(container);
  root.render(<SurveyNoteEditor initialBlocks={o.initialBlocks} onChange={o.onChange || (() => {})} />);
  return { unmount: () => root.unmount() };
}
