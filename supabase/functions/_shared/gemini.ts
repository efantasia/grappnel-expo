// Gemini on Vertex AI via REST (generateContent). Context from Vertex AI
// Search is stuffed into the system instruction — same pattern as
// honeylove-data-bot's HoneyBot (no grounding config).

import { getGoogleAccessToken } from './google-auth.ts';
import { gcpConfig } from './config.ts';

function geminiEndpoint(): string {
  const { projectId, geminiLocation, geminiModel } = gcpConfig;
  const host =
    geminiLocation === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${geminiLocation}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${projectId}/locations/${geminiLocation}/publishers/google/models/${geminiModel}:generateContent`;
}

export async function generateText(
  systemInstruction: string,
  userPrompt: string,
): Promise<string> {
  const token = await getGoogleAccessToken();
  const response = await fetch(geminiEndpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 16384,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: { text?: string }) => p.text ?? '').join('');
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason ?? 'no candidates returned';
    throw new Error(`Gemini returned no text (${reason})`);
  }
  return text;
}
