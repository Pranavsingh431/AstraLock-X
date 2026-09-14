/**
 * The engineering observer view.
 *
 * A debug view of ground truth, not a sensor image. It shows where everything
 * actually is, from a camera the operator flies freely — which is precisely
 * what the tracking sensor feed will not do when it arrives in a later phase.
 *
 * Rendering reads the simulation; it never writes to it. Entity transforms are
 * applied imperatively inside `useFrame` rather than through React state, so a
 * moving target does not re-render the scene graph sixty times a second, and so
 * nothing about the world depends on the render tree.
 */

import { Grid, Line, OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group, Mesh } from 'three';

import { useSimulationStore } from '@/stores/simulation-store';

import { OBSERVER_COLORS } from './observer-colors';

/**
 * Markers are drawn larger than the objects they represent.
 *
 * A one-metre target at fifteen hundred metres is a fraction of a pixel. The
 * legend says the markers are not to scale; inflating them silently would be
 * misrepresenting the geometry.
 */
const MIN_MARKER_RADIUS = 14;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function TargetMarkers(): React.JSX.Element {
  const targetRefs = useRef<(Mesh | null)[]>([]);
  const beaconRefs = useRef<(Mesh | null)[]>([]);
  const targets = useSimulationStore((state) => state.currentFrame.targets);
  // Select the config itself, not a mapped array. A selector that builds a new
  // array on every call makes useSyncExternalStore see a changed snapshot each
  // render, which loops until React gives up.
  const config = useSimulationStore((state) => state.config);

  useFrame(() => {
    // Read the store imperatively: subscribing here would re-render the whole
    // scene every frame to move a handful of meshes.
    const { previousFrame, currentFrame, alpha } = useSimulationStore.getState();

    currentFrame.targets.forEach((target, index) => {
      const before = previousFrame.targets[index] ?? target;
      const x = lerp(before.position[0], target.position[0], alpha);
      const y = lerp(before.position[1], target.position[1], alpha);
      const z = lerp(before.position[2], target.position[2], alpha);

      targetRefs.current[index]?.position.set(x, y, z);
      beaconRefs.current[index]?.position.set(x, y, z);
    });
  });

  return (
    <>
      {targets.map((target, index) => {
        const radius = Math.max(config.targets[index]?.radius ?? 1, MIN_MARKER_RADIUS);
        return (
          <group key={target.id}>
            <mesh
              ref={(mesh) => {
                targetRefs.current[index] = mesh;
              }}
            >
              <sphereGeometry args={[radius, 20, 20]} />
              <meshStandardMaterial
                color={OBSERVER_COLORS.target}
                emissive={OBSERVER_COLORS.target}
                emissiveIntensity={0.35}
              />
            </mesh>
            <mesh
              ref={(mesh) => {
                beaconRefs.current[index] = mesh;
              }}
            >
              <sphereGeometry args={[radius * 0.42, 12, 12]} />
              <meshBasicMaterial color={OBSERVER_COLORS.beacon} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

function ObserverPlatform(): React.JSX.Element {
  const boresightRef = useRef<Group | null>(null);
  const observer = useSimulationStore((state) => state.currentFrame.observer);
  const boresightEnd = useSimulationStore((state) => state.currentFrame.boresightEnd);

  return (
    <group ref={boresightRef}>
      <mesh position={observer.position}>
        <coneGeometry args={[16, 46, 4]} />
        <meshStandardMaterial color={OBSERVER_COLORS.observer} />
      </mesh>
      {/* The reference pointing direction. Phase 1 has no servo, so it is fixed. */}
      <Line
        points={[observer.position, boresightEnd]}
        color={OBSERVER_COLORS.boresight}
        lineWidth={1.5}
        dashed
        dashScale={0.05}
      />
    </group>
  );
}

function TrajectoryPaths(): React.JSX.Element | null {
  const paths = useSimulationStore((state) => state.paths);
  if (paths.length === 0) return null;

  return (
    <>
      {paths.map((path, index) => (
        <Line
          key={index}
          points={path}
          color={OBSERVER_COLORS.path}
          lineWidth={1}
          transparent
          opacity={0.55}
        />
      ))}
    </>
  );
}

export interface ObserverSceneProps {
  readonly showGrid: boolean;
  readonly showAxes: boolean;
  readonly showPaths: boolean;
}

/** Scene contents. Rendered inside a `Canvas` by the view. */
export function ObserverScene({
  showGrid,
  showAxes,
  showPaths,
}: ObserverSceneProps): React.JSX.Element {
  return (
    <>
      <ambientLight intensity={0.75} />
      <directionalLight position={[600, 900, 400]} intensity={1.4} />

      {showGrid && (
        <Grid
          args={[8000, 8000]}
          cellSize={100}
          cellThickness={0.5}
          cellColor="#22384a"
          sectionSize={500}
          sectionThickness={1}
          sectionColor="#2f5a73"
          fadeDistance={7000}
          fadeStrength={1.2}
          infiniteGrid={false}
          followCamera={false}
        />
      )}

      {/* World origin: the scenario datum every position is measured from. */}
      <mesh>
        <sphereGeometry args={[8, 10, 10]} />
        <meshBasicMaterial color="#6b7f8c" />
      </mesh>

      {/* Renderer axes: +X is East, +Y is Up, -Z is North. See ADR-0006. */}
      {showAxes && <axesHelper args={[400]} />}

      {showPaths && <TrajectoryPaths />}
      <ObserverPlatform />
      <TargetMarkers />

      {/* Operator camera only. Orbiting cannot reach the simulation: there is
          no path from a control to the engine. */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxDistance={12000}
        minDistance={40}
        target={[0, 60, -1200]}
      />
    </>
  );
}
