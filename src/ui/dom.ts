// 极简 hyperscript DOM 辅助（无框架依赖）
export type VChild = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: VChild[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.innerHTML = '';
}

export function mount(el: HTMLElement, ...nodes: Node[]): void {
  el.append(...nodes);
}

export function iconButton(title: string, icon: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  return h('button', { class: `btn icon-btn ${extraClass}`, title, onclick: onClick }, icon);
}

export function label(text: string, ...children: Node[]): HTMLLabelElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, text), ...children);
}

export function numberInput(value: number, step: number, onInput: (v: number) => void, min?: number): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    value: roundDisplay(value),
    step: String(step),
    oninput: () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && (min === undefined || v >= min)) onInput(v);
    },
  });
  return input;
}

function roundDisplay(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(8)));
}

export function select(options: { value: string; text: string }[], current: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = h('select', { onchange: () => onChange(sel.value) });
  for (const o of options) sel.append(h('option', { value: o.value, selected: o.value === current }, o.text));
  return sel;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', duration = 3200): void {
  const container = document.getElementById('toast-container') ?? Object.assign(document.createElement('div'), { id: 'toast-container' });
  if (!container.parentElement) document.body.append(container);
  const el = h('div', { class: `toast toast-${kind}` }, message);
  container.append(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

export function confirmDialog(message: string): boolean {
  return window.confirm(message);
}

export async function filePicker(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  });
}
