export type Gender = 'male' | 'female' | 'neutral' | 'unspecified'

export type HistoryItem = {
	id: string
	createdAt: number
	text: string
	voiceId: string
	gender?: Gender
	language?: string
	format: 'wav' | 'mp3'
	fileName: string
	blobUrl: string
	charCount: number
}

const DB_KEY = 'tts-history-v1'
const PREFS_KEY = 'tts-prefs-v1'
const MAX_ITEMS = 500

export type Prefs = {
	theme?: 'light' | 'dark'
	lastVoiceId?: string
	lastGender?: Gender | 'all'
	lastFormat?: 'wav' | 'mp3'
}

export function loadPrefs(): Prefs {
	try {
		const raw = localStorage.getItem(PREFS_KEY)
		return raw ? JSON.parse(raw) : {}
	} catch {
		return {}
	}
}

export function savePrefs(p: Prefs) {
	localStorage.setItem(PREFS_KEY, JSON.stringify(p))
}

export function loadHistory(): HistoryItem[] {
	try {
		const raw = localStorage.getItem(DB_KEY)
		return raw ? (JSON.parse(raw) as HistoryItem[]) : []
	} catch {
		return []
	}
}

export function saveHistory(items: HistoryItem[]) {
	const pruned = items.slice(-MAX_ITEMS)
	localStorage.setItem(DB_KEY, JSON.stringify(pruned))
}

export function addHistory(item: HistoryItem) {
	const items = loadHistory()
	items.push(item)
	saveHistory(items)
}

export function removeHistory(id: string) {
	const items = loadHistory().filter(i => i.id !== id)
	saveHistory(items)
}

export function exportHistory(): string {
	const items = loadHistory()
	return JSON.stringify({ version: 1, items }, null, 2)
}

export function importHistory(json: string) {
	const data = JSON.parse(json)
	if (Array.isArray(data.items)) {
		saveHistory(data.items as HistoryItem[])
	}
}
