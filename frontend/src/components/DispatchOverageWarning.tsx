import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Icon } from './Icon';

interface DispatchOverageWarningProps {
  family: string;
  headroomPct: number;
  minHeadroom: number;
  allowOverage: boolean;
  onAllowOverageChange: (val: boolean) => void;
}

export const DispatchOverageWarning = ({
  family,
  headroomPct,
  minHeadroom,
  allowOverage,
  onAllowOverageChange,
}: DispatchOverageWarningProps) => {
  return (
    <div class="flex flex-col gap-2 rounded-lg border border-pine-gold bg-pine-gold/20 p-3 text-xs font-medium text-pine-gold">
      <div class="flex items-start gap-2.5">
        <Icon icon={faTriangleExclamation} class="mt-0.5 size-4 shrink-0" />
        <span>
          <strong>Low Pool Headroom Warning ({family}):</strong> Remaining quota ({headroomPct}%) is
          below the {minHeadroom}% safety floor. Dispatching now may incur paid AI overage charges
          or consume flex credits.
        </span>
      </div>
      <label
        for="allowOverageInput"
        class="mt-1 flex cursor-pointer items-center gap-2 font-medium text-pine-text select-none"
      >
        <input
          id="allowOverageInput"
          name="allowOverage"
          type="checkbox"
          class="cursor-pointer rounded-sm accent-pine-gold"
          checked={allowOverage}
          onChange={(e) => onAllowOverageChange((e.target as HTMLInputElement).checked)}
        />
        <span>Allow AI overcharges / paid credit usage</span>
      </label>
    </div>
  );
};
