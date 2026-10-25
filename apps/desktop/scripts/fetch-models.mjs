// Fetches the whiteboard's speech models into apps/desktop/models, so the
// packaged app ships them (electron-builder.yml, extraResources) and nobody
// has to download a voice or speech recognition after installing:
//
//   - Kokoro-82M, fp16 (the natural voice, main/voice.ts)       ~163 MB
//   - Whisper base.en, q8 (speech mode, main/listen.ts)         ~77 MB
//
// Files are pinned to a revision and checked against their size (and the
// sha256 Hugging Face publishes for the large ones), then laid out the way
// transformers.js expects a local model: models/<repo>/<file>. Files already
// there and correct are skipped, so running it again is quick. The folder is
// gitignored. In dev, the app uses it too when it's there; without it, the
// voice and speech mode offer their old one-time download instead.

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'models')

// Keep in step with VOICE_MODEL / VOICE_MODEL_FILE (src/main/voice-protocol.ts)
// and LISTEN_MODEL / LISTEN_MODEL_FILE (src/main/listen-protocol.ts).
const MODELS = [
  {
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    license: 'Apache-2.0 (hexgrad/Kokoro-82M)',
    files: [
      { path: 'config.json', size: 44 },
      { path: 'tokenizer.json', size: 3497 },
      { path: 'tokenizer_config.json', size: 113 },
      {
        path: 'onnx/model_fp16.onnx',
        size: 163234740,
        sha256: 'ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a'
      }
    ]
  },
  {
    repo: 'onnx-community/whisper-base.en',
    revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    license: 'Apache-2.0 (openai/whisper-base.en)',
    files: [
      { path: 'config.json', size: 2197 },
      { path: 'generation_config.json', size: 1556 },
      { path: 'preprocessor_config.json', size: 339 },
      { path: 'tokenizer.json', size: 2405679 },
      { path: 'tokenizer_config.json', size: 282662 },
      {
        path: 'onnx/encoder_model_quantized.onnx',
        size: 23201320,
        sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10'
      },
      {
        path: 'onnx/decoder_model_merged_quantized.onnx',
        size: 53692803,
        sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909'
      }
    ]
  }
]

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function isGood(file, spec) {
  if (!existsSync(file) || statSync(file).size !== spec.size) return false
  return !spec.sha256 || (await sha256(file)) === spec.sha256
}

async function fetchFile(model, spec) {
  const dest = join(outDir, ...model.repo.split('/'), ...spec.path.split('/'))
  if (await isGood(dest, spec)) return false
  mkdirSync(dirname(dest), { recursive: true })
  const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${spec.path}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const part = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  if (!(await isGood(part, spec))) {
    await rm(part, { force: true })
    throw new Error(`${model.repo}/${spec.path}: size or checksum doesn't match`)
  }
  renameSync(part, dest)
  return true
}

let fetched = 0
for (const model of MODELS) {
  for (const spec of model.files) {
    if (await fetchFile(model, spec)) {
      fetched++
      console.log(`fetched ${model.repo}/${spec.path} (${(spec.size / 1e6).toFixed(1)} MB)`)
    }
  }
}

writeFileSync(
  join(outDir, 'NOTICE.md'),
  [
    '# Bundled models',
    '',
    'Run locally by codeswim for the whiteboard; downloaded from Hugging Face at build time.',
    '',
    ...MODELS.map((m) => `- ${m.repo} @ ${m.revision.slice(0, 12)}: ${m.license}`),
    '',
    'Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0',
    ''
  ].join('\n')
)

console.log(fetched ? `models ready in ${outDir}` : 'models already up to date')
