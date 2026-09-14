/**
 * Scenario import and export.
 *
 * Deliberately thin. The saved document is the validated configuration and
 * nothing else — no camera pose, no playback speed, no view toggles — because
 * those describe how someone was looking at a run rather than what the run was.
 * Reloading the file reproduces the world exactly.
 */

import { Download, Upload } from 'lucide-react';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import { useSimulationStore } from '@/stores/simulation-store';

import { deserializeScenario, scenarioFilename, serializeScenario } from '../scenario-io';

import { confirmIfRecording } from '../recording-guard';

export function ScenarioIoBar(): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const config = useSimulationStore((state) => state.config);
  const loadConfig = useSimulationStore((state) => state.loadConfig);
  const setImportError = useSimulationStore((state) => state.setImportError);
  const importError = useSimulationStore((state) => state.importError);

  const exportScenario = (): void => {
    const blob = new Blob([serializeScenario(config)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = scenarioFilename(config);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importScenario = async (file: File): Promise<void> => {
    const result = deserializeScenario(await file.text());
    if (!result.ok) {
      setImportError(result.message);
      return;
    }
    if (
      confirmIfRecording(
        'Importing a scenario will abort it: the raw record is kept, marked ABORTED, with no result.',
      )
    ) {
      loadConfig(result.config, null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={exportScenario} aria-label="Export scenario">
        <Download />
        Export
      </Button>

      <Button
        size="sm"
        variant="ghost"
        onClick={() => fileInput.current?.click()}
        aria-label="Import scenario"
      >
        <Upload />
        Import
      </Button>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Scenario file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void importScenario(file);
        }}
      />

      {importError !== null && (
        <span
          role="alert"
          className="max-w-md truncate text-xs text-destructive"
          title={importError}
        >
          {importError}
        </span>
      )}
    </div>
  );
}
