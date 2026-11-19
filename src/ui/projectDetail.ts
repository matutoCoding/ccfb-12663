// 项目详情页:方案列表、新建(选模型)、导入导出、对比入口
import { store } from '../store.js';
import { el, download } from '../util.js';
import { BUILTIN_MODELS } from '../geometry.js';
import { ModelSource, Scheme } from '../types.js';

export function renderProjectDetail(root: HTMLElement, projectId: string): () => void {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) { root.textContent = '项目不存在'; return () => undefined; }
  const compareSel = new Set<string>();

  const newSchemeDialog = () => {
    const overlay = el('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10' });
    const box = el('div', { class: 'panel', style: 'width:420px' });
    box.append(el('h3', {}, '新建方案 — 选择模型'));
    const nameInput = el('input', { type: 'text', value: '方案 ' + (store.schemesOf(projectId).length + 1), style: 'width:100%;margin-bottom:10px' });
    box.append(nameInput);
    const list = el('div', {});
    let chosen: ModelSource | null = null;
    const refresh = () => {
      list.innerHTML = '';
      for (const m of BUILTIN_MODELS) {
        const item = el('div', { class: 'defect-item' },
          el('strong', {}, m.name), el('span', { class: 'muted' }, ' ' + m.desc));
        item.onclick = () => {
          chosen = { kind: 'builtin', builtinId: m.id };
          list.querySelectorAll('.defect-item').forEach(x => (x as HTMLElement).style.borderColor = '');
          item.style.borderColor = 'var(--accent)';
        };
        list.append(item);
      }
      const up = el('div', { class: 'defect-item' }, el('strong', {}, '导入 STL 文件'), el('span', { class: 'muted' }, ' 支持 ASCII / 二进制'));
      up.onclick = () => {
        const input = el('input', { type: 'file', accept: '.stl' });
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          chosen = { kind: 'stl', fileName: f.name, stlText: btoa(bin) };
          list.querySelectorAll('.defect-item').forEach(x => (x as HTMLElement).style.borderColor = '');
          up.style.borderColor = 'var(--accent)';
          up.querySelector('.muted')!.textContent = ' 已选择:' + f.name;
        };
        input.click();
      };
      list.append(up);
    };
    refresh();
    box.append(list);
    const btns = el('div', { class: 'row', style: 'margin-top:12px' },
      (() => {
        const b = el('button', { class: 'primary' }, '创建');
        b.onclick = async () => {
          if (!chosen) { alert('请先选择模型'); return; }
          const s = await store.createScheme(projectId, nameInput.value || '新方案', chosen);
          overlay.remove();
          location.hash = '#/scheme/' + s.id;
        };
        return b;
      })(),
      (() => { const b = el('button', {}, '取消'); b.onclick = () => overlay.remove(); return b; })(),
    );
    box.append(btns);
    overlay.append(box);
    document.body.append(overlay);
  };

  const draw = () => {
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(el('div', { class: 'toolbar' },
      el('a', { href: '#/projects' }, '← 返回'),
      el('h2', {}, project.name),
      el('span', { class: 'spacer' }),
      (() => { const b = el('button', { class: 'primary' }, '+ 新建方案'); b.onclick = newSchemeDialog; return b; })(),
      (() => {
        const b = el('button', {}, '导入方案包');
        b.onclick = () => {
          const input = el('input', { type: 'file', accept: '.json' });
          input.onchange = async () => {
            const f = input.files?.[0];
            if (!f) return;
            try {
              const s = await store.importScheme(projectId, await f.text());
              alert(`已导入方案「${s.name}」`);
            } catch (e) { alert('导入失败:' + (e as Error).message); }
          };
          input.click();
        };
        return b;
      })(),
      (() => {
        const b = el('button', {}, '对比选中方案');
        b.onclick = () => {
          if (compareSel.size !== 2) { alert('请勾选恰好两个方案进行对比'); return; }
          const [a, c] = [...compareSel];
          location.hash = `#/compare/${a}/${c}`;
        };
        return b;
      })(),
    ));

    const schemes = store.schemesOf(projectId);
    if (schemes.length === 0) panel.append(el('p', { class: 'muted' }, '还没有方案,点击「新建方案」开始。'));
    const table = el('table', { class: 'list' });
    table.append(el('tr', {},
      el('th', {}, ''), el('th', {}, '方案名'), el('th', {}, '模型'), el('th', {}, '浇口数'),
      el('th', {}, '材料'), el('th', {}, '更新时间'), el('th', {}, '操作')));
    for (const s of schemes) {
      const modelName = s.model.kind === 'builtin'
        ? (BUILTIN_MODELS.find(m => m.id === (s.model as { builtinId: string }).builtinId)?.name ?? '内置模型')
        : (s.model as { fileName: string }).fileName;
      const mat = store.materials.find(m => m.id === s.materialId);
      const cb = el('input', { type: 'checkbox' });
      cb.onchange = () => { cb.checked ? compareSel.add(s.id) : compareSel.delete(s.id); };
      const tr = el('tr', {},
        el('td', {}, cb),
        el('td', {}, s.name),
        el('td', {}, modelName),
        el('td', {}, String(s.gates.length)),
        el('td', {}, mat?.name ?? '—'),
        el('td', { class: 'muted' }, new Date(s.updatedAt).toLocaleString('zh-CN')),
        el('td', {},
          (() => { const b = el('button', { class: 'small primary' }, '编辑'); b.onclick = () => { location.hash = '#/scheme/' + s.id; }; return b; })(),
          ' ',
          (() => { const b = el('button', { class: 'small' }, '复制'); b.onclick = () => store.duplicateScheme(s.id); return b; })(),
          ' ',
          (() => {
            const b = el('button', { class: 'small' }, '导出');
            b.onclick = () => download(s.name + '.moldfill.json', store.exportScheme(s.id), 'application/json');
            return b;
          })(),
          ' ',
          (() => {
            const b = el('button', { class: 'small danger' }, '删除');
            b.onclick = async () => { if (confirm(`删除方案「${s.name}」?`)) await store.deleteScheme(s.id); };
            return b;
          })(),
        ),
      );
      table.append(tr);
    }
    panel.append(table);
    root.append(panel);
  };
  draw();
  return store.onChange(draw);
}
