/**
 * Guards async results so only the newest request for the current key is applied.
 * Used for lyric lookups: a slow response for a previous track is discarded.
 */
export class LatestRequest<K> {
  private gen = 0;
  private key: K | undefined;

  begin(key: K): { gen: number; key: K } {
    this.key = key;
    return { gen: ++this.gen, key };
  }

  isCurrent(token: { gen: number; key: K }): boolean {
    return token.gen === this.gen && token.key === this.key;
  }

  /** Invalidate outstanding requests without starting a new one (e.g. manual import). */
  invalidate(): void {
    this.gen++;
  }
}
