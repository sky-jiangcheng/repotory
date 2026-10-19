import { call } from './transport'
import type { ImportPreview } from './types'

export function previewKnowledgeImport(name: string): Promise<ImportPreview> {
  return call<ImportPreview>({ method: 'PreviewKnowledgeImport', args: [name] })
}