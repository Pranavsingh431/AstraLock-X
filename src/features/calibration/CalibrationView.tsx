import { getView } from '@/app/views';
import { NotImplementedView } from '@/components/shell/NotImplementedView';

export function CalibrationView(): React.JSX.Element {
  return <NotImplementedView view={getView('calibration')} />;
}
