import { useInterval } from '@/hooks/use-interval';
import { checkMaterial } from '@/lib/services/materials';
import { Material } from '@/lib/types';

// While any material is 'indexing', poll its Vertex AI Search import
// operation via the check-material function, then let the screen refresh.
export function useIndexingPoll(materials: Material[], refresh: () => void) {
  const indexingIds = materials
    .filter((m) => m.status === 'indexing')
    .map((m) => m.id);

  useInterval(
    async () => {
      await Promise.all(indexingIds.map((id) => checkMaterial(id)));
      refresh();
    },
    indexingIds.length > 0 ? 12_000 : null,
  );
}
