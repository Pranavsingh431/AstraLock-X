/**
 * A worked example of the algorithm plugin contract.
 *
 * Its purpose is documentary. It exists so that an engineer adding a tracker
 * can read one small file and see the whole contract — what arrives, what has
 * to be returned, what the harness does with it — without reading the two real
 * trackers or, worse, reading the simulator.
 *
 * **This file imports nothing from the simulator.** Its imports are the
 * contracts directory and nothing else, and that is the point being
 * demonstrated: a plugin is written against an interface, not against the
 * engine. It sees a camera frame, a measured mount state and a clock, exactly
 * as the two shipped algorithms do, and exactly as a real terminal's software
 * would.
 *
 * ## What it actually does
 *
 * A fixed raster scan of the travel envelope, and nothing else. It never looks
 * at the pixels. So it acquires nothing, and that is honest rather than
 * disappointing: a reference implementation that pretended to track would be
 * teaching the wrong thing, and this one makes the contract legible without
 * making a claim.
 *
 * It is deliberately **not** in the bundled benchmark suites. Comparing a
 * tracker against something that does not track produces a number that flatters
 * the tracker and measures nothing. It is available in the registry so that a
 * developer can select it and watch the plumbing work.
 *
 * See docs/ALGORITHM_PLUGIN.md.
 */

import { z } from 'zod';

import { defineAlgorithm } from '@/core/contracts/algorithm-plugin';
import type {
  AlgorithmInit,
  AlgorithmInstance,
  TrackingInput,
  TrackingOutput,
} from '@/core/contracts/algorithm-plugin';
import { radians, type Radians, type Seconds } from '@/core/contracts/units';

export const exampleScanConfigSchema = z.strictObject({
  /** Seconds spent at each waypoint before stepping to the next. */
  dwellSeconds: z.number().positive().max(600),
  /** Waypoints across the pan travel. */
  panSteps: z.number().int().min(1).max(64),
  /** Rows of the raster across the tilt travel. */
  tiltSteps: z.number().int().min(1).max(64),
});
export type ExampleScanConfig = z.infer<typeof exampleScanConfigSchema>;

export const DEFAULT_EXAMPLE_SCAN_CONFIG: ExampleScanConfig = {
  dwellSeconds: 2,
  panSteps: 8,
  tiltSteps: 3,
};

/** What the example reports about itself. No ground truth can reach this type. */
export interface ExampleScanDebug {
  readonly algorithm: 'example-scan';
  readonly waypointIndex: number;
  readonly waypointCount: number;
  readonly commandedAzimuth: number;
  readonly commandedElevation: number;
  readonly framesSeen: number;
}

class ExampleScanInstance implements AlgorithmInstance<ExampleScanDebug> {
  private readonly waypoints: readonly { azimuth: number; elevation: number }[];
  private index = 0;
  private dwellStartedAt: number | null = null;
  private framesSeen = 0;

  constructor(private readonly init: AlgorithmInit<ExampleScanConfig>) {
    this.waypoints = ExampleScanInstance.raster(init);
  }

  /**
   * A boustrophedon raster over the mount's travel.
   *
   * Alternate rows run in opposite directions so the mount never has to slew
   * the full width to start the next one. Computed once, from the travel limits
   * the harness supplied — which is believed configuration, not truth.
   */
  private static raster(
    init: AlgorithmInit<ExampleScanConfig>,
  ): readonly { azimuth: number; elevation: number }[] {
    const { panSteps, tiltSteps } = init.config;
    const pan = init.gimbal.azimuthLimits;
    const tilt = init.gimbal.elevationLimits;

    const at = (
      limits: { minAngle: Radians; maxAngle: Radians },
      step: number,
      count: number,
    ): number => {
      const min = limits.minAngle as number;
      const max = limits.maxAngle as number;
      // A single step sits in the middle rather than at an extreme.
      return count === 1 ? (min + max) / 2 : min + ((max - min) * step) / (count - 1);
    };

    const points: { azimuth: number; elevation: number }[] = [];
    for (let row = 0; row < tiltSteps; row += 1) {
      for (let column = 0; column < panSteps; column += 1) {
        const index = row % 2 === 0 ? column : panSteps - 1 - column;
        points.push({
          azimuth: at(pan, index, panSteps),
          elevation: at(tilt, row, tiltSteps),
        });
      }
    }
    return points;
  }

  public update(input: TrackingInput): TrackingOutput<ExampleScanDebug> {
    const time = input.time as number;
    this.dwellStartedAt ??= time;
    if (input.frame !== null) this.framesSeen += 1;

    if (time - this.dwellStartedAt >= this.init.config.dwellSeconds) {
      this.index = (this.index + 1) % this.waypoints.length;
      this.dwellStartedAt = time;
    }

    const waypoint = this.waypoints[this.index]!;
    return {
      observations: [],
      estimates: [],
      command: {
        kind: 'position',
        azimuth: radians(waypoint.azimuth),
        elevation: radians(waypoint.elevation),
      },
      // Honest about its own state: it is searching, for ever, and says so.
      pat: {
        mode: 'scan',
        since: 0 as Seconds,
        lastTransitionReason: 'commanded',
        activeTrack: null,
        estimatedPointingError: null,
        linkMargin: null,
        consecutiveMisses: 0,
        transitionCount: 0,
      },
      debug: {
        algorithm: 'example-scan',
        waypointIndex: this.index,
        waypointCount: this.waypoints.length,
        commandedAzimuth: waypoint.azimuth,
        commandedElevation: waypoint.elevation,
        framesSeen: this.framesSeen,
      },
    };
  }

  public reset(): void {
    this.index = 0;
    this.dwellStartedAt = null;
    this.framesSeen = 0;
  }
}

export const exampleScanPat = defineAlgorithm({
  manifest: {
    id: 'example-scan',
    name: 'Example: fixed raster scan',
    version: '1.0.0',
    description:
      'A worked example of the plugin contract. Sweeps a fixed raster over the mount travel ' +
      'and never inspects the image, so it acquires nothing. Present so that a developer can ' +
      'read one small file and see the whole interface; deliberately absent from the bundled ' +
      'benchmark suites, where comparing a tracker against a non-tracker would measure nothing.',
    configSchema: exampleScanConfigSchema,
    defaultConfig: DEFAULT_EXAMPLE_SCAN_CONFIG,
  },
  create: (init: AlgorithmInit<ExampleScanConfig>): AlgorithmInstance<ExampleScanDebug> =>
    new ExampleScanInstance(init),
});
