/**
 * Reliable WhatsApp media upload helpers.
 *
 * Generated PDFs are first downloaded by our server, uploaded to the
 * WhatsApp Cloud API /{phone_number_id}/media endpoint, then sent using the
 * returned media id. This avoids Meta needing to fetch a Supabase URL itself.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    type?: string
  }
}

async function metaError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = (await response.json()) as MetaErrorResponse
    return new Error(data.error?.message || fallback)
  } catch {
    return new Error(fallback)
  }
}

export interface UploadMediaFromUrlToMetaArgs {
  phoneNumberId: string
  accessToken: string
  sourceUrl: string
  filename: string
  mimeType?: string
}

export async function uploadMediaFromUrlToMeta(
  args: UploadMediaFromUrlToMetaArgs,
): Promise<{ mediaId: string }> {
  const {
    phoneNumberId,
    accessToken,
    sourceUrl,
    filename,
    mimeType = 'application/pdf',
  } = args

  if (!sourceUrl) throw new Error('Media source URL is required.')

  // Download the file ourselves instead of making Meta fetch the URL.
  const sourceResponse = await fetch(sourceUrl, {
    method: 'GET',
    cache: 'no-store',
  })

  if (!sourceResponse.ok) {
    throw new Error(
      `Could not download media before Meta upload: HTTP ${sourceResponse.status}`,
    )
  }

  const bytes = await sourceResponse.arrayBuffer()
  if (!bytes.byteLength) {
    throw new Error('Downloaded media is empty.')
  }

  const actualMimeType =
    sourceResponse.headers.get('content-type')?.split(';')[0]?.trim() || mimeType

  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', actualMimeType)
  form.append('file', new Blob([bytes], { type: actualMimeType }), filename)

  const uploadResponse = await fetch(
    `${META_API_BASE}/${phoneNumberId}/media`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    },
  )

  if (!uploadResponse.ok) {
    throw await metaError(
      uploadResponse,
      `Meta media upload failed: HTTP ${uploadResponse.status}`,
    )
  }

  const data = (await uploadResponse.json()) as { id?: string }
  if (!data.id) {
    throw new Error('Meta media upload succeeded but returned no media id.')
  }

  return { mediaId: data.id }
}

export interface SendMediaByIdArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  mediaId: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export async function sendMediaById(
  args: SendMediaByIdArgs,
): Promise<{ messageId: string }> {
  const {
    phoneNumberId,
    accessToken,
    to,
    kind,
    mediaId,
    caption,
    filename,
    contextMessageId,
  } = args

  if (!mediaId) throw new Error('Meta media id is required.')

  const media: Record<string, unknown> = { id: mediaId }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: kind,
    [kind]: media,
  }

  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }

  const response = await fetch(
    `${META_API_BASE}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok) {
    throw await metaError(
      response,
      `Meta media send failed: HTTP ${response.status}`,
    )
  }

  const data = (await response.json()) as {
    messages?: Array<{ id?: string }>
  }

  const messageId = data.messages?.[0]?.id
  if (!messageId) {
    throw new Error('Meta media send succeeded but returned no message id.')
  }

  return { messageId }
}
