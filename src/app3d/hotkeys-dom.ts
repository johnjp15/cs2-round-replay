/**
 * W1 (#49): the round hotkeys' buttons in the Keys group ("Start Enter · Pause P · Restart Backspace×2") and the
 * tooltips of the Start / Pause / Restart buttons. Click one, press a key: the hotkey moves there (hotkeys3d.ts
 * rebindHotkey: game keys and browser keys are refused). Esc or a click elsewhere cancels. The press is swallowed.
 */
import { DEFAULT_HOTKEYS, HOTKEY_NAMES, PAGE_HOTKEYS, hotkeyHint, hotkeyLabel, rebindHotkey, type Hotkeys, type PageHotkey } from './hotkeys3d';

export class HotkeysDom {
  private readonly buttons = new Map<PageHotkey, HTMLButtonElement>();
  private capturing: PageHotkey | null = null;

  constructor(
    container: HTMLElement,
    private keys: Hotkeys,
    /** Codes the game's controls have (refused). */
    private readonly bound: (code: string) => boolean,
    private readonly onChange: (h: Hotkeys) => void,
    /** The page's Start / Pause / Restart buttons (their tooltips name the hotkeys). */
    private readonly targets: { readonly [K in PageHotkey]: HTMLButtonElement | null },
  ) {
    for (const k of PAGE_HOTKEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset['hotkey'] = k;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.capturing === k) this.stop();
        else this.start(k);
      });
      this.buttons.set(k, b);
      container.append(b);
    }
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('click', () => this.stop());
    window.addEventListener('blur', () => this.stop());
    this.render();
  }

  get hotkeys(): Hotkeys {
    return this.keys;
  }

  private start(k: PageHotkey): void {
    this.capturing = k;
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
    const k = this.capturing;
    if (k === null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') {
      this.stop();
      return;
    }
    const next = rebindHotkey(this.keys, k, e.code, this.bound);
    if (next === null) {
      const b = this.buttons.get(k);
      if (b !== undefined) b.title = `${hotkeyLabel(e.code)} is a game or browser key; pick one away from WASD and the mouse hand (F5–F10, Home, End, Insert, Delete, Page Up / Down, Enter, Backspace, the numpad, P, …).`;
      return;
    }
    this.keys = next;
    this.onChange(next);
    this.stop();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.capturing !== null) e.stopImmediatePropagation();
  };

  private render(): void {
    for (const [k, b] of this.buttons) {
      const on = this.capturing === k;
      b.setAttribute('aria-pressed', String(on));
      b.replaceChildren(HOTKEY_NAMES[k]);
      const kbd = document.createElement('kbd');
      kbd.textContent = on ? 'press a key…' : k === 'restart' ? `${hotkeyLabel(this.keys[k])}×2` : hotkeyLabel(this.keys[k]);
      b.append(kbd);
      if (!on) b.title = `${HOTKEY_NAMES[k]} the round: ${hotkeyHint(k, this.keys[k])} (default ${hotkeyHint(k, DEFAULT_HOTKEYS[k])}). Click, then press a new key.`;
      const t = this.targets[k];
      if (t !== null) t.title = `${HOTKEY_NAMES[k]}${k === 'pause' ? ' / Resume' : ''}: ${hotkeyHint(k, this.keys[k])}`;
    }
  }
}
