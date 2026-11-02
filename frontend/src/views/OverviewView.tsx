import type { QuotaSnapshot, SentryAlertState } from '../types';
import { QuotaGrid } from '../components/QuotaGrid';
import { ActivityView } from './ActivityView';

interface OverviewViewProps {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  minHeadroomPercent?: number;
}

export const OverviewView = ({
  quota,
  alerts,
  minHeadroomPercent = 10,
}: OverviewViewProps) => (
  <div>
    <QuotaGrid quota={quota} minHeadroomPercent={minHeadroomPercent} />
    <ActivityView alerts={alerts} />
  </div>
);
