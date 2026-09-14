import { getView } from '@/app/views';
import { NotImplementedView } from '@/components/shell/NotImplementedView';

export function ReportsView(): React.JSX.Element {
  return <NotImplementedView view={getView('reports')} />;
}
