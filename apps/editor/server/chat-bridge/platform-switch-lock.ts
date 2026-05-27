export function botPlatformSwitchLocked(state: {
  running: boolean;
  startInFlight: boolean;
}): boolean {
  return state.running || state.startInFlight;
}
