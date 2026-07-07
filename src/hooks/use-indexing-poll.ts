import { useInterval } from '@/hooks/use-interval';
import { checkMaterial } from '@/lib/services/materials';
import { Material } from '@/lib/types';

// While any material is 'transcribing' or 'indexing', poll the
// check-material function to settle its status, then let the screen refresh.
export function useIndexingPoll(materials: Material[], refresh: () => void) {
  const indexingIds = materials
    .filter((m) => m.status === 'indexing' || m.status === 'transcribing')
    .map((m) => m.id);

  useInterval(
    async () => {
      await Promise.all(indexingIds.map((id) => checkMaterial(id)));
      refresh();
    },
    indexingIds.length > 0 ? 12_000 : null,
  );
}
