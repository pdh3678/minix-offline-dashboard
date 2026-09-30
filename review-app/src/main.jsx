import { createRoot } from 'react-dom/client';
import ReviewApp from './App.jsx';
import './styles.css';
import { setHtmlEmbedBridge } from './htmlEmbed.js';

let root = null;

// 해시 라우팅으로 회고 진입/이탈 시 바닐라 셸(index.html)이 호출 — container는 #reviewRoot,
// bridge는 기존 대시보드의 인증/네트워크 함수 묶음(같은 window라 별도 재구현 없이 재사용).
export function mount(container, bridge) {
  if (root) unmount();
  setHtmlEmbedBridge(bridge); // HTML 임베드 블록이 원문을 받을 때 쓴다(블록 렌더는 bridge를 props로 못 받음)
  root = createRoot(container);
  root.render(<ReviewApp bridge={bridge} />);
}

export function unmount() {
  if (!root) return;
  root.unmount();
  root = null;
}
