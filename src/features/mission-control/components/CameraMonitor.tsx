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

import type { BaselineDebug } from '@/core/algorithms';
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
  debug: BaselineDebug,
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

  if (debug.boundingBox !== null) {
    context.strokeStyle = '#34d399';
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
