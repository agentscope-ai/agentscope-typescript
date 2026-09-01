/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

import { _buildStreamingWavHeader, _buildWav } from '../_utils/audio';
import { Base64Source, DataBlock } from '../message';
import { TTSResponse } from './base';

export const TTS_SAMPLE_RATE = 24_000;
export const TTS_CHANNELS = 1;
export const TTS_BITS_PER_SAMPLE = 16;
export const TTS_WAV_MEDIA_TYPE = 'audio/wav';

/** Build an audio response from raw bytes. */
export function audioResponse(audio: Uint8Array, mediaType: string, isLast = true): TTSResponse {
    return new TTSResponse({
        content: DataBlock({
            source: Base64Source({
                data: Buffer.from(audio).toString('base64'),
                media_type: mediaType,
            }),
        }),
        isLast,
    });
}

/** Wrap PCM in a complete WAV response. */
export function pcmWavResponse(pcm: Uint8Array): TTSResponse {
    return audioResponse(
        _buildWav(pcm, TTS_SAMPLE_RATE, TTS_CHANNELS, TTS_BITS_PER_SAMPLE),
        TTS_WAV_MEDIA_TYPE
    );
}

/** Prefix the first PCM stream delta with an open-ended WAV header. */
export function streamingWavDelta(pcm: Uint8Array, first: boolean): Uint8Array {
    if (!first) return pcm;
    return Buffer.concat([
        Buffer.from(_buildStreamingWavHeader(TTS_SAMPLE_RATE, TTS_CHANNELS, TTS_BITS_PER_SAMPLE)),
        Buffer.from(pcm),
    ]);
}

/** Concatenate byte chunks without relying on browser-specific Blob APIs. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}
