import 'dotenv/config';
import express from 'express';
import { YoutubeTranscript } from 'youtube-transcript';
import Groq, { toFile } from 'groq-sdk';
import ytDlp from 'yt-dlp-exec';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, createReadStream, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const aiCache = new Map(); // videoId → segments

// 서버 시작 시 yt-dlp 바이너리 미리 다운로드
ytDlp('--version').then(v => console.log(`yt-dlp: ${v.trim()}`)).catch(() => {});

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/transcript', async (req, res) => {
  const { videoId, lang } = req.query;
  if (!videoId) return res.status(400).json({ error: 'videoId가 필요합니다' });

  // 1) YouTube 자막 시도
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(
      videoId,
      lang ? { lang } : undefined,
    );
    if (transcript?.length) return res.json(transcript);
  } catch {}

  // 2) 특정 언어 요청 실패 → 빈 배열 반환 (프론트에서 재시도)
  if (lang) return res.json([]);

  // 3) lang 없음 + YouTube 자막 없음 → AI 전사
  if (!groq) {
    return res.status(503).json({
      error: 'YouTube 자막이 없습니다. .env에 GROQ_API_KEY를 입력하면 AI 전사가 활성화됩니다.',
    });
  }

  try {
    const segments = await transcribeWithAI(videoId);
    res.json(segments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 번역 엔드포인트 ──────────────────────────
app.post('/api/translate', async (req, res) => {
  const { texts, to } = req.body;
  if (!Array.isArray(texts) || !texts.length) return res.status(400).json({ error: 'texts 필요' });
  if (!groq) return res.status(503).json({ error: 'GROQ_API_KEY 없음' });

  try {
    const result = await batchTranslate(texts, to || 'en');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function batchTranslate(texts, to) {
  const CHUNK = 60;
  const targetName = to === 'en' ? 'English' : 'Korean';
  const out = [];

  for (let i = 0; i < texts.length; i += CHUNK) {
    const chunk = texts.slice(i, i + CHUNK);
    const numbered = chunk.map((t, j) => `${i + j + 1}. ${t}`).join('\n');

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `You are a subtitle translator. Translate each numbered line into natural, conversational ${targetName} suitable for video subtitles. Output ONLY the numbered translations in the exact same format: "N. translation". No notes or explanations.`,
        },
        { role: 'user', content: numbered },
      ],
    });

    const lines = res.choices[0].message.content
      .split('\n')
      .filter(l => /^\d+[.)]\s/.test(l.trim()))
      .map(l => l.replace(/^\d+[.)]\s*/, '').trim());

    // 개수가 모자라면 빈 문자열로 채움
    while (lines.length < chunk.length) lines.push('');
    out.push(...lines.slice(0, chunk.length));
  }

  return out;
}

// ── AI 전사 ─────────────────────────────────
async function transcribeWithAI(videoId) {
  if (aiCache.has(videoId)) return aiCache.get(videoId);

  const tempDir = mkdtempSync(join(tmpdir(), 'shadow-'));

  try {
    console.log(`[AI] 오디오 다운로드: ${videoId}`);

    await ytDlp(`https://www.youtube.com/watch?v=${videoId}`, {
      format: 'bestaudio[ext=webm]/bestaudio',
      output: join(tempDir, 'audio.%(ext)s'),
      noPlaylist: true,
    });

    const files = readdirSync(tempDir);
    if (!files.length) throw new Error('오디오 다운로드 실패');

    const audioPath = join(tempDir, files[0]);
    const ext = files[0].split('.').pop();
    const mimeMap = { webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
    const mimeType = mimeMap[ext] ?? 'audio/webm';

    console.log(`[AI] Groq 전사 시작: ${files[0]}`);

    const result = await groq.audio.transcriptions.create({
      file: await toFile(createReadStream(audioPath), `audio.${ext}`, { type: mimeType }),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    const segments = (result.segments ?? [])
      .map(s => ({ text: s.text.trim(), offset: s.start, duration: s.end - s.start }))
      .filter(s => s.text.length > 0);

    console.log(`[AI] 완료: ${segments.length}개 세그먼트`);
    aiCache.set(videoId, segments);
    return segments;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

app.listen(PORT, () => {
  console.log(`Shadow 앱 실행 중: http://localhost:${PORT}`);
  if (!groq) console.warn('⚠️  GROQ_API_KEY 없음 — AI 전사 비활성화');
});
