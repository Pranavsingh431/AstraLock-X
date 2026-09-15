/**
 * The virtual camera's feed.
 *
 * This draws the **actual pixel buffer** the sensor produced. It is not a
 * second Three.js camera dressed up to look like a sensor: what appears here is
 * the same `CameraSensorFrame` a tracking algorithm will be handed, so if the
 * image looks wrong the sensor is wrong.
 *
 * GRAY8 is expanded to RGBA for the canvas, which is a display concern only —
 * the sensor's format is single-channel and stays that way. A detector has no
 * use for three identical colour channels.
 */

import { useEffect, useRef } from 'react';

/**
 * The part of an algorithm's diagnostics the overlay draws.
 *
 * Structural rather than a union of the two concrete debug types: the overlay
 * shows what a detection and an estimate look like on the image, which every
 * tracker has, and naming exactly that set keeps the drawing code from caring
 * which one is running.
 */
interface OverlayDebug {
  readonly centroidX: number | null;
  readonly centroidY: number | null;
  readonly boundingBox: { x: number; y: number; width: number; height: number } | null;
  readonly candidateScore: number | null;
  readonly predictedImageX: number | null;
  readonly predictedImageY: number | null;
  /**
   * The identity verdict on the selected candidate, for a tracker that has a
   * correlator. Optional because the baseline has none, and absent is not the
   * same as "no verdict": one algorithm cannot answer, the other has not.
   */
  readonly identityState?: string | null;
  readonly identityEnabled?: boolean;
  /**
   * Every candidate the detector found this frame, for a tracker that reports
   * them. Positions and strengths computed from these pixels, plus the
   * tracker's own identity verdict — never a name, and never a label saying
   * which one is the target, because the tracker does not know.
   */
  readonly candidates?: readonly {
    readonly u: number;
    readonly v: number;
    readonly score: number;
    readonly identity?: string | null;
    readonly selected: boolean;
  }[];
}

/** Colour and short caption for each identity verdict drawn on the image. */
const IDENTITY_MARK: Record<string, { colour: string; caption: string }> = {
  match: { colour: '#34d399', caption: 'MATCH' },
  mismatch: { colour: '#f87171', caption: 'MISMATCH' },
  ambiguous: { colour: '#fbbf24', caption: 'AMBIGUOUS' },
  unconfirmed: { colour: '#cbd5e1', caption: 'UNCONFIRMED' },
  'insufficient-evidence': { colour: '#cbd5e1', caption: 'WATCHING' },
};
import type { CameraSensorFrame } from '@/core/contracts/sensors';
import type { SensorEvaluationTruth } from '@/core/sensors/sensor-truth';
import { useSimulationStore } from '@/stores/simulation-store';

/** Expands single-channel intensity into the canvas's RGBA layout. */
function writeGrayToImageData(frame: CameraSensorFrame, image: ImageData): void {
  const source = frame.data as Uint8Array;
  const destination = image.data;

  for (let index = 0; index < source.length; index += 1) {
    const value = source[index]!;
    const offset = index * 4;
    destination[offset] = value;
    destination[offset + 1] = value;
    destination[offset + 2] = value;
    destination[offset + 3] = 255;
  }
}

/**
 * Draws the privileged truth overlay.
 *
 * Off by default, and sourced from `SensorEvaluationTruth` rather than from the
 * frame — the frame does not contain the true projected centre and must not.
 * It exists to check the geometry: the marker should sit on the brightest part
 * of the rendered point spread, and if it does not, the projection is wrong.
 */
function drawTruthOverlay(
  context: CanvasRenderingContext2D,
  truth: SensorEvaluationTruth,
  scale: number,
): void {
  context.save();
  context.strokeStyle = '#ffd54f';
  context.fillStyle = '#ffd54f';
  context.lineWidth = 1;
  context.font = '10px ui-monospace, monospace';

  for (const projection of truth.projections) {
    if (projection.imageX === null || projection.imageY === null) continue;

    const x = projection.imageX * scale;
    const y = projection.imageY * scale;
    const arm = 9;

    context.beginPath();
    context.moveTo(x - arm, y);
    context.lineTo(x - 3, y);
    context.moveTo(x + 3, y);
    context.lineTo(x + arm, y);
    context.moveTo(x, y - arm);
    context.lineTo(x, y - 3);
    context.moveTo(x, y + 3);
    context.lineTo(x, y + arm);
    context.stroke();

    context.fillText(`${projection.range.toFixed(0)} m`, x + arm + 2, y - 2);
  }

  context.restore();
}

/**
 * Draws what the **algorithm** believes, from its own safe output.
 *
 * Nothing here comes from `SensorEvaluationTruth`. The centroid is the one the
 * detector computed from these pixels, the box is the component it selected,
 * and the predicted marker is the filter's estimate projected back through the
 * believed calibration and the measured pose. An operator can turn every
 * privileged overlay off and still watch the tracker work — which is the point:
 * if this overlay tracked the beacon only while truth was enabled, the tracker
 * would not be tracking.
 */
function drawAlgorithmOverlay(
  context: CanvasRenderingContext2D,
  debug: OverlayDebug,
  width: number,
  height: number,
): void {
  context.save();
  context.lineWidth = 1;
  context.font = '10px ui-monospace, monospace';

  // The principal point: where the controller is trying to put the target.
  context.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  context.beginPath();
  context.moveTo(width / 2 - 14, height / 2);
  context.lineTo(width / 2 - 4, height / 2);
  context.moveTo(width / 2 + 4, height / 2);
  context.lineTo(width / 2 + 14, height / 2);
  context.moveTo(width / 2, height / 2 - 14);
  context.lineTo(width / 2, height / 2 - 4);
  context.moveTo(width / 2, height / 2 + 4);
  context.lineTo(width / 2, height / 2 + 14);
  context.stroke();

  // The filter's prediction, drawn even when this frame had no detection —
  // that is the coast, and seeing it is how an operator knows the difference
  // between "lost it" and "still believes it is there".
  if (debug.predictedImageX !== null && debug.predictedImageY !== null) {
    context.strokeStyle = '#38bdf8';
    context.beginPath();
    context.arc(debug.predictedImageX, debug.predictedImageY, 10, 0, Math.PI * 2);
    context.stroke();
  }

  // The identity verdict rides on the selection box, because that is what the
  // verdict is about: this blob, judged on its own brightness over time. It is
  // never drawn next to a source the tracker did not select, and it never names
  // an emitter — the tracker does not know one to name.
  const mark =
    debug.identityEnabled === true && typeof debug.identityState === 'string'
      ? IDENTITY_MARK[debug.identityState]
      : undefined;

  // Every other candidate the detector found. An operator watching a decoy
  // cross needs to see that the tracker knows it is there and has judged it;
  // showing only the selected blob hides exactly the moment that matters.
  //
  // The marks say SELECTED, MATCH or MISMATCH — statements about this tracker's
  // evidence. None of them says TARGET, because nothing here knows which one is.
  for (const candidate of debug.candidates ?? []) {
    if (candidate.selected) continue;
    const other =
      debug.identityEnabled === true && typeof candidate.identity === 'string'
        ? IDENTITY_MARK[candidate.identity]
        : undefined;
    context.strokeStyle = other?.colour ?? 'rgba(148, 163, 184, 0.75)';
    context.beginPath();
    context.arc(candidate.u, candidate.v, 5, 0, Math.PI * 2);
    context.stroke();
    if (other !== undefined) {
      context.fillStyle = other.colour;
      context.fillText(other.caption, candidate.u + 7, candidate.v + 4);
    }
  }

  if (debug.boundingBox !== null) {
    context.strokeStyle = mark?.colour ?? '#34d399';
    context.strokeRect(
      debug.boundingBox.x - 0.5,
      debug.boundingBox.y - 0.5,
      debug.boundingBox.width + 1,
      debug.boundingBox.height + 1,
    );
  }

  if (debug.centroidX !== null && debug.centroidY !== null) {
    context.fillStyle = '#34d399';
    context.beginPath();
    context.arc(debug.centroidX, debug.centroidY, 1.6, 0, Math.PI * 2);
    context.fill();

    if (debug.candidateScore !== null) {
      context.fillText(debug.candidateScore.toFixed(2), debug.centroidX + 8, debug.centroidY - 6);
    }

    context.fillStyle = mark?.colour ?? '#34d399';
    context.fillText(
      mark === undefined ? 'SELECTED' : `SELECTED · ${mark.caption}`,
      debug.centroidX + 8,
      debug.centroidY + 12,
    );
  }

  context.restore();
}

export function CameraMonitor(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<ImageData | null>(null);

  const frame = useSimulationStore((state) => state.sensorFrame);
  const truth = useSimulationStore((state) => state.sensorTruth);
  const showTruthOverlay = useSimulationStore((state) => state.showTruthOverlay);
  const algorithmDebug = useSimulationStore((state) => state.algorithmDebug);
  const showAlgorithmOverlay = useSimulationStore((state) => state.showAlgorithmOverlay);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || frame === null) return;

    const context = canvas.getContext('2d');
    if (context === null) return;

    const width: number = frame.width;
    const height: number = frame.height;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      imageRef.current = context.createImageData(width, height);
    }

    // The sensor's pixel buffer is pooled and will be reused; copying it into
    // the canvas here is the ownership boundary.
    let image = imageRef.current;
    if (image === null || image.width !== width) {
      image = context.createImageData(width, height);
      imageRef.current = image;
    }

    writeGrayToImageData(frame, image);
    context.putImageData(image, 0, 0);

    // The algorithm's own view goes on first; the privileged overlay, when it
    // is on at all, goes on top so the two can be compared without either
    // being mistaken for the other.
    if (showAlgorithmOverlay && algorithmDebug !== null) {
      drawAlgorithmOverlay(context, algorithmDebug, width, height);
    }

    if (showTruthOverlay && truth !== null) {
      drawTruthOverlay(context, truth, 1);
    }
  }, [frame, truth, showTruthOverlay, algorithmDebug, showAlgorithmOverlay]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Virtual camera sensor feed"
      className="h-full w-full bg-black object-contain"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
