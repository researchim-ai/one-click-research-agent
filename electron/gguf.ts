import fs from 'fs'

// ---------------------------------------------------------------------------
// GGUF metadata reader — parses the header of .gguf files to extract
// model architecture parameters (context length, layers, KV config, etc.)
// without loading the full model into memory.
//
// Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
// ---------------------------------------------------------------------------

const GGUF_MAGIC = 0x46554747 // "GGUF" in little-endian

enum GGUFValueType {
  UINT8   = 0,
  INT8    = 1,
  UINT16  = 2,
  INT16   = 3,
  UINT32  = 4,
  INT32   = 5,
  FLOAT32 = 6,
  BOOL    = 7,
  STRING  = 8,
  ARRAY   = 9,
  UINT64  = 10,
  INT64   = 11,
  FLOAT64 = 12,
}

export interface GGUFMetadata {
  [key: string]: string | number | boolean | (string | number | boolean)[]
}

export interface ModelArchInfo {
  architecture: string
  name: string
  contextLength: number
  blockCount: number
  embeddingLength: number
  headCount: number
  headCountKv: number
  headDimKv: number
  expertCount: number
  expertUsedCount: number
  kvLayers: number
  kvBytesPerLayerF16: number
  kvBytesPerLayerQ8: number
}

class BufferReader {
  private buf: Buffer
  private pos = 0
  private fd: number
  private fileSize: number
  private loaded: number

  constructor(fd: number, initialSize = 1024 * 1024) {
    this.fd = fd
    this.fileSize = fs.fstatSync(fd).size
    const readSize = Math.min(initialSize, this.fileSize)
    this.buf = Buffer.alloc(readSize)
    fs.readSync(fd, this.buf, 0, readSize, 0)
    this.loaded = readSize
  }

  private ensure(bytes: number) {
    if (this.pos + bytes <= this.loaded) return
    const needed = this.pos + bytes
    if (needed > this.fileSize) throw new Error('GGUF: unexpected end of file')
    const newSize = Math.min(Math.max(needed, this.loaded * 2), this.fileSize)
    const newBuf = Buffer.alloc(newSize)
    this.buf.copy(newBuf, 0, 0, this.loaded)
    const toRead = newSize - this.loaded
    fs.readSync(this.fd, newBuf, this.loaded, toRead, this.loaded)
    this.buf = newBuf
    this.loaded = newSize
  }

  u8(): number   { this.ensure(1); const v = this.buf.readUInt8(this.pos); this.pos += 1; return v }
  i8(): number   { this.ensure(1); const v = this.buf.readInt8(this.pos); this.pos += 1; return v }
  u16(): number  { this.ensure(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
  i16(): number  { this.ensure(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v }
  u32(): number  { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  i32(): number  { this.ensure(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v }
  f32(): number  { this.ensure(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v }
  f64(): number  { this.ensure(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v }

  u64(): number {
    this.ensure(8)
    const lo = this.buf.readUInt32LE(this.pos)
    const hi = this.buf.readUInt32LE(this.pos + 4)
    this.pos += 8
    return hi * 0x100000000 + lo
  }

  i64(): number {
    this.ensure(8)
    const lo = this.buf.readUInt32LE(this.pos)
    const hi = this.buf.readInt32LE(this.pos + 4)
    this.pos += 8
    return hi * 0x100000000 + lo
  }

  bool(): boolean { return this.u8() !== 0 }

  string(): string {
    const len = this.u64()
    if (len > 10_000_000) throw new Error('GGUF: string too long')
    this.ensure(len)
    const s = this.buf.toString('utf-8', this.pos, this.pos + len)
    this.pos += len
    return s
  }

  readValue(type: GGUFValueType): string | number | boolean {
    switch (type) {
      case GGUFValueType.UINT8:   return this.u8()
      case GGUFValueType.INT8:    return this.i8()
      case GGUFValueType.UINT16:  return this.u16()
      case GGUFValueType.INT16:   return this.i16()
      case GGUFValueType.UINT32:  return this.u32()
      case GGUFValueType.INT32:   return this.i32()
      case GGUFValueType.FLOAT32: return this.f32()
      case GGUFValueType.BOOL:    return this.bool()
      case GGUFValueType.STRING:  return this.string()
      case GGUFValueType.UINT64:  return this.u64()
      case GGUFValueType.INT64:   return this.i64()
      case GGUFValueType.FLOAT64: return this.f64()
      default: throw new Error(`GGUF: unknown value type ${type}`)
    }
  }

  readKV(): [string, string | number | boolean | (string | number | boolean)[]] {
    const key = this.string()
    const valType = this.u32() as GGUFValueType
    if (valType === GGUFValueType.ARRAY) {
      const elemType = this.u32() as GGUFValueType
      const count = this.u64()
      const arr: (string | number | boolean)[] = []
      for (let i = 0; i < count && i < 100000; i++) {
        arr.push(this.readValue(elemType))
      }
      return [key, arr]
    }
    return [key, this.readValue(valType)]
  }
}

export function readGGUFMetadata(filePath: string): GGUFMetadata {
  const fd = fs.openSync(filePath, 'r')
  try {
    const reader = new BufferReader(fd)
    const magic = reader.u32()
    if (magic !== GGUF_MAGIC) throw new Error('Not a GGUF file')
    const version = reader.u32()
    if (version < 2 || version > 3) throw new Error(`Unsupported GGUF version: ${version}`)

    const _tensorCount = reader.u64()
    const kvCount = reader.u64()

    const metadata: GGUFMetadata = {}
    for (let i = 0; i < kvCount; i++) {
      const [key, value] = reader.readKV()
      metadata[key] = value
    }
    return metadata
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Architecture detection — derives model architecture parameters from GGUF
// metadata, with special handling for known hybrid architectures.
// ---------------------------------------------------------------------------

// Registry of known architectures that have non-standard KV cache behavior.
// For standard transformers, ALL layers have KV cache. These overrides
// specify how many layers actually have attention (and thus KV cache).
interface ArchOverride {
  kvLayersFraction: number // fraction of block_count that has KV cache
  headDimKvOverride?: number
}

const KNOWN_ARCH_OVERRIDES: Record<string, ArchOverride> = {
  // Qwen3.5-35B-A3B: 40 layers, layout 10 × (3×DeltaNet + 1×Attention)
  // → 10 of 40 layers have attention KV cache, KV head_dim = 256
  'qwen3moe': { kvLayersFraction: 0.25, headDimKvOverride: 256 },
  // If the architecture is registered differently:
  'qwen3': { kvLayersFraction: 0.25, headDimKvOverride: 256 },
}

function getNum(meta: GGUFMetadata, ...keys: string[]): number {
  for (const k of keys) {
    if (typeof meta[k] === 'number') return meta[k] as number
  }
  return 0
}

function getStr(meta: GGUFMetadata, ...keys: string[]): string {
  for (const k of keys) {
    if (typeof meta[k] === 'string') return meta[k] as string
  }
  return ''
}

export function deriveArchInfo(meta: GGUFMetadata): ModelArchInfo {
  const arch = getStr(meta, 'general.architecture')
  const name = getStr(meta, 'general.name')

  const contextLength = getNum(meta, `${arch}.context_length`, 'llama.context_length') || 4096
  const blockCount = getNum(meta, `${arch}.block_count`, 'llama.block_count') || 1
  const embeddingLength = getNum(meta, `${arch}.embedding_length`, 'llama.embedding_length') || 4096
  const headCount = getNum(meta, `${arch}.attention.head_count`, 'llama.attention.head_count') || 32
  const headCountKv = getNum(meta, `${arch}.attention.head_count_kv`, 'llama.attention.head_count_kv') || headCount
  const expertCount = getNum(meta, `${arch}.expert_count`, 'llama.expert_count')
  const expertUsedCount = getNum(meta, `${arch}.expert_used_count`, 'llama.expert_used_count')

  // head dimension for KV: try explicit key_length, then derive from embedding/head_count
  let headDimKv = getNum(meta, `${arch}.attention.key_length`, `${arch}.attention.value_length`)
  if (!headDimKv) headDimKv = Math.floor(embeddingLength / headCount)

  // Check for known architecture overrides
  const override = KNOWN_ARCH_OVERRIDES[arch]
  let kvLayers = blockCount
  if (override) {
    kvLayers = Math.round(blockCount * override.kvLayersFraction)
    if (override.headDimKvOverride) headDimKv = override.headDimKvOverride
  }

  // KV bytes per attention layer per token:
  // K + V = 2 * headCountKv * headDimKv values
  const kvValuesPerLayer = 2 * headCountKv * headDimKv
  const kvBytesPerLayerF16 = kvValuesPerLayer * 2        // 2 bytes per f16
  const kvBytesPerLayerQ8 = Math.round(kvValuesPerLayer * 1.0625)  // q8_0

  return {
    architecture: arch,
    name,
    contextLength,
    blockCount,
    embeddingLength,
    headCount,
    headCountKv,
    headDimKv,
    expertCount,
    expertUsedCount,
    kvLayers,
    kvBytesPerLayerF16,
    kvBytesPerLayerQ8,
  }
}

// Conservative defaults for when no model file is available
export function defaultArchInfo(): ModelArchInfo {
  return {
    architecture: 'unknown',
    name: 'Qwen3.5-35B-A3B',
    contextLength: 262144,
    blockCount: 40,
    embeddingLength: 2048,
    headCount: 16,
    headCountKv: 2,
    headDimKv: 256,
    expertCount: 256,
    expertUsedCount: 9,
    kvLayers: 10,
    kvBytesPerLayerF16: 2048,
    kvBytesPerLayerQ8: 1088,
  }
}
