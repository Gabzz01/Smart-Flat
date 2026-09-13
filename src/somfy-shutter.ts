/**
 * Maps a Somfy RTS shutter onto Matter as a window covering, one endpoint per shutter.
 *
 * The cluster carries the Lift feature only, NOT PositionAwareLift, so a controller gets open,
 * close and stop and no slider. That is the honest mapping: RTS sends nothing back, and the wall
 * remote moves the shutter without the bridge hearing, so any position we published would be a
 * guess that drifts the first time somebody uses the physical remote.
 *
 * ponytail: no position emulation. The upgrade is a travel-time knob (SOMFY_TRAVEL_MS) plus
 * PositionAwareLift, running the motor for a proportional slice and firing `my` to stop — add it
 * when a half-open shutter is worth a number that goes stale.
 */

import { Endpoint } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import {
  MovementDirection,
  type MovementType,
  WindowCoveringServer,
} from "@matter/main/behaviors/window-covering";
import { WindowCoveringDevice } from "@matter/main/devices";
import type { Shutter, Transmitter } from "./somfy.ts";
import { numbersForSlot } from "./slots.ts";

const { WindowCoveringType, EndProductType } = WindowCovering;

/** Endpoint id, and the key the radio wiring is looked up by. */
export const endpointId = (shutter: Shutter) => `somfy-${shutter.address.slice(2)}`;

/**
 * Which command a direction means, honouring the cluster's reversed-motor config.
 *
 * Only Lift is supported, so a movement always carries Open or Close: DefinedByPosition needs a
 * position-aware feature to arise, and there is no position to derive one from anyway.
 */
export function commandFor(direction: MovementDirection, reversed: boolean) {
  if (direction === MovementDirection.DefinedByPosition) return undefined;
  const open = direction === MovementDirection.Open;
  return (reversed ? !open : open) ? "up" : "down";
}

/**
 * Radio wiring per endpoint. A behavior is constructed by matter.js, not by us, so it cannot be
 * handed the radio at construction; its endpoint id is the link back.
 *
 * ponytail: module-level because there is exactly one CC1101 on the bus. A second radio would
 * make this behavior state instead.
 */
const wiring = new Map<string, { shutter: Shutter; radio: Transmitter }>();

/** Lift only: up, down, stop. No position, so no goToLiftPercentage. */
class SomfyCoveringServer extends WindowCoveringServer.with("Lift") {
  override async handleMovement(_type: MovementType, reversed: boolean, direction: MovementDirection) {
    const wired = wiring.get(this.endpoint.id);
    if (!wired) return;
    const command = commandFor(direction, reversed);
    if (!command) return;
    await wired.radio.send(wired.shutter.address, command);
  }

  /** `my` is the stop button on a Somfy remote — mid-travel it halts, at rest it runs the favourite. */
  override async handleStopMovement() {
    const wired = wiring.get(this.endpoint.id);
    if (!wired) return;
    await wired.radio.send(wired.shutter.address, "my");
  }
}

const SomfyShutterDevice = WindowCoveringDevice.with(SomfyCoveringServer, BridgedDeviceBasicInformationServer);
type ShutterEndpoint = Endpoint<typeof SomfyShutterDevice>;

/** Bridged accessory identity. Matter requires uniqueId and serialNumber to differ. */
function bridgedInfo(shutter: Shutter) {
  const id = shutter.address.slice(2);
  return {
    nodeLabel: shutter.name.slice(0, 32),
    productName: "RTS Shutter",
    serialNumber: `somfy-${id}`,
    uniqueId: `somfy-rts-${id}`,
    vendorName: "Somfy",
    // Nothing to be unreachable: a send either goes out or throws. Say reachable and mean it.
    reachable: true,
  };
}

/** A bridged Somfy shutter. Commands only — there is no state to sync back. */
export class BridgedShutter {
  readonly shutter: Shutter;
  readonly #endpoint: ShutterEndpoint;

  private constructor(shutter: Shutter, endpoint: ShutterEndpoint) {
    this.shutter = shutter;
    this.#endpoint = endpoint;
  }

  static async add(aggregator: Endpoint, radio: Transmitter, shutter: Shutter, slot: number) {
    const id = endpointId(shutter);
    wiring.set(id, { shutter, radio });

    const endpoint = (await aggregator.add(SomfyShutterDevice, {
      id,
      // Undefined past the three-digit range: fall back to matter.js numbering, which orders the
      // parts list correctly again once every endpoint has four digits.
      number: numbersForSlot(slot),
      windowCovering: {
        type: WindowCoveringType.Rollershade,
        endProductType: EndProductType.RollerShutter,
        // No limits are known and none can be learnt, so nothing is operational or open/closed.
        configStatus: { operational: true, liftMovementReversed: false, liftPositionAware: false, tiltPositionAware: false },
        operationalStatus: { global: WindowCovering.MovementStatus.Stopped },
        mode: {},
      },
      bridgedDeviceBasicInformation: bridgedInfo(shutter),
    })) as ShutterEndpoint;

    return new BridgedShutter(shutter, endpoint);
  }
}
