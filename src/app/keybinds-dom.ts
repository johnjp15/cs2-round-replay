/**
 * The key-binding buttons (both pages): "Duck Ctrl · Walk Shift · Jump Space · Use E · Reset". Click one, press a key:
 * that control moves to the key (a key another of the four had swaps; reserved keys are refused). Esc or a click
 * elsewhere cancels. The press is swallowed so it neither moves the pawn nor reaches the page's own keys.
 */
import { DEFAULT_KEY_BINDS, REBINDABLE, bindKeyOf, canBindKey, keyLabel, type KeyBinds, type RebindableControl } from './input';
import { DEFAULT_PAGE_KEYS, canBindPageKey, type KeyBindsStore, type PageKeysStore } from './keybinds';

const NAMES: { readonly [C in RebindableControl]: string } = { duck: 'Duck', walk: 'Walk', jump: 'Jump', use: 'Use' };

export class KeyBindsDom {
  private readonly buttons = new Map<RebindableControl, HTMLButtonElement>();
  private readonly reset: HTMLButtonElement;
  private capturing: RebindableControl | null = null;

  constructor(
    container: HTMLElement,
    private readonly store: KeyBindsStore,
    private readonly mac: boolean,
  ) {
    container.replaceChildren();
    const label = document.createElement('span');
    label.className = 'keys-label';
    label.textContent = 'Keys';
    label.title = 'Click a control, then press its new key. Ctrl is CS2’s duck; C also ducks.';
    container.append(label);
    for (const c of REBINDABLE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset['bind'] = c;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.capturing === c) this.stop();
        else this.start(c);
      });
      this.buttons.set(c, b);
      container.append(b);
    }
    this.reset = document.createElement('button');
    this.reset.type = 'button';
    this.reset.dataset['bindReset'] = '';
    this.reset.textContent = 'Reset keys';
    this.reset.addEventListener('click', () => {
      this.stop();
      store.reset();
      this.reset.blur();
    });
    container.append(this.reset);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('click', () => this.stop());
    window.addEventListener('blur', () => this.stop());
    store.onChange(() => this.render());
    this.render();
  }

  private start(c: RebindableControl): void {
    this.capturing = c;
    this.render();
  }

  private stop(): void {
    if (this.capturing === null) return;
    const b = this.buttons.get(this.capturing);
    this.capturing = null;
    this.render();
    b?.blur();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const c = this.capturing;
    if (c === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') {
      this.stop();
      return;
    }
    const key = bindKeyOf(e.code);
    if (!canBindKey(key)) {
      const b = this.buttons.get(c);
      if (b !== undefined) b.title = `${keyLabel(key, this.mac)} is taken by a fixed control or the page; pick another key.`;
      return;
    }
    this.store.set(c, e.code);
    this.stop();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.capturing !== null) e.stopImmediatePropagation();
  };

  private render(): void {
    const binds: KeyBinds = this.store.binds;
    for (const [c, b] of this.buttons) {
      const on = this.capturing === c;
      b.setAttribute('aria-pressed', String(on));
      b.replaceChildren(NAMES[c]);
      const k = document.createElement('kbd');
      k.textContent = on ? 'press a key…' : keyLabel(binds[c], this.mac);
      b.append(k);
      if (!on) b.title = `${NAMES[c]}: ${keyLabel(binds[c], this.mac)} (CS2 default ${keyLabel(DEFAULT_KEY_BINDS[c], this.mac)}). Click, then press a new key.`;
    }
    this.reset.disabled = REBINDABLE.every((c) => binds[c] === DEFAULT_KEY_BINDS[c]);
  }
}

// ---- U2: the take-cart key ("Take cart C"), beside the pawn controls ------------------------------------------------

/**
 * One more key-binding button, "Take cart C": the key that always takes control of cart while watching (keybinds.ts
 * PageKeysStore). Built after KeyBindsDom in the same container, before its Reset button; that Reset resets it too.
 * Click, press a key (Esc cancels; a key the page or a pawn control's Use / Jump has is refused).
 */
export class PageKeyDom {
  private readonly button: HTMLButtonElement;
  private readonly reset: HTMLButtonElement | null;
  private capturing = false;

  constructor(
    container: HTMLElement,
    private readonly store: PageKeysStore,
    private readonly binds: KeyBindsStore,
    private readonly mac: boolean,
  ) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset['bind'] = 'takeCart';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.capturing = !this.capturing;
      this.render();
    });
    this.button = b;
    const reset = container.querySelector<HTMLButtonElement>('[data-bind-reset]');
    this.reset = reset;
    container.insertBefore(b, reset);
    reset?.addEventListener('click', () => store.reset());
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('click', () => this.stop());
    window.addEventListener('blur', () => this.stop());
    store.onChange(() => this.render());
    this.render();
  }

  private stop(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.render();
    this.button.blur();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') {
      this.stop();
      return;
    }
    if (!canBindPageKey(e.code, this.binds.binds)) {
      this.button.title = `${keyLabel(bindKeyOf(e.code), this.mac)} is taken by a fixed control, Use, Jump or the page; pick another key.`;
      return;
    }
    this.store.setTakeCart(e.code);
    this.stop();
  };

  private render(): void {
    const k = this.store.keys.takeCart;
    this.button.setAttribute('aria-pressed', String(this.capturing));
    this.button.replaceChildren('Take cart');
    const cap = document.createElement('kbd');
    cap.textContent = this.capturing ? 'press a key…' : keyLabel(k, this.mac);
    this.button.append(cap);
    if (this.reset !== null && k !== DEFAULT_PAGE_KEYS.takeCart) this.reset.disabled = false;
    if (!this.capturing) this.button.title = `Take control of cart while watching, whoever you spectate: ${keyLabel(k, this.mac)} (default ${keyLabel(DEFAULT_PAGE_KEYS.takeCart, this.mac)}). Click, then press a new key.`;
  }
}
