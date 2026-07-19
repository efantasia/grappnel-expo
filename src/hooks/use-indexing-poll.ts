import { useInterval } from '@/hooks/use-interval';
import { checkMaterial } from '@/lib/services/materials';
import { Material } from '@/lib/types';

// While any material is still settling — 'transcribing'/'indexing', or its
// figure extraction is in flight (which runs in parallel and can outlast
// indexing) — poll check-material to settle it, then let the screen refresh.
export function useIndexingPoll(materials: Material[], refresh: () => void) {
  const indexingIds = materials
    .filter(
      (m) =>
        m.status === 'indexing' ||
        m.status === 'transcribing' ||
        m.figures_status === 'processing' ||
        m.figures_status === 'extracting',
    )
    .map((m) => m.id);

  useInterval(
    async () => {
      await Promise.all(indexingIds.map((id) => checkMaterial(id)));
      refresh();
    },
    indexingIds.length > 0 ? 12_000 : null,
  );
}
