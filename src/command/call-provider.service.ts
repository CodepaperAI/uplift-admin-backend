import { z } from "zod";

export type ProviderCallContent = {
  providerCallId: string;
  title: string | null;
  startedAt: Date | null;
  durationSeconds: number | null;
  participantEmails: string[];
  organizerEmail: string | null;
  summary: string | null;
  actionItems: unknown[];
  transcriptUrl: string | null;
  recordingUrl: string | null;
  transcriptText: string;
  providerCreatedAt: Date | null;
};

const firefliesResponse = z.object({
  data: z
    .object({
      transcript: z
        .object({
          id: z.string(),
          title: z.string().nullable().optional(),
          date: z.number().nullable().optional(),
          duration: z.number().nullable().optional(),
          organizer_email: z.string().nullable().optional(),
          participants: z.array(z.string()).nullable().optional(),
          transcript_url: z.string().nullable().optional(),
          audio_url: z.string().nullable().optional(),
          video_url: z.string().nullable().optional(),
          summary: z
            .object({
              overview: z.string().nullable().optional(),
              action_items: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
          sentences: z
            .array(
              z.object({
                speaker_name: z.string().nullable().optional(),
                text: z.string(),
              }),
            )
            .nullable()
            .optional(),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const fathomTranscriptResponse = z.object({
  transcript: z.array(
    z.object({
      speaker: z
        .object({
          display_name: z.string().nullable().optional(),
          matched_calendar_invitee_email: z.string().nullable().optional(),
        })
        .optional(),
      text: z.string(),
      timestamp: z.string().optional(),
    }),
  ),
});

function boundedTranscript(lines: string[]): string {
  return lines.join("\n").slice(0, 160_000);
}

export async function fetchFirefliesCall(
  meetingId: string,
): Promise<ProviderCallContent> {
  const apiKey = process.env.FIREFLIES_API_KEY?.trim();
  if (!apiKey) throw new Error("Fireflies is not configured");
  const response = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query CommandTranscript($id: String!) {
        transcript(id: $id) {
          id title date duration organizer_email participants transcript_url audio_url video_url
          summary { overview action_items }
          sentences { speaker_name text }
        }
      }`,
      variables: { id: meetingId },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Fireflies request failed (${response.status})`);
  const parsed = firefliesResponse.parse(await response.json());
  if (parsed.errors?.length) throw new Error("Fireflies returned a GraphQL error");
  const transcript = parsed.data?.transcript;
  if (!transcript) throw new Error("Fireflies transcript is not ready");
  const actionItems = transcript.summary?.action_items
    ? transcript.summary.action_items
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];
  return {
    providerCallId: transcript.id,
    title: transcript.title ?? null,
    startedAt: transcript.date ? new Date(transcript.date) : null,
    durationSeconds: transcript.duration
      ? Math.max(0, Math.round(transcript.duration * 60))
      : null,
    participantEmails: (transcript.participants ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    organizerEmail: transcript.organizer_email?.trim().toLowerCase() ?? null,
    summary: transcript.summary?.overview?.slice(0, 20_000) ?? null,
    actionItems,
    transcriptUrl: transcript.transcript_url ?? null,
    recordingUrl: transcript.video_url ?? transcript.audio_url ?? null,
    transcriptText: boundedTranscript(
      (transcript.sentences ?? []).map(
        (sentence) => `${sentence.speaker_name ?? "Speaker"}: ${sentence.text}`,
      ),
    ),
    providerCreatedAt: transcript.date ? new Date(transcript.date) : null,
  };
}

export async function fetchFathomTranscript(
  recordingId: string,
): Promise<string> {
  if (!/^\d+$/.test(recordingId)) throw new Error("Invalid Fathom recording id");
  const apiKey = process.env.FATHOM_API_KEY?.trim();
  if (!apiKey) throw new Error("Fathom is not configured");
  const response = await fetch(
    `https://api.fathom.ai/external/v1/recordings/${encodeURIComponent(recordingId)}/transcript`,
    {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`Fathom request failed (${response.status})`);
  const parsed = fathomTranscriptResponse.parse(await response.json());
  return boundedTranscript(
    parsed.transcript.map(
      (line) =>
        `${line.speaker?.display_name ?? line.speaker?.matched_calendar_invitee_email ?? "Speaker"}: ${line.text}`,
    ),
  );
}
