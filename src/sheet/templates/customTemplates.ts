import { reactive } from 'vue'
import type { TitleBlockTemplate } from './types'

const STORAGE_KEY = 'envcad.customTitleBlockTemplates'

function loadFromStorage(): TitleBlockTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveToStorage(templates: TitleBlockTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // storage unavailable (e.g. private browsing) — custom templates just won't persist
  }
}

export const customTemplateStore = reactive<{ templates: TitleBlockTemplate[] }>({
  templates: typeof localStorage !== 'undefined' ? loadFromStorage() : []
})

export function addCustomTemplate(template: TitleBlockTemplate): void {
  const index = customTemplateStore.templates.findIndex(t => t.id === template.id)
  if (index >= 0) customTemplateStore.templates.splice(index, 1, template)
  else customTemplateStore.templates.push(template)
  saveToStorage(customTemplateStore.templates)
}

export function removeCustomTemplate(id: string): void {
  const index = customTemplateStore.templates.findIndex(t => t.id === id)
  if (index < 0) return
  customTemplateStore.templates.splice(index, 1)
  saveToStorage(customTemplateStore.templates)
}

export function exportTemplateToJson(template: TitleBlockTemplate): string {
  return JSON.stringify(template, null, 2)
}

export function importTemplateFromJson(json: string): TitleBlockTemplate {
  const template = validateTemplate(JSON.parse(json))
  addCustomTemplate(template)
  return template
}

function validateTemplate(value: unknown): TitleBlockTemplate {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid template JSON: expected an object')
  }
  const candidate = value as Partial<TitleBlockTemplate>
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error('Invalid template JSON: missing "id"')
  }
  if (typeof candidate.name !== 'string' || !candidate.name) {
    throw new Error('Invalid template JSON: missing "name"')
  }
  if (!Array.isArray(candidate.supportedPapers)) {
    throw new Error('Invalid template JSON: missing "supportedPapers"')
  }
  if (!Array.isArray(candidate.frame)) {
    throw new Error('Invalid template JSON: missing "frame"')
  }
  if (!Array.isArray(candidate.fields)) {
    throw new Error('Invalid template JSON: missing "fields"')
  }

  return {
    id: candidate.id,
    name: candidate.name,
    description: typeof candidate.description === 'string' ? candidate.description : '',
    supportedPapers: candidate.supportedPapers as TitleBlockTemplate['supportedPapers'],
    frame: candidate.frame as TitleBlockTemplate['frame'],
    fields: candidate.fields as TitleBlockTemplate['fields'],
    northArrow: candidate.northArrow,
    scaleBar: candidate.scaleBar
  }
}
