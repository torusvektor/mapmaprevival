/*
 * MapMap Web - small UI widgets: menus, context menus, modal dialogs, toasts.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { icon } from './icons.js';
import { t } from '../i18n.js';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let openMenuState = null;

export function closeMenu() {
  if (!openMenuState) return;
  const { el, cleanup, onClose } = openMenuState;
  openMenuState = null;
  cleanup();
  el.remove();
  if (onClose) onClose();
}

/**
 * Shows a menu. items: [{ label, icon, shortcut, checked, disabled, action } | { separator: true } | { header }]
 * Position with { x, y } (client coordinates) or { anchor: element }.
 * On narrow screens the menu is shown as a bottom sheet.
 */
export function showMenu(items, { x = 0, y = 0, anchor = null, doc = document, onClose = null, sheet = null } = {}) {
  closeMenu();
  const win = doc.defaultView;
  const useSheet = sheet ?? win.innerWidth < 600;
  // Only accept clicks that started inside the menu (a long press that opened the menu
  // is followed by a synthesized click when the finger is lifted). Keyboard clicks have detail 0.
  let armed = false;
  const el = doc.createElement('div');
  el.className = 'menu' + (useSheet ? ' menu-sheet' : '');
  el.setAttribute('role', 'menu');
  el.addEventListener('pointerdown', () => { armed = true; });
  const list = doc.createElement('div');
  list.className = 'menu-list';
  el.appendChild(list);

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      const sep = doc.createElement('div');
      sep.className = 'menu-sep';
      list.appendChild(sep);
      continue;
    }
    if (item.header) {
      const h = doc.createElement('div');
      h.className = 'menu-header';
      h.textContent = item.header;
      list.appendChild(h);
      continue;
    }
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
    if (item.checked !== undefined) b.setAttribute('aria-checked', item.checked ? 'true' : 'false');
    b.disabled = !!item.disabled;
    const check = item.checked !== undefined ? `<span class="menu-check">${item.checked ? icon('check') : ''}</span>` : '<span class="menu-check"></span>';
    b.innerHTML = `${check}<span class="menu-icon">${item.icon ? icon(item.icon) : ''}</span><span class="menu-label">${escapeHtml(item.label)}</span><span class="menu-shortcut">${escapeHtml(item.shortcut || '')}</span>`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!armed && e.detail !== 0) return;
      closeMenu();
      if (item.action) item.action();
    });
    list.appendChild(b);
  }

  if (useSheet) {
    const backdrop = doc.createElement('div');
    backdrop.className = 'menu-backdrop';
    backdrop.appendChild(el);
    doc.body.appendChild(backdrop);
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) { e.preventDefault(); closeMenu(); } });
    openMenuState = {
      el: backdrop,
      onClose,
      cleanup: () => doc.removeEventListener('keydown', onKey, true),
    };
  } else {
    doc.body.appendChild(el);
    const vw = win.innerWidth, vh = win.innerHeight;
    let left = x, top = y;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = r.left;
      top = r.bottom + 2;
    }
    const mr = el.getBoundingClientRect();
    if (left + mr.width > vw - 4) left = Math.max(4, vw - mr.width - 4);
    if (top + mr.height > vh - 4) top = Math.max(4, (anchor ? anchor.getBoundingClientRect().top - mr.height - 2 : vh - mr.height - 4));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const onDown = (e) => {
      if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) closeMenu();
    };
    setTimeout(() => doc.addEventListener('pointerdown', onDown, true), 0);
    openMenuState = {
      el,
      onClose,
      cleanup: () => {
        doc.removeEventListener('pointerdown', onDown, true);
        doc.removeEventListener('keydown', onKey, true);
      },
    };
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buttons = [...el.querySelectorAll('.menu-item:not(:disabled)')];
      const i = buttons.indexOf(doc.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[n]?.focus();
    }
  };
  doc.addEventListener('keydown', onKey, true);
  return el;
}

export function isMenuOpen() { return !!openMenuState; }

/* ---------------------------------------------------------------- modal */

/**
 * Opens a modal dialog. body can be a string (HTML) or an element.
 * buttons: [{ label, value, primary, danger }]. Resolves with the clicked value
 * (or null when dismissed).
 */
export function openModal({ title = '', body = '', buttons = [{ label: t('common.ok'), value: true, primary: true }], doc = document, className = '', onOpen = null, dismissible = true } = {}) {
  return new Promise((resolve) => {
    const backdrop = doc.createElement('div');
    backdrop.className = 'modal-backdrop';
    const dlg = doc.createElement('div');
    dlg.className = 'modal ' + className;
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    const head = doc.createElement('div');
    head.className = 'modal-head';
    head.innerHTML = `<h2>${escapeHtml(title)}</h2>`;
    if (dismissible) {
      const x = doc.createElement('button');
      x.type = 'button';
      x.className = 'icon-btn modal-close';
      x.setAttribute('aria-label', t('common.close'));
      x.innerHTML = icon('close');
      x.addEventListener('click', () => close(null));
      head.appendChild(x);
    }
    const content = doc.createElement('div');
    content.className = 'modal-body';
    if (typeof body === 'string') content.innerHTML = body;
    else if (body) content.appendChild(body);
    const foot = doc.createElement('div');
    foot.className = 'modal-foot';
    for (const b of buttons) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(typeof b.value === 'function' ? b.value(content) : b.value));
      foot.appendChild(btn);
    }
    dlg.append(head, content);
    if (buttons.length) dlg.appendChild(foot);
    backdrop.appendChild(dlg);
    doc.body.appendChild(backdrop);

    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        const primary = buttons.find((b) => b.primary);
        if (primary) { e.preventDefault(); close(typeof primary.value === 'function' ? primary.value(content) : primary.value); }
      }
      e.stopPropagation();
    };
    doc.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissible) close(null); });

    function close(value) {
      doc.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(value);
    }
    if (onOpen) onOpen(content, close);
    const focusable = content.querySelector('input, select, textarea') || foot.querySelector('.btn-primary');
    if (focusable) setTimeout(() => { focusable.focus(); if (focusable.select) focusable.select(); }, 30);
  });
}

export function alertDialog(message, { title = 'MapMap', doc } = {}) {
  return openModal({ title, body: `<p>${escapeHtml(message)}</p>`, doc });
}

export async function confirmDialog(message, { title = 'MapMap', ok = t('common.ok'), cancel = t('common.cancel'), danger = false, doc } = {}) {
  const r = await openModal({
    title,
    body: `<p>${escapeHtml(message)}</p>`,
    buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: true, danger }],
    doc,
  });
  return r === true;
}

export async function promptDialog(label, value = '', { title = 'MapMap', doc } = {}) {
  const r = await openModal({
    title,
    body: `<label class="field"><span>${escapeHtml(label)}</span><input type="text" class="input" value="${escapeHtml(value)}"></label>`,
    buttons: [{ label: t('common.cancel'), value: null }, { label: t('common.ok'), primary: true, value: (c) => c.querySelector('input').value }],
    doc,
  });
  return r;
}

/* ---------------------------------------------------------------- toast */

export function toast(message, { timeout = 2600, doc = document, kind = '' } = {}) {
  let root = doc.getElementById('toast-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'toast-root';
    doc.body.appendChild(root);
  }
  const el = doc.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

/** Opens the native file picker. Resolves with an array of Files (possibly empty). */
export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

/** Triggers a download of a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
}
