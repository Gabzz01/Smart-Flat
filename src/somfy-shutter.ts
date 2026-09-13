/**
 * Maps a Somfy RTS shutter onto Matter as a window covering, one endpoint per shutter.
 *
 * RTS sends nothing back and the wall remote moves the shutter without the bridge hearing, so there
 * is no real position to report. The cluster still carries PositionAwareLift, because HomeKit's
 * Window Covering service requires CurrentPosition and TargetPosition and shows the accessory as
 * "No Response" without them. What is published is the end the shutter was last commanded to --
 * never a null, never an in-between -- so the number is always something that was actually sent.
 *
 * ponytail: no travel model. The upgrade is a travel-time knob (SOMFY_TRAVEL_MS), running the motor
 * for a proportional slice and firing `my` to stop -- add it when a half-open shutter is worth a
 * number that goes stale anyway the moment somebody picks up the wall remote.
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
import type { Shutter, SomfyCommand, Transmitter } from "./somfy.ts";
import { numbersForSlot } from "./slots.ts";

const { WindowCoveringType, EndProductType } = WindowCovering;

/** Endpoint id, and the key the radio wiring is looked up by. */
export const endpointId = (shutter: Shutter) => `somfy-${shutter.address.slice(2)}`;

/** Lift positions in percent100ths: the cluster counts up from fully open. */
export const OPEN = 0;
export const CLOSED = 10_000;

/**
 * What a shutter reads as before anything has been commanded.
 *
 * The truth is "unknown", and the cluster has a null for exactly that, but HomeKit has no such
 * value: a null CurrentPosition leaves the tile stuck on "No Response". So the bridge starts on a
 * guess and corrects it the first time the shutter is driven. Matter persists the position
 * (quality N), so the guess only ever applies to a shutter that has never been commanded.
 */
export const INITIAL = CLOSED;

/**
 * Which way to drive, and the position to report once the frame is out.
 *
 * A target between the two ends resolves to whichever end it is nearer, because the shutter can
 * only be told to run: there is no "go to 40%" to send. The position reported is the end it was
 * sent to, never the percentage that was asked for, so the number stays something that was
 * actually commanded.
 *
 * `reversed` is the cluster's motor-reversed config and swaps which command opens, not which
 * position counts as open.
 */
export function movementFor(direction: MovementDirection, reversed: boolean, targetPercent100ths?: number) {
  const open =
    direction === MovementDirection.Open
      ? true
      : direction === MovementDirection.Close
        ? false
        : targetPercent100ths === undefined
          ? undefined
          : targetPercent100ths < CLOSED / 2;
  if (open === undefined) return undefined;
  return { command: (reversed ? !open : open) ? "up" : "down", position: open ? OPEN : CLOSED } as const;
}

/**
 * Radio wiring per endpoint. A behavior is constructed by matter.js, not by us, so it cannot be
 * handed the radio at construction; its endpoint id is the link back.
 *
 * ponytail: module-level because there is exactly one CC1101 on the bus. A second radio would
 * make this behavior state instead.
 */
interface Wiring {
  shutter: Shutter;
  radio: Transmitter;
}

const wiring = new Map<string, Wiring>();

class SomfyCoveringServer extends WindowCoveringServer.with("Lift", "PositionAwareLift") {
  override handleMovement(
    _type: MovementType,
    reversed: boolean,
    direction: MovementDirection,
    targetPercent100ths?: number,
  ) {
    const wired = wiring.get(this.endpoint.id);
    if (!wired) return;
    const moved = movementFor(direction, reversed, targetPercent100ths);
    if (!moved) return;

    const previous = this.state.currentPositionLiftPercent100ths ?? INITIAL;
    this.state.targetPositionLiftPercent100ths = moved.position;
    this.state.currentPositionLiftPercent100ths = moved.position;
    this.#transmit(wired, moved.command, previous);
  }

  /** `my` is the stop button on a Somfy remote — mid-travel it halts, at rest it runs the favourite. */
  override handleStopMovement() {
    const wired = wiring.get(this.endpoint.id);
    if (!wired) return;
    // Stopped somewhere unknowable, so the last position stands and only the target is cleared.
    const stopped = super.handleStopMovement();
    this.#transmit(wired, "my", this.state.currentPositionLiftPercent100ths ?? INITIAL);
    return stopped;
  }

  /**
   * Sends, outside the command's transaction, and puts the position back if the radio never got
   * there.
   *
   * Deliberately not awaited inside the command. matter.js commits that transaction while the send
   * is still in flight, so a write afterwards throws "Cannot add resources to transaction that is
   * committing phase one", and a throw does not roll the earlier write back either -- it surfaces
   * as an unhandled runtime error and the controller is told the command succeeded regardless. So
   * the correction runs later, in a transaction of its own.
   */
  #transmit(wired: Wiring, command: SomfyCommand, previous: number) {
    const endpoint = this.endpoint;
    void wired.radio.send(wired.shutter.address, command).catch((error: unknown) => {
      console.error(`${wired.shutter.name}: ${command} failed, position is unknown again:`, error);
      // Shutting down: the endpoint is gone and there is nothing left to correct.
      void Promise.resolve(
        endpoint.act(async agent => {
          const covering = (agent as unknown as { windowCovering: SomfyCoveringServer }).windowCovering;
          // The lock on this cluster's state has to be taken asynchronously. Writing straight into a
          // fresh agent throws "Cannot lock ... synchronously", because a plain write locks with
          // addResourcesSync and there may still be a writer holding it.
          await agent.context.transaction.addResources(covering);
          await agent.context.transaction.begin();
          covering.state.currentPositionLiftPercent100ths = previous;
          covering.state.targetPositionLiftPercent100ths = previous;
        }),
      ).catch(() => {});
    });
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
        configStatus: {
          operational: true,
          liftMovementReversed: false,
          liftPositionAware: true,
          tiltPositionAware: false,
        },
        operationalStatus: { global: WindowCovering.MovementStatus.Stopped },
        mode: {},
        currentPositionLiftPercent100ths: INITIAL,
        targetPositionLiftPercent100ths: INITIAL,
      },
      bridgedDeviceBasicInformation: bridgedInfo(shutter),
    })) as ShutterEndpoint;

    return new BridgedShutter(shutter, endpoint);
  }
}
