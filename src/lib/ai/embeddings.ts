import { AiError, type EmbeddingsProvider } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
const GEMINI_BATCH_EMBEDDINGS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents'

export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMENSIONS = 1536
const BATCH_SIZE = 96

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[]
}
interface GeminiEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export async function embedTexts(
  apiKey: string,
  inputs: string[],
  provider: EmbeddingsProvider = 'openai',
): Promise<number[][]> {
  if (inputs.length === 0) return []
  return provider === 'gemini'
    ? embedWithGemini(apiKey, inputs)
    : embedWithOpenAi(apiKey, inputs)
}

async function embedWithOpenAi(apiKey: string, inputs: string[]): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)
    let res: Response
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('OpenAI embeddings', res)
    const rows = ((await res.json().catch(() => null)) as OpenAiEmbeddingResponse | null)?.data
    if (!rows || rows.length !== batch.length || rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was malformed.', { code: 'embeddings_malformed' })
    }
    for (const row of [...rows].sort((a, b) => a.index! - b.index!)) {
      if (!Array.isArray(row.embedding)) {
        throw new AiError('Embeddings response missing a valid vector.', { code: 'embeddings_malformed' })
      }
      out.push(row.embedding)
    }
  }
  return out
}

async function embedWithGemini(apiKey: string, inputs: string[]): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs()
  const out: number[][] = []
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)
    let res: Response
    try {
      res = await fetch(GEMINI_BATCH_EMBEDDINGS_URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            taskType: 'SEMANTIC_SIMILARITY',
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Gemini embeddings', res)
    const rows = ((await res.json().catch(() => null)) as GeminiEmbeddingResponse | null)?.embeddings
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Gemini embeddings response was malformed.', { code: 'embeddings_malformed' })
    }
    for (const row of rows) {
      if (!Array.isArray(row.values) || row.values.length !== EMBEDDING_DIMENSIONS) {
        throw new AiError('Gemini embeddings response missing a valid vector.', { code: 'embeddings_malformed' })
      }
      out.push(row.values)
    }
  }
  return out
}
