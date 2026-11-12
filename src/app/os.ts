/**
 * Wording and capabilities that depend on the desktop OS. Afterglow follows media apps
 * through Windows' media controls (GSMTC) on Windows and MPRIS (D-Bus) on Linux.
 * `platform` is Node's process.platform ('win32', 'linux', ...) or 'browser'.
 */
export function canFollowMedia(platform: string | undefined): boolean {
  return platform === 'win32' || platform === 'linux';
}

/** Where players publish what is playing, for sentences like "shows up in …". */
export function mediaControlsName(platform: string | undefined): string {
  return platform === 'linux' ? 'your desktop’s media controls (MPRIS)' : 'Windows’ media controls';
}

/** Short label for the session source: "Spotify · Windows media session". */
export function mediaSessionLabel(platform: string | undefined): string {
  return platform === 'linux' ? 'MPRIS media session' : 'Windows media session';
}

/** Name of the OS in "Follow … setting". */
export function osName(platform: string | undefined): string {
  if (platform === 'linux') return 'system';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'system';
}
