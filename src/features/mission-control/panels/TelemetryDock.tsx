/**
 * The telemetry strip along the bottom.
 *
 * Tabbed rather than stacked, because rendering six live plots at once costs
 * six times as much and nobody reads six at once. Each tab is a question:
 * where has the tracker been, is the mount following, does the estimator
 * believe the target is manoeuvring, does the correlator recognise the beacon,
 * and — only with evaluation on — how far off is it really.
 *
 * Every series is a bounded history the store recorded as the run advanced.
 */

import { Activity, Clock, Fingerprint, Move3d, Target } from 'lucide-react';

import { DEFAULT_ASTRALOCK_CONFIG } from '@/core/algorithms';
import { Panel, PanelHeader, StatusBadge } from '@/components/astra';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEngineeringView, usePrivilegedVisible } from '@/app/privileged';
import { useSimulationStore } from '@/stores/simulation-store';

import { ActuatorTruthPanel } from '../components/ActuatorTruthPanel';
import { PatTimeline } from '../telemetry/PatTimeline';
import {
  AxisResponseChart,
  IdentityCorrelationChart,
  ModelProbabilityChart,
  PointingErrorChart,
} from '../telemetry/TelemetryCharts';

const IDENTITY = DEFAULT_ASTRALOCK_CONFIG.identity;

export function TelemetryDock(): React.JSX.Element {
  const showEvaluation = useSimulationStore((state) => state.showLiveEvaluation);
  const showActuatorTruth = usePrivilegedVisible(
    useSimulationStore((state) => state.showActuatorTruth),
  );
  const engineering = useEngineeringView();

  return (
    <Panel className="h-full">
      <Tabs defaultValue="timeline" className="h-full">
        <PanelHeader
          icon={Activity}
          title="Telemetry"
          actions={
            <TabsList className="border-b-0">
              <TabsTrigger value="timeline">
                <Clock aria-hidden className="mr-1 inline size-3" />
                State
              </TabsTrigger>
              <TabsTrigger value="gimbal">
                <Move3d aria-hidden className="mr-1 inline size-3" />
                Mount
              </TabsTrigger>
              <TabsTrigger value="estimator">
                <Activity aria-hidden className="mr-1 inline size-3" />
                Estimator
              </TabsTrigger>
              <TabsTrigger value="identity">
                <Fingerprint aria-hidden className="mr-1 inline size-3" />
                Identity
              </TabsTrigger>
              {engineering && (
                <TabsTrigger value="pointing">
                  <Target aria-hidden className="mr-1 inline size-3" />
                  Pointing
                </TabsTrigger>
              )}
            </TabsList>
          }
        />

        <div className="min-h-0 flex-1 p-2.5">
          <TabsContent value="timeline" className="astra-rise">
            <div className="flex h-full flex-col justify-center gap-2">
              <PatTimeline />
              <p className="text-[9px] leading-snug text-muted-foreground/70">
                Built from the state machine's own transitions as they happened. Segment widths are
                real durations, so a two-frame excursion into RECOVER is two frames wide.
              </p>
            </div>
          </TabsContent>

          <TabsContent value="gimbal" className="astra-rise">
            <div className="flex h-full min-h-0 gap-3">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
                <AxisResponseChart axis="pan" />
                <AxisResponseChart axis="tilt" />
              </div>
              {/* Off by default. The toggle is in Controls › Mount, beside the
                  jog buttons whose effect this panel explains. */}
              {showActuatorTruth && (
                <div className="w-[260px] shrink-0 overflow-y-auto rounded-sm border border-truth/40">
                  <ActuatorTruthPanel />
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="estimator" className="astra-rise h-full">
            <ModelProbabilityChart />
          </TabsContent>

          <TabsContent value="identity" className="astra-rise h-full">
            <IdentityCorrelationChart
              minCorrelation={IDENTITY.minCorrelation}
              mismatchCorrelation={IDENTITY.mismatchCorrelation}
            />
          </TabsContent>

          {engineering && (
            <TabsContent value="pointing" className="astra-rise h-full">
              <div className="flex h-full flex-col gap-1">
                <div className="flex items-center gap-2">
                  <StatusBadge
                    status="idle"
                    label="Ground truth"
                    className="border-truth/50 bg-truth/12 text-truth"
                  />
                  {!showEvaluation && (
                    <span className="text-[9px] text-muted-foreground">
                      Evaluation is hidden; nothing is being recorded to plot.
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  <PointingErrorChart />
                </div>
              </div>
            </TabsContent>
          )}
        </div>
      </Tabs>
    </Panel>
  );
}
