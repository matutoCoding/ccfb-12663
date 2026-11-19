// 项目列表页
import { store } from '../store.js';
import { el, download } from '../util.js';

export function renderProjects(root: HTMLElement): () => void {
  const draw = () => {
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(
      el('div', { class: 'toolbar' },
        el('h2', {}, '项目列表'),
        el('span', { class: 'spacer' }),
        (() => {
          const b = el('button', { class: 'primary' }, '+ 新建项目');
          b.onclick = async () => {
            const name = prompt('项目名称', '新项目');
            if (name) await store.createProject(name);
          };
          return b;
        })(),
      ),
    );
    if (store.projects.length === 0) {
      panel.append(el('p', { class: 'muted' }, '还没有项目,点击右上角新建。'));
    }
    const cards = el('div', { class: 'cards' });
    for (const p of [...store.projects].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const schemes = store.schemesOf(p.id);
      const card = el('div', { class: 'card' },
        el('h3', {}, p.name),
        el('p', { class: 'muted' }, `${schemes.length} 个方案 · 更新于 ${new Date(p.updatedAt).toLocaleString('zh-CN')}`),
        el('div', { class: 'row' },
          (() => { const b = el('button', { class: 'primary small' }, '打开'); b.onclick = () => { location.hash = '#/project/' + p.id; }; return b; })(),
          (() => {
            const b = el('button', { class: 'small' }, '复制');
            b.onclick = async () => {
              const np = await store.createProject(p.name + ' 副本');
              for (const s of schemes) {
                const copy = await store.duplicateScheme(s.id);
                if (copy) { copy.projectId = np.id; store.saveScheme(copy); }
              }
            };
            return b;
          })(),
          (() => {
            const b = el('button', { class: 'small danger' }, '删除');
            b.onclick = async () => {
              if (confirm(`删除项目「${p.name}」及其全部方案?`)) await store.deleteProject(p.id);
            };
            return b;
          })(),
        ),
      );
      cards.append(card);
    }
    panel.append(cards);
    root.append(panel);
  };
  draw();
  return store.onChange(draw);
}
