/**
 * Stable Matter endpoint numbers. Each bridged device gets a slot; the device family decides how
 * many endpoints it puts in that slot (a Nest uses three, a Dyson five).
 *
 * Numbers are ours rather than matter.js's for two reasons. They must not move when the device list
 * changes, since a controller identifies accessories by them, so each device keeps a slot that is
 * persisted alongside the Matter storage. And they are all three digits, because matter.js builds
 * the descriptor `partsList` with a bare `numbers.sort()`, which sorts lexicographically: endpoints
 * 9 and 10 would be published as [10, 9].
 */

const FIRST_NUMBER = 100;
/** Endpoints one device may claim before it would run into the next slot. */
export const PER_DEVICE = 10;
/** Slots beyond this would need four digits and reintroduce the ordering bug. */
export const MAX_SLOTS = 90;

/** First endpoint number of a slot, or undefined past the three-digit range. */
export function numbersForSlot(slot: number): number | undefined {
  if (slot >= MAX_SLOTS) return undefined;
  return FIRST_NUMBER + slot * PER_DEVICE;
}

/** Slot assignments keyed by device (SDM device name, or `dyson:<serial>`), persisted as JSON. */
export class Slots {
  readonly #path: string;
  readonly #slots: Record<string, number>;

  private constructor(path: string, slots: Record<string, number>) {
    this.#path = path;
    this.#slots = slots;
  }

  static async open(path: string) {
    const file = Bun.file(path);
    const slots = (await file.exists()) ? ((await file.json()) as Record<string, number>) : {};
    return new Slots(path, slots);
  }

  /** The device's slot, assigning and persisting the next free one on first sight. */
  async slotFor(deviceName: string) {
    const known = this.#slots[deviceName];
    if (known !== undefined) return known;

    const used = Object.values(this.#slots);
    const slot = used.length ? Math.max(...used) + 1 : 0;
    this.#slots[deviceName] = slot;
    await Bun.write(this.#path, `${JSON.stringify(this.#slots, null, 2)}\n`);
    return slot;
  }
}
