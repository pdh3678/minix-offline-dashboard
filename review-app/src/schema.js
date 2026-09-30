import { BlockNoteSchema, combineByGroup, createCodeBlockSpec, defaultStyleSpecs } from '@blocknote/core';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import * as coreLocales from '@blocknote/core/locales';
import { codeBlockOptions } from '@blocknote/code-block';
import { getDefaultReactSlashMenuItems } from '@blocknote/react';
import {
  getMultiColumnSlashMenuItems,
  multiColumnDropCursor,
  locales as multiColumnLocales,
  withMultiColumn,
} from '@blocknote/xl-multi-column';
import { calloutBlockSpec, insertCallout } from './callout.js';
import { htmlAwareFileBlockSpec } from './htmlEmbedBlock.jsx';

// 인라인 코드(code 스타일)는 @tiptap/extension-code 기본 설정이 excludes:'_'라 다른 모든
// 마크(볼드/이탤릭/밑줄/취소선)와 배타적 — 노션과 달리 코드에 볼드를 얹을 수 없었음. 이건
// BlockNote가 만든 제약이 아니라 Tiptap 자체의 기본값을 그대로 물려받은 것(BlockNote의
// code 스타일 구현이 addInputRules만 덮어쓰고 excludes는 안 건드림 — 소스로 확인). 백틱
// 입력 규칙 등 BlockNote가 이미 확장해둔 부분은 그대로 이어받고 excludes만 빈 문자열로
// 덮어써 다른 마크와 중첩 가능하게 함(Tiptap 커뮤니티에 알려진 방식 — 위험한 우회 아님).
const codeMarkWithNesting = defaultStyleSpecs.code.implementation.mark.extend({ excludes: '' });
const codeStyleSpec = {
  config: defaultStyleSpecs.code.config,
  implementation: { ...defaultStyleSpecs.code.implementation, mark: codeMarkWithNesting },
};

// 다단(2/3열) — 열 블록의 children은 일반 Block[]이라 제목/목록/할일 등 임의 블록이 그대로
// 들어감(자체 구현 시절의 "문단 전용" 한계가 여기서 해소됨). column/columnList 타입 추가.
// codeBlock은 기본 스키마에도 이미 있지만(슬래시 메뉴엔 "코드 블록"으로 노출) 구문 강조/언어
// 목록이 없는 민짜 버전 — @blocknote/code-block의 옵션(Shiki 하이라이터 + 언어 약 50종)으로
// 교체해 노션과 동등한 코드 블록으로 만듦.
// file은 같은 type 그대로 HTML 임베드(파일명 헤더 + sandbox 미리보기 + 캡션)를 얹은 버전으로 교체 — htmlEmbedBlock.jsx.
export const schema = withMultiColumn(
  BlockNoteSchema.create().extend({
    blockSpecs: { codeBlock: createCodeBlockSpec(codeBlockOptions), callout: calloutBlockSpec, file: htmlAwareFileBlockSpec },
    styleSpecs: { code: codeStyleSpec },
  })
);

export const dropCursor = multiColumnDropCursor;

// 공식 예제의 병합 형태 그대로 — multi_column 하위 키에 컬럼 전용 사전을 얹음
export const dictionary = {
  ...coreLocales.ko,
  multi_column: multiColumnLocales.ko,
};

// 기본 슬래시 메뉴 + 컬럼(2열/3열) 항목을 합쳐서 반환 — BlockNoteView에는 slashMenu={false}로
// 내장 메뉴를 끄고 이 함수를 SuggestionMenuController에 넘겨야 함(공식 예제 패턴).
export function makeGetSlashMenuItems(editor) {
  const calloutItem = {
    title: '콜아웃',
    subtext: '강조 박스 안에 여러 블록을 자유롭게 작성',
    aliases: ['callout', '콜아웃', '박스', '강조'],
    group: '기본 블록',
    icon: '💡',
    onItemClick: () => insertCallout(editor),
  };
  return async (query) =>
    filterSuggestionItems(
      combineByGroup(getDefaultReactSlashMenuItems(editor), [calloutItem], getMultiColumnSlashMenuItems(editor)),
      query
    );
}
