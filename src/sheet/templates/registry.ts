import { BUILTIN_TEMPLATES } from './builtin'
import { customTemplateStore } from './customTemplates'
import type { TitleBlockTemplate } from './types'

export function listTemplates(): TitleBlockTemplate[] {
  return [...BUILTIN_TEMPLATES, ...customTemplateStore.templates]
}

export function getTemplateById(id: string | undefined): TitleBlockTemplate | undefined {
  if (!id) return undefined
  return listTemplates().find(template => template.id === id)
}
