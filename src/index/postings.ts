// Postings: the compact form of the index's core.
//
// Every (term, document) pair used to be an entry in a JavaScript Map. Measured
// A/B on this engine, 90,790 pairs cost 10 MB as nested Maps — 116 bytes a pair,
// once the documents themselves are excluded. (An earlier figure of 376 bytes
// was measured by dividing total heap by pair count, which folded the documents
// and their text into the number; it overstated the win.)
//
// The pairs are dense integers and small floats. In two typed arrays they cost 8
// bytes — Int32 for the document ordinal, Float32 for the frequency — which is
// about 14x less, and on a live 19 KB document it is the difference between
// ~67 KB and ~23 KB of RAM per document.
//
// Two properties make this straightforward rather than clever:
//
//   * Documents are immutable once indexed, so a term's list is append-only and
//     document ordinals are assigned in increasing order. The ordinals therefore
//     stay sorted, which makes membership a binary search.
//   * Pruning removes documents, so removals are tombstones (frequency zeroed)
//     rather than splices. Search skips them; a compaction pass drops them.
export class Postings {
  /** Document ordinals, ascending. Left in place when a posting is removed, so
   *  the array stays sorted and the binary search keeps working. */
  ids: Int32Array;
  /** Term frequency per entry. Zero is a tombstone. */
  tfs: Float32Array;
  /** Slots in use, including tombstones. */
  used = 0;
  /** How many of those are tombstones. */
  removed = 0;
  private cap: number;

  constructor(capacity = 8) {
    this.cap = Math.max(4, capacity);
    this.ids = new Int32Array(this.cap);
    this.tfs = new Float32Array(this.cap);
  }

  /** Live entries. */
  get length(): number {
    return this.used - this.removed;
  }

  /** Index of `id` among the used slots, or -1. */
  private find(id: number): number {
    let lo = 0;
    let hi = this.used - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.ids[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get(id: number): number {
    const i = this.find(id);
    return i === -1 ? 0 : this.tfs[i];
  }

  /** True only if there is a live posting for this document. */
  has(id: number): boolean {
    const i = this.find(id);
    return i !== -1 && this.tfs[i] !== 0;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const ids = new Int32Array(cap);
    const tfs = new Float32Array(cap);
    ids.set(this.ids.subarray(0, this.used));
    tfs.set(this.tfs.subarray(0, this.used));
    this.ids = ids;
    this.tfs = tfs;
    this.cap = cap;
  }

  /**
   * Append one posting. Documents are never re-indexed, so this only ever adds
   * at the end; a caller that wants to overwrite should remove first, though a
   * tombstone for the same document is resurrected here.
   */
  add(id: number, tf: number): void {
    const existing = this.find(id);
    if (existing !== -1) {
      if (this.tfs[existing] === 0) this.removed--; // resurrect
      this.tfs[existing] = tf;
      return;
    }
    if (this.used === this.cap) this.grow();
    // Ordinals arrive in increasing order, which keeps the array sorted. A
    // document added out of order would break the binary search above, so sort
    // defensively rather than silently returning wrong results.
    if (this.used > 0 && id < this.ids[this.used - 1]) {
      this.insertSorted(id, tf);
      return;
    }
    this.ids[this.used] = id;
    this.tfs[this.used] = tf;
    this.used++;
  }

  private insertSorted(id: number, tf: number): void {
    let at = this.used;
    while (at > 0 && this.ids[at - 1] > id) {
      this.ids[at] = this.ids[at - 1];
      this.tfs[at] = this.tfs[at - 1];
      at--;
    }
    this.ids[at] = id;
    this.tfs[at] = tf;
    this.used++;
  }

  /**
   * Tombstone a posting. The slot stays (keeping the array sorted) and only its
   * frequency is zeroed; search skips zeros and compaction reclaims the space.
   */
  remove(id: number): boolean {
    const i = this.find(id);
    if (i === -1 || this.tfs[i] === 0) return false;
    this.tfs[i] = 0;
    this.removed++;
    return true;
  }

  /** Drop tombstones, restoring a dense, sorted run. */
  compact(): void {
    if (this.removed === 0) return;
    let w = 0;
    for (let r = 0; r < this.used; r++) {
      if (this.tfs[r] === 0) continue;
      this.ids[w] = this.ids[r];
      this.tfs[w] = this.tfs[r];
      w++;
    }
    this.used = w;
    this.removed = 0;
  }

  /** True once enough of the list is tombstones to be worth reclaiming. */
  get needsCompaction(): boolean {
    return this.removed > 32 && this.removed * 2 > this.used;
  }

  /** Drop everything. */
  clear(): void {
    this.used = 0;
    this.removed = 0;
  }

  /** Document ordinals with a non-zero frequency, for search. */
  *liveEntries(): Generator<[number, number]> {
    for (let i = 0; i < this.used; i++) {
      const tf = this.tfs[i];
      if (tf !== 0) yield [this.ids[i], tf];
    }
  }

  /** Rebuild from parallel arrays, e.g. when loading from disk. */
  static from(ids: ArrayLike<number>, tfs: ArrayLike<number>): Postings {
    const p = new Postings(Math.max(4, ids.length));
    p.ids = Int32Array.from(ids);
    p.tfs = Float32Array.from(tfs);
    p.used = Math.min(ids.length, tfs.length);
    p.removed = 0;
    p.cap = Math.max(4, p.used);
    return p;
  }

  /** Bytes actually held by the arrays, which is the whole point of this class. */
  get byteLength(): number {
    return this.ids.byteLength + this.tfs.byteLength;
  }
}