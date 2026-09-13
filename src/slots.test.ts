import { expect, test } from "bun:test";
import { MAX_SLOTS, numbersForSlot, PER_DEVICE, Slots } from "./slots.ts";

const tmp = () => `${import.meta.dir}/../.matter-storage/test-slots-${crypto.randomUUID()}.json`;

test("slots map to three-digit base numbers", () => {
  expect(numbersForSlot(0)).toBe(100);
  expect(numbersForSlot(1)).toBe(110);
  expect(numbersForSlot(MAX_SLOTS - 1)).toBe(990);
});

test("past the three-digit range numbering is left to matter.js", () => {
  expect(numbersForSlot(MAX_SLOTS)).toBeUndefined();
});

/** The whole point: matter.js sorts partsList lexicographically, so both orders must agree. */
test("lexicographic order of every assignable number matches numeric order", () => {
  const numbers: number[] = [];
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const base = numbersForSlot(slot)!;
    for (let offset = 0; offset < PER_DEVICE; offset++) numbers.push(base + offset);
  }
  expect(numbers.every(n => String(n).length === 3)).toBe(true);
  expect([...numbers].sort()).toEqual([...numbers].sort((a, b) => a - b));
});

test("slots are assigned in order, reused for known devices and persisted", async () => {
  const path = tmp();
  try {
    const slots = await Slots.open(path);
    expect(await slots.slotFor("devices/a")).toBe(0);
    expect(await slots.slotFor("devices/b")).toBe(1);
    expect(await slots.slotFor("devices/a")).toBe(0);

    // A restart must not renumber existing devices.
    const reopened = await Slots.open(path);
    expect(await reopened.slotFor("devices/b")).toBe(1);
    expect(await reopened.slotFor("dyson:X3B-UK-SAA0251A")).toBe(2);
  } finally {
    await Bun.file(path).delete();
  }
});
