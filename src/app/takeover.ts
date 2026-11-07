/**
 * G4, the page's takeover UI (DOM-free, tested in Node): who plays at load, what the "Take control of cart" button
 * shows and what the status card says while watching. docs/app.md "Takeover", docs/core.md "Takeover".
 *
 * The page starts **watching** on every device: nobody controls cart and the round plays as recorded. The button or E
 * hands him to the player from the next tick (Session.takeControl). Touch-only devices have no controls for the human,
 * so they keep watching.
 */
import { isPlayerId, type PlayerId } from '../contracts/index';

/** The key that takes control while watching (CS2 takes over a spectated bot with E, +use). */
export const TAKEOVER_KEY = 'KeyE';

/**
 * Who plays from the start, from the page's `?human=` parameter: a player id (`cart`) plays it from tick 0; anything
 * else (absent, `none`, `spectate`) watches.
 */
export function startHuman(param: string | null): PlayerId | null {
  return param !== null && isPlayerId(param) ? param : null;
}

/** The "Take control" button. */
export interface TakeoverButtonView {
  readonly label: string;
  readonly disabled: boolean;
  /** aria-pressed: the player controls the pawn. */
  readonly pressed: boolean;
  /** Show the E key cap (only while E would take control). */
  readonly key: boolean;
  /** Tooltip: what it does, or why it can't. */
  readonly title: string;
}

/**
 * The button for the session's state: `human` (Session.human), `playable` (Session.playable), `blocked`
 * (Session.takeControlBlocked(): null when a takeover is possible), whether the device is touch-only and whether a
 * seek is running.
 */
export function takeoverButtonView(human: PlayerId | null, playable: PlayerId | null, blocked: string | null, touchOnly: boolean, seeking: boolean): TakeoverButtonView {
  if (human !== null) return { label: `You: ${human}`, disabled: true, pressed: true, key: false, title: `You control ${human}. Restart, or a rewind to before you took control, goes back to watching.` };
  if (playable === null) return { label: 'Watching', disabled: true, pressed: false, key: false, title: 'Nobody can be taken over in this session.' };
  const label = `Take control of ${playable}`;
  if (touchOnly) return { label, disabled: true, pressed: false, key: false, title: 'Playing needs a keyboard and mouse; on this device you watch.' };
  if (blocked !== null) return { label, disabled: true, pressed: false, key: false, title: `Not now: ${blocked}.` };
  if (seeking) return { label, disabled: true, pressed: false, key: true, title: 'Not while seeking.' };
  return { label, disabled: false, pressed: false, key: true, title: `Play ${playable} from this moment on (E).` };
}

/** The note beside the status card's name: `you`, or while watching whether E takes control. */
export function youNote(human: PlayerId | null, you: PlayerId, playable: PlayerId | null, canTake: boolean, touchOnly: boolean): string {
  if (human === you) return 'you';
  if (human !== null) return '';
  return canTake && !touchOnly && playable === you ? 'watching · E: take control' : 'watching';
}
