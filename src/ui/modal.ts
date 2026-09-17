export interface ModalOptions {
  title: string;
  body?: string | string[];
  confirmLabel?: string;
  /** Pass null for an informational modal with a single button. */
  cancelLabel?: string | null;
  tone?: 'default' | 'warn';
}

let activeModal: HTMLElement | null = null;
let activeResolve: ((confirmed: boolean) => void) | null = null;

function closeActive(confirmed: boolean): void {
  const modal = activeModal;
  const resolve = activeResolve;
  activeModal = null;
  activeResolve = null;
  if (!modal) return;
  modal.classList.remove('is-open');
  window.setTimeout(() => modal.remove(), 200);
  resolve?.(confirmed);
}

/** Promise-based modal. Resolves true on confirm, false on cancel/scrim/escape. */
export function showModal(options: ModalOptions): Promise<boolean> {
  if (activeModal) closeActive(false);

  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';

  const modal = document.createElement('div');
  modal.className = `modal${options.tone === 'warn' ? ' modal-warn' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  title.className = 'modal-title';
  title.textContent = options.title;
  modal.append(title);

  const paragraphs = options.body === undefined ? [] : Array.isArray(options.body) ? options.body : [options.body];
  if (paragraphs.length > 0) {
    const body = document.createElement('div');
    body.className = 'modal-body';
    for (const text of paragraphs) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      body.append(paragraph);
    }
    modal.append(body);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  if (options.cancelLabel !== null) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = options.cancelLabel ?? 'Cancel';
    cancel.addEventListener('click', () => closeActive(false));
    actions.append(cancel);
  }

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = options.tone === 'warn' ? 'btn btn-warn' : 'btn btn-primary';
  confirm.textContent = options.confirmLabel ?? 'OK';
  confirm.addEventListener('click', () => closeActive(true));
  actions.append(confirm);
  modal.append(actions);

  scrim.append(modal);
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) closeActive(false);
  });
  document.body.append(scrim);
  activeModal = scrim;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
  confirm.focus({ preventScroll: true });

  return new Promise<boolean>((resolve) => {
    activeResolve = resolve;
  });
}

export async function showInfoModal(title: string, body: string | string[]): Promise<void> {
  await showModal({ title, body, confirmLabel: 'OK', cancelLabel: null });
}
