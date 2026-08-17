import { z } from "zod"

export interface PresetCatalog<T> {
  version: number
  categories: string[]
  presets: PresetDefinition<T>[]
}

export interface PresetDefinition<T> {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  preview?: string
  definition: T
}

export interface PresetStorageData<T> {
  version: number
  presets: PresetDefinition<T>[]
  favorites: string[]
}

export interface PresetStorage<T> {
  load: () => Promise<PresetStorageData<T> | null>
  save: (data: PresetStorageData<T>) => Promise<void>
}

export type PresetPersistence<T> = PresetStorage<T>

export interface PresetFilter {
  category?: string
  query?: string
  favoritesOnly?: boolean
}

export interface CustomPresetInput<T> {
  id?: string
  name: string
  description: string
  category: string
  tags?: string[]
  preview?: string
  definition: T
}

export interface PresetRegistrySnapshot<T> {
  presets: PresetDefinition<T>[]
  categories: string[]
  favoriteIds: string[]
  customPresetIds: string[]
  isLoaded: boolean
}

export type PresetDefinitionSchema<T> = z.ZodType<T>

const presetDefinitionBaseSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  category: z.string().trim().min(1).max(80),
  tags: z.array(z.string().trim().min(1).max(60)).max(32).default([]),
  preview: z.string().trim().min(1).optional(),
  definition: z.unknown(),
})

const presetCatalogBaseSchema = z.object({
  version: z.number().int().positive(),
  categories: z.array(z.string().trim().min(1).max(80)),
  presets: z.array(presetDefinitionBaseSchema),
})

export class PresetRegistryError extends Error {
  readonly code: "invalid_preset" | "preset_not_found" | "builtin_preset" | "duplicate_preset"

  constructor(
    code: "invalid_preset" | "preset_not_found" | "builtin_preset" | "duplicate_preset",
    message: string,
  ) {
    super(message)
    this.name = "PresetRegistryError"
    this.code = code
  }
}

/** Validate a built-in catalog at the JSON/module boundary. */
export function parsePresetCatalog<T>(
  value: unknown,
  definitionSchema?: PresetDefinitionSchema<T>,
): PresetCatalog<T> {
  const parsed = presetCatalogBaseSchema.safeParse(value)
  if (!parsed.success) {
    throw new PresetRegistryError("invalid_preset", "Preset catalog is invalid")
  }

  const presets = parsed.data.presets.map((preset) =>
    parsePresetDefinition(preset, definitionSchema),
  )
  const ids = new Set<string>()
  for (const preset of presets) {
    if (ids.has(preset.id)) {
      throw new PresetRegistryError("duplicate_preset", `Preset ID "${preset.id}" is duplicated`)
    }
    ids.add(preset.id)
  }

  return {
    version: parsed.data.version,
    categories: uniqueStrings([
      ...parsed.data.categories,
      ...presets.map((preset) => preset.category),
    ]),
    presets,
  }
}

export class PresetRegistry<T> {
  private readonly builtinCatalog: PresetCatalog<T>
  private readonly definitionSchema?: PresetDefinitionSchema<T>
  private readonly storage?: PresetStorage<T>
  private readonly customPresets = new Map<string, PresetDefinition<T>>()
  private readonly favoriteIds = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private writePromise: Promise<void> = Promise.resolve()
  private loadPromise: Promise<void> | null = null
  private loaded = false
  private snapshot: PresetRegistrySnapshot<T>

  constructor(
    catalog: PresetCatalog<T>,
    options: { definitionSchema?: PresetDefinitionSchema<T>; storage?: PresetStorage<T> } = {},
  ) {
    this.builtinCatalog = parsePresetCatalog(catalog, options.definitionSchema)
    this.definitionSchema = options.definitionSchema
    this.storage = options.storage
    this.snapshot = this.createSnapshot()
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get builtInCatalog(): PresetCatalog<T> {
    return {
      ...this.builtinCatalog,
      categories: [...this.builtinCatalog.categories],
      presets: this.builtinCatalog.presets.map((preset) => ({ ...preset, tags: [...preset.tags] })),
    }
  }

  getBuiltInPresets(): PresetDefinition<T>[] {
    return this.builtinCatalog.presets.map((preset) => clonePreset(preset))
  }

  getCustomPresets(): PresetDefinition<T>[] {
    return [...this.customPresets.values()].map((preset) => clonePreset(preset))
  }

  getSnapshot = (): PresetRegistrySnapshot<T> => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getCategories(): string[] {
    return uniqueStrings([
      ...this.builtinCatalog.categories,
      ...[...this.customPresets.values()].map((preset) => preset.category),
    ])
  }

  getAll(): PresetDefinition<T>[] {
    return [...this.builtinCatalog.presets, ...this.customPresets.values()].map((preset) =>
      clonePreset(preset),
    )
  }

  list(filter: PresetFilter = {}): PresetDefinition<T>[] {
    const query = filter.query?.trim().toLocaleLowerCase()
    return this.getAll().filter((preset) => {
      if (filter.category && preset.category !== filter.category) return false
      if (filter.favoritesOnly && !this.favoriteIds.has(preset.id)) return false
      if (!query) return true
      return [preset.name, preset.description, preset.category, ...preset.tags].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    })
  }

  search(query: string, filter: Omit<PresetFilter, "query"> = {}): PresetDefinition<T>[] {
    return this.list({ ...filter, query })
  }

  getPresetById(id: string): PresetDefinition<T> | undefined {
    const preset =
      this.customPresets.get(id) ?? this.builtinCatalog.presets.find((item) => item.id === id)
    return preset ? clonePreset(preset) : undefined
  }

  getPreset(id: string): PresetDefinition<T> | undefined {
    return this.getPresetById(id)
  }

  isCustomPreset(id: string): boolean {
    return this.customPresets.has(id)
  }

  isFavorite(id: string): boolean {
    return this.favoriteIds.has(id)
  }

  getFavorites(): string[] {
    return [...this.favoriteIds]
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      const stored = this.storage ? await this.storage.load() : null
      if (stored) {
        for (const rawPreset of stored.presets) {
          const preset = parseStoredPreset(rawPreset, this.definitionSchema)
          if (!preset || this.hasBuiltInId(preset.id)) continue
          this.customPresets.set(preset.id, preset)
        }

        const knownIds = new Set(this.getAll().map((preset) => preset.id))
        for (const favoriteId of stored.favorites) {
          if (knownIds.has(favoriteId)) this.favoriteIds.add(favoriteId)
        }
      }
      this.loaded = true
      this.refreshSnapshot()
    })()

    try {
      await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  async loadCustomPresets(): Promise<PresetDefinition<T>[]> {
    await this.load()
    return this.getCustomPresets()
  }

  async saveCustomPreset(
    input: CustomPresetInput<T> | PresetDefinition<T>,
  ): Promise<PresetDefinition<T>> {
    const normalized = normalizePresetInput(input)
    const id = normalized.id ?? createCustomPresetId(normalized.name)
    if (this.hasBuiltInId(id)) {
      throw new PresetRegistryError("builtin_preset", `Built-in preset "${id}" cannot be replaced`)
    }

    const preset = parsePresetDefinition(
      { ...normalized, id, tags: normalized.tags ?? [] },
      this.definitionSchema,
    )
    this.customPresets.set(id, preset)
    this.refreshSnapshot()
    await this.persist()
    return clonePreset(preset)
  }

  async renameCustomPreset(id: string, name: string): Promise<PresetDefinition<T>> {
    const current = this.requireCustomPreset(id)
    return this.saveCustomPreset({ ...current, name })
  }

  async deleteCustomPreset(id: string): Promise<boolean> {
    if (!this.customPresets.delete(id)) return false
    this.favoriteIds.delete(id)
    this.refreshSnapshot()
    await this.persist()
    return true
  }

  async setFavorite(id: string, favorite: boolean): Promise<boolean> {
    if (!this.getPresetById(id)) return false
    if (favorite) this.favoriteIds.add(id)
    else this.favoriteIds.delete(id)
    this.refreshSnapshot()
    await this.persist()
    return true
  }

  async toggleFavorite(id: string): Promise<boolean> {
    const next = !this.favoriteIds.has(id)
    const changed = await this.setFavorite(id, next)
    return changed && next
  }

  async waitForPersistence(): Promise<void> {
    await this.writePromise
  }

  private hasBuiltInId(id: string): boolean {
    return this.builtinCatalog.presets.some((preset) => preset.id === id)
  }

  private requireCustomPreset(id: string): PresetDefinition<T> {
    const preset = this.customPresets.get(id)
    if (!preset) {
      throw new PresetRegistryError("preset_not_found", `Custom preset "${id}" was not found`)
    }
    return clonePreset(preset)
  }

  private async persist(): Promise<void> {
    if (!this.storage) return
    const data: PresetStorageData<T> = {
      version: this.builtinCatalog.version,
      presets: this.getCustomPresets(),
      favorites: this.getFavorites(),
    }
    this.writePromise = this.writePromise.then(() => this.storage?.save(data)).then(() => undefined)
    await this.writePromise
  }

  private createSnapshot(): PresetRegistrySnapshot<T> {
    return {
      presets: this.getAll(),
      categories: this.getCategories(),
      favoriteIds: this.getFavorites(),
      customPresetIds: [...this.customPresets.keys()],
      isLoaded: this.loaded,
    }
  }

  private refreshSnapshot(): void {
    this.snapshot = this.createSnapshot()
    this.listeners.forEach((listener) => listener())
  }
}

function parsePresetDefinition<T>(
  value: unknown,
  definitionSchema?: PresetDefinitionSchema<T>,
): PresetDefinition<T> {
  const base = presetDefinitionBaseSchema.safeParse(value)
  if (!base.success) {
    throw new PresetRegistryError("invalid_preset", "Preset definition is invalid")
  }
  const definition = definitionSchema?.safeParse(base.data.definition)
  if (definition && !definition.success) {
    throw new PresetRegistryError("invalid_preset", "Preset style definition is invalid")
  }

  return {
    id: base.data.id,
    name: base.data.name,
    description: base.data.description,
    category: base.data.category,
    tags: [...base.data.tags],
    ...(base.data.preview ? { preview: base.data.preview } : {}),
    definition: definition ? definition.data : (base.data.definition as T),
  }
}

function parseStoredPreset<T>(
  value: unknown,
  definitionSchema?: PresetDefinitionSchema<T>,
): PresetDefinition<T> | null {
  try {
    return parsePresetDefinition(value, definitionSchema)
  } catch {
    return null
  }
}

function normalizePresetInput<T>(
  input: CustomPresetInput<T> | PresetDefinition<T>,
): CustomPresetInput<T> {
  return {
    ...input,
    id: input.id?.trim() || undefined,
    name: input.name.trim(),
    description: input.description.trim(),
    category: input.category.trim(),
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
  }
}

function clonePreset<T>(preset: PresetDefinition<T>): PresetDefinition<T> {
  return {
    ...preset,
    tags: [...preset.tags],
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function createCustomPresetId(name: string): string {
  const slug = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `custom-${slug || "preset"}-${Date.now().toString(36)}-${suffix}`
}
