/** Small preferences in localStorage: the player the user said he is (by Steam ID), preselected for the next demo. */
const USER_KEY = 'cs2-coach.user.steamId';

export function rememberedUser(): string | null {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}

export function rememberUser(steamId: string): void {
  try { localStorage.setItem(USER_KEY, steamId); } catch { /* storage disabled: nothing to remember */ }
}
