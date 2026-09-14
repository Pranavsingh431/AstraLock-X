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

export function CameraMonitor(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<ImageData | null>(null);

  const frame = useSimulationStore((state) => state.sensorFrame);
  const truth = useSimulationStore((state) => state.sensorTruth);
  const showTruthOverlay = useSimulationStore((state) => state.showTruthOverlay);

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

    if (showTruthOverlay && truth !== null) {
      drawTruthOverlay(context, truth, 1);
    }
  }, [frame, truth, showTruthOverlay]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Virtual camera sensor feed"
      className="h-full w-full bg-black object-contain"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
