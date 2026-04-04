/** Deployment environment for the API. */
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
  isCatalog: boolean;
  catalogSlug: string | null;
  catalogCategory: string | null;
  catalogSubtitle: string | null;
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

export interface RenderConfigInput {
  voiceId: string;
  sessionContext: SessionContext;
  durationMinutes: number;
  paceWpm?: number | undefined;
  backgroundAudioPath?: string | null | undefined;
  backgroundVolume?: number | undefined;
  affirmationRepeatCount?: number | undefined;
  includePreamble?: boolean | undefined;
  playAll?: boolean | undefined;
}

export interface RenderConfig {
  id: string;
  intentId: string;
  affirmationSetId: string;
  voiceId: string | null;
  voiceProvider: string;
  sessionContext: SessionContext;
  paceWpm: number;
  durationSeconds: number;
  backgroundAudioPath: string | null;
  backgroundVolume: number;
  affirmationRepeatCount: number;
  includePreamble: boolean;
  playAll: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackgroundSound {
  id: string;
  name: string;
  description: string;
  category: string;
  storageKey: string;
  durationSeconds: number;
  sortOrder: number;
  contexts: SessionContext[];
}

export interface RenderStatus {
  status: 'none' | 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  errorMessage: string | null;
  jobId?: string;
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
}

