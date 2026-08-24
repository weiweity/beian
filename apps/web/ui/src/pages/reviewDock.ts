const DOCK_KEY = "wb_review_dock";
const PINS_KEY = "wb_review_pins";

export function readDockOpen(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(DOCK_KEY) !== "shut";
  } catch {
    return true;
  }
}

export function writeDockOpen(storage: Pick<Storage, "setItem"> | null, open: boolean): void {
  try {
    storage?.setItem(DOCK_KEY, open ? "open" : "shut");
  } catch {
    /* ignore quota */
  }
}

export function readPinsOn(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(PINS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writePinsOn(storage: Pick<Storage, "setItem"> | null, on: boolean): void {
  try {
    storage?.setItem(PINS_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota */
  }
}
