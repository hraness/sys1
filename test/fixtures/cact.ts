/**
 * Minimal valid `.cact` blob for admission tests: the real 120-byte
 * little-endian geometry header (tag, tensor count, codebook length), a
 * zero codebook, and one 44-byte directory record — exactly what
 * `inspectCactFile` structurally requires. No weights.
 */
export function buildCactBlob(options: { tensors?: number; codebookLen?: number } = {}): Buffer {
  const tensors = options.tensors ?? 1;
  const codebookLen = options.codebookLen ?? 28;
  const size = 120 + codebookLen * 4 + tensors * 44;
  const blob = Buffer.alloc(size);
  blob.writeUInt32LE(0x05e12a84, 0);
  blob.writeUInt32LE(tensors, 4);
  blob.writeUInt32LE(codebookLen, 8);
  return blob;
}
