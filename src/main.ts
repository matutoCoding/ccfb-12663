import './ui/styles.css';
import { store } from './core/store';
import { taskManager } from './core/task-manager';
import { AppShell } from './ui/app-shell';
import { h } from './ui/dom';

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app')!;
  const loading = h('div', { class: 'empty-state', style: { height: '100vh' } }, '正在初始化本地数据库…');
  root.append(loading);

  await store.init();
  await taskManager.init(store.state.settings);

  loading.remove();
  const shell = new AppShell(root);
  shell.navigate('projects');

  // 离开 page 前落盘，保证自动保存不丢
  window.addEventListener('beforeunload', () => {
    void store.flushSave();
  });
}

bootstrap().catch((e) => {
  const root = document.getElementById('app')!;
  root.innerHTML = '';
  root.append(
    h('div', { class: 'empty-state', style: { height: '100vh', padding: '40px', textAlign: 'center' } },
      h('div', { style: { fontSize: '40px' } }, '⚠️'),
      h('h2', {}, '应用启动失败'),
      h('pre', { style: { color: '#fca5a5', whiteSpace: 'pre-wrap', maxWidth: '680px' } }, (e as Error).stack ?? String(e)),
    ),
  );
});
