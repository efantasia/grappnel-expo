// Generates a study guide: retrieves the most relevant chunks from the
// user's indexed materials via Vertex AI Search (scoped by user_id and
// optionally a folder or explicit materials), then asks Gemini to write a
// structured Markdown guide from them.
//
// The row is created immediately with status 'generating' and the heavy work
// runs via EdgeRuntime.waitUntil, so the client gets the guide id right away
// and polls the study_guides row for completion.

import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { adminClient, getRequestUser } from '../_shared/supabase.ts';
import { searchChunks, RetrievedChunk } from '../_shared/discovery.ts';
import { generateText } from '../_shared/gemini.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const SYSTEM_PROMPT = `You are Grappnel, an expert study assistant that builds study guides for students from their own course materials.

You will receive a topic and numbered excerpts retrieved from the student's uploaded materials (textbooks, lecture notes, slides). Write a comprehensive study guide in Markdown based ONLY on those excerpts.

Requirements:
- Start with a one-paragraph overview of the topic.
- Organize the body into clear sections with ## headings; use bullet points, tables, and **bold key terms** where helpful.
- Include a "Key Terms" section defining important vocabulary.
- Include a "Self-Check Questions" section with 5-8 questions (answers in a separate "Answers" section at the end).
- Each excerpt is labeled with the file it came from. When a point comes from a specific source, cite it inline like [Source: <file name>], using the file name exactly as it appears in the excerpt label.
- If the excerpts only partially cover the topic, cover what they contain and add a short "Gaps to Review" note listing what the student should look up in their materials.
- Do not invent facts that are not supported by the excerpts.`;

// The materials table is the source of truth for file names; the titles
// Vertex returns with chunks can degrade to GCS object names (material ids).
async function fileNamesByMaterial(
  admin: SupabaseClient,
  userId: string,
  chunks: RetrievedChunk[],
): Promise<Map<string, string>> {
  const ids = [...new Set(chunks.map((c) => c.materialId).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data } = await admin
    .from('materials')
    .select('id, file_name')
    .in('id', ids)
    .eq('user_id', userId);
  return new Map((data ?? []).map((m) => [m.id as string, m.file_name as string]));
}

function buildContext(chunks: RetrievedChunk[], fileNames: Map<string, string>): string {
  return chunks
    .map((chunk, i) => `[${i + 1}] ${fileNames.get(chunk.materialId) ?? chunk.title}\n${chunk.content}`)
    .join('\n\n---\n\n');
}

async function runGeneration(
  guideId: string,
  userId: string,
  topic: string,
  folderId: string | null,
  materialIds: string[] | undefined,
): Promise<void> {
  const admin = adminClient();
  try {
    const chunks = await searchChunks(topic, {
      userId,
      folderId,
      materialIds,
    }, 15);

    if (chunks.length === 0) {
      await admin
        .from('study_guides')
        .update({
          status: 'error',
          error_message:
            'No indexed material matched this topic. Make sure your sources have finished indexing, or try a broader topic.',
        })
        .eq('id', guideId);
      return;
    }

    const fileNames = await fileNamesByMaterial(admin, userId, chunks);
    const content = await generateText(
      SYSTEM_PROMPT,
      `Topic: ${topic}\n\nExcerpts from my materials:\n\n${buildContext(chunks, fileNames)}`,
    );

    await admin
      .from('study_guides')
      .update({
        content,
        status: 'complete',
        source_count: new Set(chunks.map((c) => c.materialId)).size,
        error_message: null,
      })
      .eq('id', guideId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`generate-guide failed for ${guideId}:`, message);
    await admin
      .from('study_guides')
      .update({ status: 'error', error_message: message })
      .eq('id', guideId);
  }
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;

  const user = await getRequestUser(req);
  if (!user) return errorResponse('Unauthorized', 401);

  let body: {
    topic?: string;
    title?: string;
    folder_id?: string | null;
    material_ids?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }
  const topic = body.topic?.trim();
  if (!topic) return errorResponse('topic is required');

  const admin = adminClient();
  const { data: guide, error: insertError } = await admin
    .from('study_guides')
    .insert({
      user_id: user.id,
      folder_id: body.folder_id ?? null,
      title: body.title?.trim() || topic,
      topic,
      status: 'generating',
    })
    .select()
    .single();
  if (insertError || !guide) {
    return errorResponse(insertError?.message ?? 'Could not create guide', 500);
  }

  const generation = runGeneration(
    guide.id,
    user.id,
    topic,
    body.folder_id ?? null,
    body.material_ids,
  );
  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(generation);
  } else {
    await generation;
  }

  return jsonResponse({ guide });
});
