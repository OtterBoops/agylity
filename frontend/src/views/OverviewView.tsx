import type { QuotaSnapshot, SentryAlertState } from '../types';
import { QuotaGrid } from '../components/QuotaGrid';
import { ActivityView } from './ActivityView';

interface OverviewViewProps {
  quota: QuotaSnapshot[];
  alerts: SentryAlertState | null;
  minHeadroomPercent?: number;
  error?: string | null;
  onRetry?: () => void;
}

export const OverviewView = ({
  quota,
  alerts,
  minHeadroomPercent = 10,
  error = null,
  onRetry,
}: OverviewViewProps) => (
  <div>
    <QuotaGrid
      quota={quota}
      minHeadroomPercent={minHeadroomPercent}
      error={error}
      onRetry={onRetry}
    />
    <ActivityView alerts={alerts} />
  </div>
);
