/** Deployment environment for the admin API. */
export type ApiEnv = 'dev' | 'production';

export const API_BASE_URLS: Record<ApiEnv, string> = {
  dev: 'http://localhost:3001',
  production: 'https://api-production-9401.up.railway.app',
};

export type TonePreference = 'grounded' | 'open' | 'mystical';
export type SessionContext =
  | 'general'
  | 'sleep'
  | 'nap'
  | 'meditation'
  | 'workout'
  | 'focus'
  | 'walk'
  | 'chores';

export interface Intent {
  id: string;
  userId: string;
  title: string;
  emoji: string | null;
  rawText: string;
  tonePreference: TonePreference | null;
  sessionContext: SessionContext;
  // nl#425 — VoicePerspective is declared further down (originally added for
  // CoachDto, #3116); reused here rather than a second hand-mirrored copy.
  voicePerspective: VoicePerspective;
  isCatalog: boolean;
  catalogSlug: string | null;
  catalogCategory: string | null;
  catalogDescription: string | null;
  catalogOrder: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Affirmation {
  id: string;
  setId: string;
  text: string;
  tone: string;
  intensity: number;
  length: string;
  tags: string[];
  weight: number;
  isFavorite: boolean;
  isEnabled: boolean;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface Inspiration {
  name: string;
  relevance: string;
}

export interface AffirmationSet {
  id: string;
  intentId: string;
  source: string;
  createdAt: string;
  inspirations?: Inspiration[] | null;
  affirmations: Affirmation[];
  /**
   * #132 — the coach that authored the set. The YouTube publish path selects
   * its per-coach visual config from this field and hard-fails when it is null,
   * so a caller needs to be able to see what was actually persisted. The column
   * has always been on the wire (the admin client does not strip unknown keys);
   * this declaration is the type catching up, not a new field.
   */
  coachKey?: string | null;
}

export interface CreateIntentInput {
  rawText: string;
  tonePreference?: TonePreference | undefined;
  sessionContext?: SessionContext | undefined;
}

/**
 * #132 — options for an admin generation run.
 *
 * `coachKey` is the coach recorded on the resulting `AffirmationSet`. OMITTING
 * it is meaningful and correct on a regenerate: the API then inherits the
 * previous set's coach (`AdminIntentService.resolveGenerationCoachKey`), so a
 * regeneration cannot silently drop one that was already established.
 */
export interface GenerateAffirmationsInput {
  coachKey?: string | undefined;
}

export interface UpdateIntentInput {
  tonePreference?: TonePreference | undefined;
  sessionContext?: SessionContext | undefined;
  title?: string | undefined;
  rawText?: string | undefined;
  emoji?: string | null | undefined;
  // nl#425 — correcting an existing intent's perspective (mirrors #133's API
  // route). Generation reads the intent's stored value, so a set cannot be
  // regenerated in second person without this.
  voicePerspective?: VoicePerspective | undefined;
}

/**
 * Input for thought-leader styled generation (#2730). `corpus` is the source
 * material, `styleNotes` is the hand-authored rhetorical style profile, and
 * `attribution` is the credit string.
 *
 * `intentText` (#2733) is an optional NEUTRAL practice description used as the
 * intent's rawText. It must NOT name a public figure — `attribution` is stored
 * separately for display and must never feed the safety gatekeeper. When
 * omitted, the API uses a neutral synthetic rawText.
 */
export interface ThoughtLeaderInput {
  corpus: string;
  /**
   * #2744 — Optional rhetorical style profile (voice dial). Independent of
   * `anchorQuotes`; omit for anchorQuotes-only or neutral generation.
   */
  styleNotes?: Record<string, unknown> | undefined;
  attribution: string;
  intentText?: string | undefined;
  title?: string | undefined;
  tone?: TonePreference | undefined;
  sourceTitle?: string | undefined;
  sourceAuthor?: string | undefined;
  /**
   * #2740/#2744 — Curated array of exact lines to include near-verbatim. The
   * mere PRESENCE of a non-empty array activates quote-forward generation
   * (anchors blended near-verbatim with style-informed originals) — there is no
   * separate mode flag.
   */
  anchorQuotes?: string[] | undefined;
}

export interface CatalogPublishInput {
  slug: string;
  category: string;
  order: number;
  description: string;
  emoji?: string | undefined;
}

export interface UpdateAffirmationItem {
  id: string;
  text?: string | undefined;
  isEnabled?: boolean | undefined;
  tone?: string | undefined;
  intensity?: number | undefined;
}

export interface UpdateAffirmationsInput {
  affirmations: UpdateAffirmationItem[];
}

export interface UpdateAffirmationsResult {
  affirmationSet: AffirmationSet;
  updated: number;
}

/** #132 / #264 — result of repairing an affirmation set's authoring coach. */
export interface SetAffirmationSetCoachResult {
  affirmationSetId: string;
  coachKey: string;
  /** What the field held before, so a mistaken overwrite is visible. */
  previousCoachKey: string | null;
}

export interface SyncAffirmationItem {
  id?: string | undefined;
  text: string;
  enabled: boolean;
}

export interface SyncAffirmationsInput {
  affirmations: SyncAffirmationItem[];
}

export interface SyncAffirmationsResult {
  affirmationSet: AffirmationSet;
  added: number;
  removed: number;
  updated: number;
}

export interface IntentStats {
  playCount: number;
  completedCount: number;
  lastPlayedAt: string | null;
  totalListenSeconds: number;
  createdAt: string;
}

export type LibrarySort = 'recent' | 'created' | 'most-played' | 'last-played' | 'title';
export type LibraryFilter = 'has-audio' | 'no-audio' | 'never-played';

export interface LibraryQueryParams {
  sort?: LibrarySort | undefined;
  filter?: LibraryFilter | undefined;
  playedSince?: string | undefined;
  notPlayedSince?: string | undefined;
  context?: string | undefined;
}

export interface ListIntentsQuery {
  isCatalog?: boolean | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface RenderConfigInput {
  voiceId: string;
  sessionContext: SessionContext;
  durationMinutes: number;
  durationSeconds?: number | undefined;
  paceWpm?: number | undefined;
  pauseMsBetweenAffirmations?: number | undefined;
  backgroundAudioPath?: string | null | undefined;
  backgroundVolume?: number | undefined;
  normalizeLoudness?: boolean | undefined;
  affirmationRepeatCount?: number | undefined;
  includePreamble?: boolean | undefined;
  preambleText?: string | null | undefined;
  postambleText?: string | null | undefined;
  playAll?: boolean | undefined;
  repetitionModel?: 'sequential' | 'shuffle' | undefined;
  binauralPreset?: 'theta' | 'alpha' | 'beta' | null | undefined;
  binauralVolume?: number | null | undefined;
  subliminalEnabled?: boolean | undefined;
  subliminalVolume?: number | null | undefined;
}

export interface RenderConfig {
  id: string;
  intentId: string;
  affirmationSetId: string;
  voiceId: string | null;
  voiceProvider: string;
  sessionContext: SessionContext;
  paceWpm: number;
  pauseMsBetweenAffirmations: number;
  durationSeconds: number;
  backgroundAudioPath: string | null;
  backgroundVolume: number;
  normalizeLoudness: boolean;
  affirmationRepeatCount: number;
  repetitionModel: string;
  binauralPreset: string | null;
  binauralVolume: number | null;
  subliminalEnabled: boolean;
  subliminalVolume: number | null;
  includePreamble: boolean;
  preambleText: string | null;
  postambleText: string | null;
  playAll: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundSound {
  id: string;
  name: string;
  description: string;
  category: string;
  contentType: string;
  mood: string;
  storageKey: string;
  durationSeconds: number;
  sortOrder: number;
  enabled: boolean;
  contexts: SessionContext[];
}

export interface UpdateBackgroundInput {
  name?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  contentType?: string | undefined;
  mood?: string | undefined;
  sortOrder?: number | undefined;
  contexts?: SessionContext[] | undefined;
  enabled?: boolean | undefined;
}

export interface RenderStatus {
  status: 'none' | 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  errorMessage: string | null;
  jobId?: string;
}

export interface PreambleTier {
  brief: string | null;
  standard: string | null;
  extended: string | null;
}

export interface ContextPreambleConfig {
  preamble: PreambleTier;
  postamble: PreambleTier;
}

export interface PreambleUpdateInput {
  preamble?: string | null | undefined;
  postamble?: string | null | undefined;
}

/**
 * Persisted references to a voice, used to decide whether it can be safely
 * retired. `total === 0` means nothing points at the voice.
 *
 * `total` deliberately over-counts rather than under-counts — it is a safety
 * signal, not an exact row count.
 */
export interface VoiceUsage {
  renderConfigs: number;
  userContextSettings: number;
  generationJobs: number;
  sharedSnapshots: number;
  sharedSnapshotConfigs: number;
  total: number;
}

export interface Voice {
  id: string;
  externalId: string;
  displayName: string;
  provider: string;
  gender: string;
  accent: string;
  tier: string;
  sortOrder: number;
  enabled: boolean;
  contexts: SessionContext[];
  /** Present only when the voice list was requested with `includeUsage`. */
  usage?: VoiceUsage;
}

export interface CreateVoiceInput {
  externalId: string;
  displayName: string;
  description: string;
  gender: string;
  accent: string;
  tier?: string;
  category?: string;
  contexts?: SessionContext[];
  sortOrder?: number;
  enabled?: boolean;
  tags?: { ageGroup: string; styles: string[]; qualities: string[] };
}

/**
 * Mutable voice metadata. `id` and `externalId` are intentionally absent —
 * they are identity, and the API rejects them outright.
 */
export interface UpdateVoiceInput {
  displayName?: string;
  gender?: string;
  accent?: string;
  tier?: string;
  sortOrder?: number;
}

export interface ListVoicesOptions {
  context?: SessionContext;
  /** Attach per-voice reference counts (`Voice.usage`). Off by default. */
  includeUsage?: boolean;
}

// --- Coach DTO (#3116) — client-safe wire shape from GET /coaches -----------

export type VoicePerspective = 'first_person' | 'second_person';

/**
 * nl#425 — user-facing intent DTOs (`IntentDetail` in user-client.ts) don't
 * carry `voicePerspective` at all, so the two call sites that map one into an
 * `Intent` (cli.ts's `fetchSetFileDataUser`, user-mcp.ts's `fetchSetFileData`)
 * need a stand-in. Named here once so both import it rather than each
 * hardcoding the literal (the DB's own column default, #133 — matches product
 * default, not a per-call-site decision).
 */
export const DEFAULT_USER_INTENT_VOICE_PERSPECTIVE: VoicePerspective = 'second_person';

/** One sized/format portrait variant. Mirrors `coachPortraitVariantDtoSchema` in core. */
export interface CoachPortraitVariantDto {
  height: number;
  jpgPath: string;
  webpPath: string;
}

/** Presentation assets for a coach. Mirrors `coachVisualDtoSchema` in core. */
export interface CoachVisualDto {
  iconRef: string;
  focalPoint: { x: number; y: number };
  aspectRatio: number;
  imagePath: string;
  thumbPath: string;
  portraits: CoachPortraitVariantDto[];
}

/**
 * Wire DTO for a coach.
 *
 * ⚠️ The AUTHORITY for this shape is `coachDtoSchema` in `@neuralingual/core` —
 * the API validates its response against it. This declaration exists because
 * the public repo is standalone and cannot resolve a workspace package (#194);
 * it is not a second source of truth. `coach-dto-parity.test.ts` asserts the
 * two are structurally identical, so a field added, removed or retyped in core
 * fails `pnpm typecheck` here rather than at publish time.
 *
 * ⛔ `key` is `string`, NOT the `CoachKey` union — deliberately. Copying
 * core's `z.enum(['cole','nia','theo','ilana'])` would
 * hand-maintain the coach roster in the published package, which is exactly
 * the defect #183 removed (the shipped schema advertised eight coaches #44 had
 * already cut). `tool-manifest.json` carries the ONE generated, byte-identical-
 * tested copy of the roster; nothing else in the public package may.
 */
export interface CoachDto {
  key: string;
  name: string;
  roleLabel: string;
  tagline: string;
  angle: string;
  stance: string;
  identityKit: { keywords: string[]; signaturePhrase: string };
  description: string;
  inspiredBy: string[];
  visual: CoachVisualDto;
  signatureVoiceId: string;
  defaultTone: TonePreference;
  voicePerspective: VoicePerspective;
  frameworkInfluence: string;
  styleInfluence: string;
}

