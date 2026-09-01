import { _buildStreamingWavHeader } from './audio';

describe('_buildStreamingWavHeader', () => {
    test('matches the Python default 44-byte WAV header', () => {
        expect(Buffer.from(_buildStreamingWavHeader()).toString('hex')).toBe(
            '52494646ffffffff57415645666d74201000000001000100c05d000080bb00000200100064617461ffffffff'
        );
    });

    test('writes custom PCM parameters in little-endian form', () => {
        const header = _buildStreamingWavHeader(16_000, 2, 24);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

        expect(header).toHaveLength(44);
        expect(view.getUint16(22, true)).toBe(2);
        expect(view.getUint32(24, true)).toBe(16_000);
        expect(view.getUint32(28, true)).toBe(96_000);
        expect(view.getUint16(32, true)).toBe(6);
        expect(view.getUint16(34, true)).toBe(24);
    });
});
