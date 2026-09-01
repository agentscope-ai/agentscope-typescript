/**
 * Build a WAV header for an open-ended stream of PCM audio.
 *
 * @param sampleRate PCM sample rate.
 * @param channels Number of audio channels.
 * @param bitsPerSample Bits in each PCM sample.
 * @returns A 44-byte streaming WAV header.
 */
export function _buildStreamingWavHeader(
    sampleRate = 24_000,
    channels = 1,
    bitsPerSample = 16
): Uint8Array {
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const encoder = new TextEncoder();
    const writeText = (offset: number, value: string): void => {
        header.set(encoder.encode(value), offset);
    };
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;

    writeText(0, 'RIFF');
    view.setUint32(4, 0xffffffff, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeText(36, 'data');
    view.setUint32(40, 0xffffffff, true);

    return header;
}

/**
 * Wrap raw PCM bytes in a self-contained WAV file.
 * @param pcm Raw PCM audio.
 * @param sampleRate PCM sample rate.
 * @param channels Number of audio channels.
 * @param bitsPerSample Bits in each PCM sample.
 * @returns A complete WAV byte sequence.
 */
export function _buildWav(
    pcm: Uint8Array,
    sampleRate = 24_000,
    channels = 1,
    bitsPerSample = 16
): Uint8Array {
    const result = new Uint8Array(44 + pcm.byteLength);
    const header = _buildStreamingWavHeader(sampleRate, channels, bitsPerSample);
    result.set(header);
    const view = new DataView(result.buffer);
    view.setUint32(4, 36 + pcm.byteLength, true);
    view.setUint32(40, pcm.byteLength, true);
    result.set(pcm, 44);
    return result;
}
