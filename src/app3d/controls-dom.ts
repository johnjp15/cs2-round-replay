/**
 * H1: the DOM side of the first-person controls: held keys and mouse buttons (src/app/input.ts bindings), mouse
 * movement under pointer lock, and the extra keys of the 3D page. The mapping to PawnInput is input3d.ts.
 */
import { NO_CONTROLS, bindingForKey, bindingForMouseButton, type HeldControl, type HeldControls, type WeaponSlot } from '../app/input';

export interface ControlsHooks {
  /** A weapon slot press (1–5). */
  onSlot(slot: WeaponSlot): void;
  /** A key the page handles itself (E while watching, V, Z / X, P, …): return true to swallow it. */
  onKey(code: string): boolean;
  /** Mouse 1 went down (with pointer lock or not). */
  onFire(): void;
}

export class ControlsDom {
  private held: Record<HeldControl, boolean> = { ...NO_CONTROLS };
  private dx = 0;
  private dy = 0;
  /** Mouse counts moved since the last take (tests and automation add to it too). */
  readonly element: HTMLElement;

  constructor(element: HTMLElement, hooks: ControlsHooks) {
    this.element = element;
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.altKey) return;
      if (!e.repeat && hooks.onKey(e.code)) {
        e.preventDefault();
        return;
      }
      const b = bindingForKey(e.code);
      if (b === null) return;
      e.preventDefault();
      if (b.kind === 'hold') this.held[b.control] = true;
      else if (!e.repeat) hooks.onSlot(b.slot);
    });
    window.addEventListener('keyup', (e) => {
      const b = bindingForKey(e.code);
      if (b !== null && b.kind === 'hold') this.held[b.control] = false;
    });
    window.addEventListener('blur', () => this.release());
    element.addEventListener('mousedown', (e) => {
      const b = bindingForMouseButton(e.button);
      if (b !== null && b.kind === 'hold') {
        this.held[b.control] = true;
        if (b.control === 'attack') hooks.onFire();
      }
      if (document.pointerLockElement !== element) void this.lock();
    });
    window.addEventListener('mouseup', (e) => {
      const b = bindingForMouseButton(e.button);
      if (b !== null && b.kind === 'hold') this.held[b.control] = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== element) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
  }

  /** Ask for pointer lock (it needs a user gesture; failures are ignored: the mouse then doesn't turn the view). */
  async lock(): Promise<void> {
    try {
      const r = this.element.requestPointerLock() as unknown;
      if (r instanceof Promise) await r;
    } catch {
      // Not allowed now (no gesture, or the user pressed Esc a moment ago).
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  controls(): HeldControls {
    return { ...this.held };
  }

  /** Mouse movement since the last call (counts), then reset. */
  takeMouse(): { dx: number; dy: number } {
    const m = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return m;
  }

  /** Automation (tools/browser-check3d.ts): add mouse movement as if the pointer were locked. */
  addMouse(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  /** Let go of every key and button (focus lost, takeover, death). */
  release(): void {
    this.held = { ...NO_CONTROLS };
  }
}
