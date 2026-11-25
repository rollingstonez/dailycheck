import { useEffect, useState } from 'react';
import Home from './pages/Home';
import Inspect from './pages/Inspect';
import Records from './pages/Records';
import RecordDetail from './pages/RecordDetail';
import Report from './pages/Report';
import Checklists from './pages/Checklists';
import ChecklistEditor from './pages/ChecklistEditor';

/** 해시 주소(#/inspect/abc)로 화면 전환 — 서버 설정 없이 오프라인에서도 동작 */
function useRoute() {
  const get = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(get);
  useEffect(() => {
    const on = () => {
      setParts(get());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

/** 예: go('inspect', checklistId) — 각 부분은 자동으로 주소용으로 변환 */
export const go = (...parts: string[]) => {
  location.hash = '#/' + parts.map(encodeURIComponent).join('/');
};

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

const TABS = [
  { key: '', label: '오늘', icon: '✓' },
  { key: 'records', label: '기록', icon: '☰' },
  { key: 'report', label: '보고서', icon: '▤' },
  { key: 'checklists', label: '점검표', icon: '✎' },
];

export default function App() {
  const [page = '', a, b] = useRoute();
  const online = useOnline();

  let view;
  switch (page) {
    case 'inspect':
      view = <Inspect checklistId={a} recordId={b} />;
      break;
    case 'records':
      view = a ? <RecordDetail id={a} /> : <Records />;
      break;
    case 'report':
      view = <Report />;
      break;
    case 'checklists':
      view = a ? <ChecklistEditor id={a} /> : <Checklists />;
      break;
    default:
      view = <Home />;
  }

  const hideNav = page === 'inspect' || (page === 'checklists' && a);

  return (
    <>
      {!online && <div className="offline-bar no-print">인터넷 연결 없음 · 입력한 내용은 이 기기에 안전하게 저장됩니다</div>}
      <main className={hideNav ? '' : 'with-nav'}>{view}</main>
      {!hideNav && (
        <nav className="tabbar no-print">
          {TABS.map((t) => (
            <a key={t.key} href={'#/' + t.key} className={page === t.key ? 'on' : ''}>
              <span className="ico">{t.icon}</span>
              {t.label}
            </a>
          ))}
        </nav>
      )}
    </>
  );
}
