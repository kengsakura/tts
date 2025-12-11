import { useEffect, useMemo, useState, useCallback } from 'react'
import './App.css'

type Gender = 'male' | 'female' | 'neutral' | 'unspecified'

type Toast = {
  id: string
  message: string
  type: 'info' | 'error' | 'success'
}

type Progress = {
  current: number
  total: number
}

type VoiceItem = {
  id: string
  label: string
  gender: Gender
  description?: string
}

type HistoryEntry = {
  id: string
  fileName: string
  blobUrl: string
  createdAt: number
  prompt?: string
  text?: string
  format: 'wav' | 'mp3'
  audioBase64: string
  voiceId?: string
  voiceLabel?: string
}

type Provider = 'gemini'

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'gemini', label: 'Google Gemini API (Free Tier)' },
]

const MODELS_BY_PROVIDER: Record<Provider, { id: string; label: string }[]> = {
  gemini: [
    { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Experimental)' },
    { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash Preview TTS' },
    { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro Preview TTS' },
  ],
}

const DEFAULT_MAX_CHARS = 1000
const API_KEY_STORAGE = 'gemini-api-key'
const PROMPT_PRESETS_KEY = 'tts-prompt-presets'
const DEFAULT_PRESETS = [
  'Read at steady moderate pace with clear pronunciation',
  'Speak slowly and clearly with consistent speed',
  'Read at natural conversational pace with good enunciation',
  'Narrate at even tempo with precise articulation',
  'Speak cheerfully at steady pace',
  'Explain calmly with consistent speed',
  'Use [short pause] for clarity and [laughing] for amusement',
  'Narrate with a [sigh] of relief',
]
const HISTORY_KEY = 'tts-history-v1'
const HISTORY_PAGE_SIZE = 10
const MAX_HISTORY_PAGES = 3

function normalisePrompt(prompt: string) {
  const trimmed = prompt.trim()
  if (!trimmed) return ''
  return trimmed.endsWith(':') ? trimmed.slice(0, -1) : trimmed
}

function base64ToBlobUrl(base64: string | undefined | null, mime = 'audio/wav'): string {
  if (!base64) return ''
  try {
    const binary = atob(base64)
    const len = binary.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mime })
    return URL.createObjectURL(blob)
  } catch (err) {
    console.error('Failed to decode audio base64', err)
    return ''
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1] || ''
      resolve(base64)
    }
    reader.onerror = (err) => reject(err)
    reader.readAsDataURL(blob)
  })
}



function persistHistory(entries: HistoryEntry[]): HistoryEntry[] {
  const serializable = entries.map((item) => ({
    id: item.id,
    fileName: item.fileName,
    audioBase64: item.audioBase64,
    createdAt: item.createdAt,
    prompt: item.prompt,
    text: item.text,
    format: item.format,
    voiceId: item.voiceId,
    voiceLabel: item.voiceLabel,
  }))

  let trimmed = [...serializable]
  while (trimmed.length > 0) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed))
      return trimmed.map((item) => {
        const url = base64ToBlobUrl(item.audioBase64)
        return {
          id: item.id,
          fileName: item.fileName,
          audioBase64: item.audioBase64,
          createdAt: item.createdAt,
          prompt: item.prompt,
          text: item.text,
          format: item.format,
          voiceId: item.voiceId,
          voiceLabel: item.voiceLabel,
          blobUrl: url,
        }
      })
    } catch (err: any) {
      const quotaExceeded = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)
      if (!quotaExceeded) {
        console.error('Failed to persist history', err)
        break
      }
      // drop the oldest item and retry
      trimmed.shift()
    }
  }

  console.warn('History storage is full; new entries will not be persisted.')
  return entries
}

function App() {
  const prefs = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem('tts-prefs-v1') || '{}')
    } catch {
      return {}
    }
  }, [])

  const [text, setText] = useState('')
  const [prompt, setPrompt] = useState<string>(() => prefs.prompt ?? '')
  const [genderFilter, setGenderFilter] = useState<Gender | 'all'>(() => prefs.lastGender ?? 'all')
  const [voices, setVoices] = useState<VoiceItem[]>([])
  const [voice, setVoice] = useState<string>(() => prefs.lastVoiceId ?? '')
  const [format, setFormat] = useState<'wav' | 'mp3'>(() => prefs.lastFormat ?? 'wav')
  // Force provider to be 'gemini' to avoid crash with old localStorage data
  const [provider] = useState<Provider>('gemini')
  const [model, setModel] = useState<string>(() => {
    const saved = prefs.model
    // Validate if saved model exists in current provider
    const exists = MODELS_BY_PROVIDER['gemini'].find(m => m.id === saved)
    return exists ? saved : MODELS_BY_PROVIDER['gemini'][0].id
  })
  const [maxChars, setMaxChars] = useState<number>(() => prefs.maxChars ?? DEFAULT_MAX_CHARS)
  const [mergeAudio, setMergeAudio] = useState<boolean>(() => prefs.mergeAudio ?? true)
  const [validateRepetition, setValidateRepetition] = useState<boolean>(() => prefs.validateRepetition ?? true)
  const [repetitionThreshold, setRepetitionThreshold] = useState<number>(() => prefs.repetitionThreshold ?? 0.3)
  const [validationResult, setValidationResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyPage, setHistoryPage] = useState<number>(1)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => prefs.theme ?? 'dark')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [speedControl, setSpeedControl] = useState<'auto' | 'slow' | 'moderate' | 'fast'>(() => prefs.speedControl ?? 'moderate')
  const [presets, setPresets] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(PROMPT_PRESETS_KEY) || '[]')
      if (Array.isArray(stored) && stored.length) {
        return stored.filter((p) => typeof p === 'string' && p.trim().length).map((p) => p.trim())
      }
    } catch {
      // ignore
    }
    return DEFAULT_PRESETS
  })
  const [previewOpen, setPreviewOpen] = useState(false)
  const [historyPreview, setHistoryPreview] = useState<HistoryEntry | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [apiKey, setApiKey] = useState<string>(() => {
    return import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem(API_KEY_STORAGE) || ''
  })
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)

  useEffect(() => {
    document.body.setAttribute('data-theme', theme)
  }, [theme])

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 5000)
  }, [])

  const closeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  function savePrefs(updates: Record<string, unknown>) {
    const current = JSON.parse(localStorage.getItem('tts-prefs-v1') || '{}')
    const merged = { ...current, ...updates }
    localStorage.setItem('tts-prefs-v1', JSON.stringify(merged))
  }

  function savePresets(list: string[]) {
    setPresets(list)
    localStorage.setItem(PROMPT_PRESETS_KEY, JSON.stringify(list))
  }

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    savePrefs({ theme: newTheme })
  }

  useEffect(() => {
    // Use hardcoded voice list (no backend needed)
    const VOICE_LIST: VoiceItem[] = [
      { id: 'zephyr', label: 'Zephyr', gender: 'female', description: 'Bright' },
      { id: 'puck', label: 'Puck', gender: 'male', description: 'Upbeat' },
      { id: 'charon', label: 'Charon', gender: 'male', description: 'ให้ข้อมูล' },
      { id: 'kore', label: 'Kore', gender: 'female', description: 'Firm' },
      { id: 'fenrir', label: 'Fenrir', gender: 'male', description: 'ตื่นเต้นง่าย' },
      { id: 'leda', label: 'Leda', gender: 'female', description: 'วัยรุ่น' },
      { id: 'orus', label: 'Orus', gender: 'male', description: 'Firm' },
      { id: 'aoede', label: 'Aoede', gender: 'female', description: 'Breezy' },
      { id: 'callirrhoe', label: 'Callirrhoe', gender: 'female', description: 'สบายๆ' },
      { id: 'autonoe', label: 'Autonoe', gender: 'male', description: 'Bright' },
      { id: 'enceladus', label: 'Enceladus', gender: 'male', description: 'Breathy' },
      { id: 'iapetus', label: 'Iapetus', gender: 'male', description: 'Clear' },
      { id: 'umbriel', label: 'Umbriel', gender: 'male', description: 'สบายๆ' },
      { id: 'algieba', label: 'Algieba', gender: 'female', description: 'Smooth' },
      { id: 'despina', label: 'Despina', gender: 'female', description: 'Smooth' },
      { id: 'erinome', label: 'Erinome', gender: 'female', description: 'ล้าง' },
      { id: 'algenib', label: 'Algenib', gender: 'female', description: 'แหบเล็กน้อย' },
      { id: 'rasalgethi', label: 'Rasalgethi', gender: 'male', description: 'ให้ข้อมูล' },
      { id: 'laomedeia', label: 'Laomedeia', gender: 'female', description: 'สนุกสนาน' },
      { id: 'achernar', label: 'Achernar', gender: 'male', description: 'Soft' },
      { id: 'alnilam', label: 'Alnilam', gender: 'male', description: 'Firm' },
      { id: 'schedar', label: 'Schedar', gender: 'male', description: 'Even' },
      { id: 'gacrux', label: 'Gacrux', gender: 'male', description: 'ผู้ใหญ่' },
      { id: 'pulcherrima', label: 'Pulcherrima', gender: 'female', description: 'มั่นใจ' },
      { id: 'achird', label: 'Achird', gender: 'male', description: 'เป็นมิตร' },
      { id: 'zubenelgenubi', label: 'Zubenelgenubi', gender: 'male', description: 'สบายๆ' },
      { id: 'vindemiatrix', label: 'Vindemiatrix', gender: 'female', description: 'อ่อนโยน' },
      { id: 'sadachbia', label: 'Sadachbia', gender: 'male', description: 'มีชีวิตชีวา' },
      { id: 'sadaltager', label: 'Sadaltager', gender: 'male', description: 'มีความรู้' },
      { id: 'sulafat', label: 'Sulafat', gender: 'female', description: 'Warm' },
    ]
    setVoices(VOICE_LIST)
  }, [])

  const filteredVoices = useMemo(() => {
    return voices.filter((v) => (genderFilter === 'all' ? true : v.gender === genderFilter))
  }, [voices, genderFilter])

  useEffect(() => {
    if (!filteredVoices.find((v) => v.id === voice)) {
      setVoice(filteredVoices[0]?.id || '')
    }
  }, [filteredVoices, voice])

  useEffect(() => {
    let parsed: any[] = []
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      if (raw) {
        const items = JSON.parse(raw)
        if (Array.isArray(items)) parsed = items
      }
    } catch {
      parsed = []
    }
    const hydrated: HistoryEntry[] = parsed
      .filter((item) => typeof item?.audioBase64 === 'string' && item.audioBase64.length > 0)
      .map((item) => {
        const base64 = item.audioBase64 as string
        const url = base64ToBlobUrl(base64)
        return {
          id: item.id,
          fileName: item.fileName,
          blobUrl: url,
          createdAt: item.createdAt,
          prompt: item.prompt,
          text: item.text,
          format: (item.format as 'wav' | 'mp3') ?? 'wav',
          audioBase64: base64,
          voiceId: item.voiceId,
          voiceLabel: item.voiceLabel,
        }
      })
    setHistory(hydrated)
  }, [])

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE))
    if (historyPage > totalPages) {
      setHistoryPage(totalPages)
    }
  }, [history, historyPage])

  const baseChars = text.length

  // Build speed instruction
  const speedInstructions: Record<typeof speedControl, string> = {
    auto: '',
    slow: 'Speak slowly with consistent pace and clear enunciation.',
    moderate: 'Read at steady moderate pace with even tempo and clear pronunciation.',
    fast: 'Speak at brisk but clear pace with consistent speed.'
  }
  const speedInstruction = speedInstructions[speedControl]

  const command = normalisePrompt(prompt)
  const parts = [speedInstruction, command].filter(Boolean)
  const finalPrompt = parts.join(' ')
  const combined = finalPrompt ? `${finalPrompt}: ${text}` : text
  const combinedChars = combined.trim().length
  const overLimit = baseChars > maxChars
  const showPreviewButton = combinedChars > 160
  const estimatedChunks = Math.ceil(combinedChars / maxChars)
  const isVeryLong = estimatedChunks > 3 && mergeAudio

  const sortedHistory = useMemo(() => {
    return [...history].sort((a, b) => b.createdAt - a.createdAt)
  }, [history])
  const totalPages = Math.max(1, Math.ceil(sortedHistory.length / HISTORY_PAGE_SIZE))
  const clampedTotalPages = Math.min(totalPages, MAX_HISTORY_PAGES)
  const currentPage = Math.min(historyPage, clampedTotalPages)
  const startIndex = (currentPage - 1) * HISTORY_PAGE_SIZE
  const displayedHistory = sortedHistory.slice(startIndex, startIndex + HISTORY_PAGE_SIZE)

  async function callGeminiTTS(text: string, voiceId: string, modelId: string): Promise<ArrayBuffer> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`

    const config: any = {
      responseModalities: ['AUDIO']
    }

    if (voiceId) {
      config.speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceId.charAt(0).toUpperCase() + voiceId.slice(1)
          }
        }
      }
    }

    const payload = {
      contents: [
        {
          parts: [{ text }]
        }
      ],
      generationConfig: config
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Gemini API Error: ${errorText}`)
    }

    const data = await response.json()

    // Extract audio data
    if (data.candidates && data.candidates.length > 0) {
      for (const part of data.candidates[0].content?.parts || []) {
        if (part.inlineData && part.inlineData.data) {
          // Decode base64 PCM data
          const binary = atob(part.inlineData.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          return bytes.buffer
        }
      }
    }

    throw new Error('No audio content in Gemini response')
  }

  function pcmToWav(pcmData: ArrayBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Blob {
    const dataSize = pcmData.byteLength
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i))
      }
    }

    writeString(0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeString(8, 'WAVE')
    writeString(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true)
    view.setUint16(32, channels * (bitsPerSample / 8), true)
    view.setUint16(34, bitsPerSample, true)
    writeString(36, 'data')
    view.setUint32(40, dataSize, true)

    const pcmArray = new Uint8Array(pcmData)
    const wavArray = new Uint8Array(buffer)
    wavArray.set(pcmArray, 44)

    return new Blob([buffer], { type: 'audio/wav' })
  }

  function splitTextIntoChunks(text: string, maxChars: number): string[] {
    if (!text || text.length <= maxChars) {
      return text ? [text] : []
    }

    const chunks: string[] = []
    let remaining = text.trim()

    while (remaining) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining)
        break
      }

      const window = remaining.slice(0, maxChars)
      let cutIndex = -1

      for (const boundary of ['. ', '! ', '? ', '\n', '\r']) {
        const idx = window.lastIndexOf(boundary)
        if (idx > cutIndex) {
          cutIndex = idx + boundary.length
        }
      }

      if (cutIndex === -1) {
        cutIndex = window.lastIndexOf(' ')
        if (cutIndex === -1) {
          cutIndex = maxChars
        }
      }

      const chunk = remaining.slice(0, cutIndex).trim()
      if (chunk) {
        chunks.push(chunk)
      }
      remaining = remaining.slice(cutIndex).trim()
    }

    return chunks
  }

  async function handleSynthesize() {
    if (!text.trim()) {
      showToast('กรุณากรอกข้อความ', 'error')
      return
    }

    if (!apiKey.trim()) {
      showToast('กรุณากรอก Gemini API Key', 'error')
      setShowApiKeyInput(true)
      return
    }

    const finalText = combined.trim()
    if (!finalText) {
      showToast('ข้อความที่ส่งว่างเปล่า', 'error')
      return
    }

    setBusy(true)
    setAudioUrl(null)
    setValidationResult(null)

    try {
      console.log('🚀 Direct Gemini API call')

      // Split text into chunks
      const chunks = splitTextIntoChunks(finalText, maxChars)
      console.log(`📝 Processing ${chunks.length} chunks`)

      if (chunks.length > 1) {
        setProgress({ current: 0, total: chunks.length })
      }

      // Process each chunk
      const audioBuffers: ArrayBuffer[] = []
      for (let i = 0; i < chunks.length; i++) {
        console.log(`⏳ Processing chunk ${i + 1}/${chunks.length}`)
        setProgress({ current: i + 1, total: chunks.length })

        let pcmData: ArrayBuffer
        pcmData = await callGeminiTTS(chunks[i], voice, model)
        audioBuffers.push(pcmData)

        console.log(`✅ Chunk ${i + 1} done`)
      }

      // Merge all audio buffers
      let finalBlob: Blob
      if (audioBuffers.length === 1) {
        finalBlob = pcmToWav(audioBuffers[0])
      } else if (mergeAudio) {
        // Merge all PCM data
        const totalSize = audioBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
        const merged = new Uint8Array(totalSize)
        let offset = 0
        for (const buf of audioBuffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
        finalBlob = pcmToWav(merged.buffer)
      } else {
        // Download separate files
        for (let i = 0; i < audioBuffers.length; i++) {
          const blob = pcmToWav(audioBuffers[i])
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `tts-part-${i + 1}.wav`
          a.click()
          URL.revokeObjectURL(url)
        }
        showToast(`ดาวน์โหลด ${audioBuffers.length} ไฟล์สำเร็จ!`, 'success')
        savePrefs({ lastVoiceId: voice, lastGender: genderFilter, model, prompt, speedControl, maxChars, mergeAudio, validateRepetition, repetitionThreshold })
        return
      }

      // Single merged file
      const url = URL.createObjectURL(finalBlob)
      setAudioUrl(url)

      // Optional: Validate for repetition using ASR
      if (validateRepetition) {
        try {
          console.log('🔍 Validating audio for repetition...')
          const audioBase64 = await blobToBase64(finalBlob)

          const validationResponse = await fetch('http://localhost:8787/api/validate-audio', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audioBase64: audioBase64,
              threshold: repetitionThreshold
            })
          })

          if (validationResponse.ok) {
            const validation = await validationResponse.json()
            console.log('🔍 ASR Validation Result:', validation)
            setValidationResult(validation)

            if (validation.hasRepetition) {
              showToast(
                `⚠️ ตรวจพบการพูดซ้ำ! (คะแนน: ${(validation.repetitionScore * 100).toFixed(0)}%)`,
                'error'
              )
              console.warn('Repeated phrases:', validation.repeatedPhrases)
            } else {
              showToast('✅ ไม่พบการพูดซ้ำ', 'success')
            }
          } else {
            console.warn('Validation failed:', await validationResponse.text())
          }
        } catch (validateErr) {
          console.error('ASR validation error:', validateErr)
        }
      }

      const fileName = `tts-${new Date().toISOString()}.wav`
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()

      showToast('ดาวน์โหลดไฟล์สำเร็จ!', 'success')
      savePrefs({
        lastVoiceId: voice,
        lastGender: genderFilter,
        model,
        prompt,
        speedControl,
        maxChars,
        mergeAudio,
        validateRepetition,
        repetitionThreshold
      })

    } catch (err: any) {
      console.error('❌ TTS failed:', err)
      let msg = err.message || String(err)
      
      // Friendly error for Cloud TTS auth issues
      if (msg.includes('API keys are not supported')) {
        msg = "Cloud TTS (Gemini Models) ต้องใช้ OAuth Token (ใช้ API Key ไม่ได้) กรุณากดปุ่มล็อกอิน Google"
      } else if (msg.includes('aiplatform.endpoints.predict')) {
        msg = "สิทธิ์ไม่เพียงพอ: กรุณาเปิดใช้งาน 'Vertex AI API' ใน Google Cloud Console ของคุณก่อน"
      } else if (msg.includes('UNAUTHENTICATED')) {
        msg = "Token หมดอายุหรือใช้ไม่ได้ กรุณากดล็อกอิน Google ใหม่อีกครั้ง"
      }
      
      showToast(msg, 'error')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  function handleAddPreset() {
    const normalized = normalisePrompt(prompt)
    if (!normalized) {
      showToast('กรุณากรอกคำสั่งก่อนบันทึก', 'error')
      return
    }
    if (presets.includes(normalized)) {
      showToast('พรีเซตนี้มีอยู่แล้ว', 'error')
      return
    }
    if (presets.length >= 20) {
      showToast('จำกัดพรีเซต 20 รายการ กรุณาลบรายการที่ไม่ใช้', 'error')
      return
    }
    const updated = [...presets, normalized]
    savePresets(updated)
    showToast('บันทึกพรีเซตสำเร็จ', 'success')
  }

  function handleDeletePreset(value: string) {
    const updated = presets.filter((p) => p !== value)
    savePresets(updated.length ? updated : DEFAULT_PRESETS)
  }

  function handleApplyPreset(value: string) {
    setPrompt(value)
    savePrefs({ prompt: value })
  }

  function removeHistoryEntry(entry: HistoryEntry) {
    URL.revokeObjectURL(entry.blobUrl)
    const remaining = history.filter((i) => i.id !== entry.id)
    const persisted = persistHistory(remaining)
    setHistory(persisted)
  }

  function clearAllHistory() {
    if (!confirm('ต้องการลบประวัติทั้งหมดหรือไม่?')) return
    history.forEach(entry => URL.revokeObjectURL(entry.blobUrl))
    localStorage.removeItem(HISTORY_KEY)
    setHistory([])
    showToast('ลบประวัติทั้งหมดสำเร็จ', 'success')
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        if (!busy) handleSynthesize()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, text, voice])

  // Check for access token in URL hash after redirect
  useEffect(() => {
    const hash = window.location.hash
    if (hash && hash.includes('access_token')) {
        // Clear hash
        window.history.replaceState(null, '', window.location.pathname)
    }
  }, [])

  return (
    <>
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            <span className="toast-icon">
              {toast.type === 'error' ? '❌' : toast.type === 'success' ? '✅' : 'ℹ️'}
            </span>
            <span className="toast-content">{toast.message}</span>
            <button className="toast-close" onClick={() => closeToast(toast.id)}>×</button>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 24, height: '100vh', padding: 16, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 24 }}>🎙️ Gemini TTS (Direct API)</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowApiKeyInput(!showApiKeyInput)} style={{ padding: '8px 12px' }}>
              🔑 API Key
            </button>
            <button onClick={toggleTheme} style={{ padding: '8px 12px' }}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>

        {showApiKeyInput && (
          <div className="card">
            <label className="field">
              <span className="field-label">
                Gemini API Key
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  localStorage.setItem(API_KEY_STORAGE, e.target.value)
                }}
                placeholder="วาง API Key ที่นี่ (ขึ้นต้นด้วย AIza...)"
              />
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0 0' }}>
                API Key จะถูกเก็บไว้ใน LocalStorage และไม่ส่งไปที่ Server ใดๆ (เรียก Gemini โดยตรง)
              </p>
            </label>
          </div>
        )}

        <div className="card">
          <label className="field">
            <span className="field-label">คำสั่งควบคุมเสียง (Prompt)</span>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                savePrefs({ prompt: e.target.value })
              }}
              rows={2}
              placeholder="เช่น Say cheerfully"
            />
          </label>
          <div className="preset-toolbar">
            <select value="" onChange={(e) => { if (e.target.value) handleApplyPreset(e.target.value) }}>
              <option value="">เลือกพรีเซต</option>
              {presets.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <button onClick={handleAddPreset} className="btn-secondary">💾 บันทึกเป็นพรีเซต</button>
            {presets.includes(normalisePrompt(prompt)) && (
              <button onClick={() => handleDeletePreset(normalisePrompt(prompt))} className="btn-danger">🗑️ ลบพรีเซตนี้</button>
            )}
          </div>
          <div className="prompt-preview">
            <div className="prompt-preview-text">{combined || '—'}</div>
            {showPreviewButton && (
              <button className="btn-secondary" onClick={() => setPreviewOpen(true)}>ดูทั้งหมด</button>
            )}
          </div>
        </div>

        <label className="field" style={{ flex: 1 }}>
          <div className="field-label">ข้อความ (สูงสุด {maxChars} อักขระ/ส่วน)</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ flex: 1, minHeight: 320 }}
            placeholder="พิมพ์ข้อความที่นี่..."
          />
          <div className="meta-row">
            <span>อักขระข้อความ: {baseChars}</span>
            <span>รวมคำสั่ง: {combinedChars}{overLimit && <span className="warning"> ⚠️ เกิน {maxChars}</span>}</span>
          </div>
        </label>

        <div className="grid-controls">
          <label className="field">
            <span className="field-label">ผู้ให้บริการ (Provider)</span>
            <select value={provider} disabled>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">โมเดล</span>
            <select value={model} onChange={(e) => { setModel(e.target.value); savePrefs({ model: e.target.value }) }}>
              {MODELS_BY_PROVIDER[provider].map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">ความเร็วการพูด</span>
            <select value={speedControl} onChange={(e) => { setSpeedControl(e.target.value as any); savePrefs({ speedControl: e.target.value }) }}>
              <option value="slow">🐢 ช้า (แนะนำ)</option>
              <option value="moderate">🚶 ปานกลาง</option>
              <option value="fast">🏃 เร็ว</option>
              <option value="auto">⚡ อัตโนมัติ</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">เพศเสียง</span>
            <select value={genderFilter} onChange={(e) => { setGenderFilter(e.target.value as any); savePrefs({ lastGender: e.target.value }) }}>
              <option value="all">ทั้งหมด</option>
              <option value="female">หญิง</option>
              <option value="male">ชาย</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">เสียง</span>
            <select value={voice} onChange={(e) => { setVoice(e.target.value); savePrefs({ lastVoiceId: e.target.value }) }}>
              <option value="">(เลือกเสียง)</option>
              {filteredVoices.map((v) => (
                <option key={v.id} value={v.id}>{v.label} - {v.description}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">รูปแบบไฟล์</span>
            <select value={format} onChange={(e) => { setFormat(e.target.value as any); savePrefs({ lastFormat: e.target.value }) }}>
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
            </select>
          </label>
        </div>

        <button onClick={() => setShowAdvanced(!showAdvanced)} className="btn-secondary" style={{ alignSelf: 'flex-start' }}>
          ⚙️ {showAdvanced ? 'ซ่อน' : 'แสดง'}ตัวควบคุมขั้นสูง
        </button>

        {showAdvanced && (
          <div className="card">
            <label className="field">
              <span className="field-label">ลิมิตอักขระต่อส่วน (Chunk Size)</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  min="100"
                  max="10000"
                  step="100"
                  value={maxChars}
                  onChange={(e) => {
                    const val = Math.max(100, Math.min(10000, parseInt(e.target.value) || DEFAULT_MAX_CHARS))
                    setMaxChars(val)
                    savePrefs({ maxChars: val })
                  }}
                  style={{ width: 120 }}
                />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>อักขระ (100-10000)</span>
              </div>
            </label>
            <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={mergeAudio}
                onChange={(e) => {
                  setMergeAudio(e.target.checked)
                  savePrefs({ mergeAudio: e.target.checked })
                }}
              />
              <span className="field-label" style={{ margin: 0 }}>รวมเสียงเป็นไฟล์เดียว</span>
            </label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginLeft: 24 }}>
              {mergeAudio
                ? 'เมื่อข้อความยาวเกิน Chunk Size จะรวมเสียงทั้งหมดเป็นไฟล์เดียว'
                : 'เมื่อข้อความยาวเกิน Chunk Size จะแบ่งเป็นไฟล์ ZIP และดาวน์โหลดอัตโนมัติ'
              }
            </div>

            <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 12 }}>
              <input
                type="checkbox"
                checked={validateRepetition}
                onChange={(e) => {
                  setValidateRepetition(e.target.checked)
                  savePrefs({ validateRepetition: e.target.checked })
                }}
              />
              <span className="field-label" style={{ margin: 0 }}>ตรวจสอบการพูดซ้ำ (ASR)</span>
            </label>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginLeft: 24 }}>
              หลังสร้างเสียงจะใช้ Typhoon ASR ตรวจสอบว่า AI อ่านซ้ำหรือไม่ (ต้องตั้งค่า TYPHOON_API_KEY ใน backend)
            </div>

            {validateRepetition && (
              <div className="field" style={{ marginTop: 12, marginLeft: 24 }}>
                <label style={{ display: 'block', marginBottom: 4 }}>
                  <span className="field-label">Threshold: {(repetitionThreshold * 100).toFixed(0)}%</span>
                </label>
                <input
                  type="range"
                  min="10"
                  max="70"
                  step="5"
                  value={repetitionThreshold * 100}
                  onChange={(e) => {
                    const newThreshold = parseInt(e.target.value) / 100
                    setRepetitionThreshold(newThreshold)
                    savePrefs({ repetitionThreshold: newThreshold })
                  }}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  ต่ำ (10-20%) = เข้มงวด | กลาง (30-40%) = แนะนำ | สูง (50-70%) = ผ่อนปราน
                </div>
              </div>
            )}

            <div className="field">
              <span className="field-label">การปรับโทนเสียง (ใช้ prompt)</span>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                API รุ่นปัจจุบันยังไม่รองรับการตั้งค่า speakingRate/pitch/volume โดยตรง กรุณาพิมพ์คำสั่งในช่อง prompt เช่น
                <code> Speak slowly </code> หรือ <code> Speak with higher pitch </code>
              </p>
            </div>
          </div>
        )}

        {isVeryLong && (
          <div className="card" style={{ backgroundColor: 'var(--warning-bg)', border: '1px solid var(--warning)', padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span>⚠️</span>
              <div style={{ fontSize: 13 }}>
                <strong>ข้อความยาวมาก ({estimatedChunks} ส่วน)</strong>
                <p style={{ margin: '4px 0 0 0' }}>
                  การรวมไฟล์อาจใช้เวลานานมาก (5-15 นาที) แนะนำให้ปิดการ "รวมเสียงเป็นไฟล์เดียว" เพื่อประมวลผลเร็วขึ้น
                </p>
              </div>
            </div>
          </div>
        )}

        <button onClick={handleSynthesize} disabled={busy} className="btn-primary">
          {busy ? (
            progress ? `⏳ กำลังประมวลผล... (${progress.current}/${progress.total})` : '⏳ กำลังสร้างเสียง...'
          ) : (
            '🎵 สร้างเสียง'
          )}
        </button>

        {audioUrl && (
          <div className="card">
            <div className="card-title">🎵 เสียงที่สร้าง</div>
            <audio src={audioUrl} controls style={{ width: '100%', marginBottom: 8 }} />
            <a href={audioUrl} download={`tts-${new Date().toISOString()}.${format}`} className="btn-link">
              💾 ดาวน์โหลดไฟล์
            </a>
          </div>
        )}

        {validationResult && (
          <div className={`card ${validationResult.hasRepetition ? 'error-card' : 'success-card'}`}
               style={{
                 backgroundColor: validationResult.hasRepetition ? 'var(--warning-bg)' : 'var(--success-bg)',
                 border: `1px solid ${validationResult.hasRepetition ? 'var(--warning)' : 'var(--success)'}`,
                 padding: 12
               }}>
            <div className="card-title" style={{ marginBottom: 8 }}>
              {validationResult.hasRepetition ? '⚠️ ผลการตรวจสอบการพูดซ้ำ' : '✅ ผลการตรวจสอบ'}
            </div>
            <div style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>สถานะ:</strong> {validationResult.hasRepetition ? 'พบการพูดซ้ำ' : 'ไม่พบการพูดซ้ำ'}
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>คะแนน:</strong> {(validationResult.repetitionScore * 100).toFixed(1)}%
              </div>
              {validationResult.transcribedText && (
                <div style={{ marginBottom: 8 }}>
                  <strong>ข้อความที่ถอดเสียง:</strong>
                  <div style={{
                    backgroundColor: 'var(--bg)',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    marginTop: 4,
                    maxHeight: 100,
                    overflow: 'auto'
                  }}>
                    {validationResult.transcribedText}
                  </div>
                </div>
              )}
              {validationResult.hasRepetition && validationResult.repeatedPhrases && validationResult.repeatedPhrases.length > 0 && (
                <div>
                  <strong>วลีที่ซ้ำ:</strong>
                  <ul style={{ margin: '4px 0', paddingLeft: 20, fontSize: 12 }}>
                    {validationResult.repeatedPhrases.map((phrase: string, idx: number) => (
                      <li key={idx}>{phrase}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="history-column">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 className="history-title" style={{ margin: 0 }}>📜 ประวัติ</h2>
          {history.length > 0 && (
            <button onClick={clearAllHistory} className="btn-danger" style={{ fontSize: 12, padding: '4px 8px' }}>
              🗑️ ลบทั้งหมด
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="history-empty">ยังไม่มีประวัติ</div>
        ) : (
          <div className="history-list">
            {displayedHistory.map((entry) => (
              <div key={entry.id} className="history-item">
                <div className="history-meta">{new Date(entry.createdAt).toLocaleString('th-TH')}</div>
                {entry.prompt && (
                  <div className="history-line truncate"><strong>Prompt:</strong> {entry.prompt}</div>
                )}
                {entry.text && (
                  <div className="history-line truncate"><strong>ข้อความ:</strong> {entry.text}</div>
                )}
                {entry.voiceLabel && (
                  <div style={{ fontSize: 13 }}><strong>เสียง:</strong> {entry.voiceLabel}</div>
                )}
                <audio src={entry.blobUrl} controls style={{ width: '100%', height: 32, marginBottom: 6 }} />
                <div className="history-actions">
                  <a href={entry.blobUrl} download={entry.fileName} className="btn-link">💾</a>
                  <button className="btn-secondary" onClick={() => setHistoryPreview(entry)}>🔍</button>
                  <button
                    onClick={() => removeHistoryEntry(entry)}
                    className="btn-danger"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            {sortedHistory.length > HISTORY_PAGE_SIZE && (
              <div className="history-pagination">
                <button className="btn-secondary" onClick={() => setHistoryPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>ก่อนหน้า</button>
                <span>หน้า {currentPage} / {clampedTotalPages}</span>
                <button className="btn-secondary" onClick={() => setHistoryPage((p) => Math.min(clampedTotalPages, p + 1))} disabled={currentPage === clampedTotalPages}>ถัดไป</button>
              </div>
            )}
          </div>
        )}
      </div>

      {previewOpen && (
        <div className="modal-backdrop" onClick={() => setPreviewOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>ข้อความที่จะส่ง</h3>
            <textarea readOnly value={combined} rows={10} style={{ width: '100%', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn-secondary" onClick={() => setPreviewOpen(false)}>ปิด</button>
            </div>
          </div>
        </div>
      )}

      {historyPreview && (
        <div className="modal-backdrop" onClick={() => setHistoryPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>รายละเอียดประวัติ</h3>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{new Date(historyPreview.createdAt).toLocaleString('th-TH')}</div>
            {historyPreview.prompt && (
              <label className="field">
                <span className="field-label">Prompt</span>
                <textarea readOnly rows={3} value={historyPreview.prompt} />
              </label>
            )}
            {historyPreview.text && (
              <label className="field">
                <span className="field-label">ข้อความ</span>
                <textarea readOnly rows={6} value={historyPreview.text} />
              </label>
            )}
            {historyPreview.voiceLabel && (
              <div style={{ fontSize: 13 }}><strong>เสียง:</strong> {historyPreview.voiceLabel}</div>
            )}
            <audio src={historyPreview.blobUrl} controls style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <a href={historyPreview.blobUrl} download={historyPreview.fileName} className="btn-link">💾 ดาวน์โหลด</a>
              <button className="btn-secondary" onClick={() => setHistoryPreview(null)}>ปิด</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  )
}

export default App
